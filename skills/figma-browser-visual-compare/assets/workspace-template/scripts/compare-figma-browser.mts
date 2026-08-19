import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { z } from "zod";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const clipSchema = z.object({
  height: z.number().positive(),
  width: z.number().positive(),
  x: z.number(),
  y: z.number(),
});

const stateSchema = z.object({
  browserClip: clipSchema,
  figmaMeasurements: z
    .array(
      z.object({
        name: z.string().min(1),
        nodeName: z.string().min(1),
      }),
    )
    .default([]),
  groupName: z.string().min(1).optional(),
  name: z.string().min(1),
  nodeId: z.string().min(1),
  scrollY: z.number().default(0),
  webMeasurements: z
    .array(
      z.object({
        name: z.string().min(1),
        selector: z.string().min(1),
      }),
    )
    .default([]),
  waitForSelector: z.string().default("[data-visual-compare-ready]"),
  waitForStateAttribute: z
    .object({
      selector: z.string(),
      attribute: z.string(),
      value: z.string(),
    })
    .optional(),
});

const configSchema = z.object({
  appUrl: z.string().url(),
  browser: z
    .object({
      executablePath: z.string().optional(),
      headless: z.boolean().default(true),
    })
    .default({ headless: true }),
  compare: z
    .object({
      compositeBackground: z.tuple([
        z.number().min(0).max(255),
        z.number().min(0).max(255),
        z.number().min(0).max(255),
      ]).default([255, 255, 255]),
      maxPixelDiffPercent: z.number().min(0).max(100).default(1),
      threshold: z.number().min(0).max(1).default(0.02),
    })
    .default({ compositeBackground: [255, 255, 255], maxPixelDiffPercent: 1, threshold: 0.02 }),
  deviceScaleFactor: z.number().positive().default(4),
  figma: z.object({
    contentsOnly: z.boolean().default(true),
    fileKey: z.string().min(1),
    format: z.enum(["jpg", "png", "svg", "pdf"]).default("png"),
    tokenEnv: z.string().default("FIGMA_DEV_TOKEN"),
  }),
  outputDir: z.string().default("."),
  pageSetup: z
    .object({
      hideSelectors: z.array(z.string()).default([]),
      pauseVideos: z.boolean().default(true),
      style: z.string().optional(),
      waitAfterScrollMs: z.number().nonnegative().default(250),
      waitAfterStyleMs: z.number().nonnegative().default(250),
    })
    .default({
      hideSelectors: [],
      pauseVideos: true,
      waitAfterScrollMs: 250,
      waitAfterStyleMs: 250,
    }),
  states: z.array(stateSchema).min(1),
  viewport: z.object({
    height: z.number().positive(),
    width: z.number().positive(),
  }),
});

function resolveFromWorkspace(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
}

function reportPath(outputDir, file) {
  return path.relative(outputDir, file);
}

function stateGroupName(state) {
  return state.groupName ?? state.name;
}

async function ensureOutputDir(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
}

function readShellEnv(name) {
  if (process.env[name]) {
    return process.env[name];
  }

  return execFileSync("fish", ["-lc", `printf %s "$${name}"`], {
    encoding: "utf8",
  }).trim();
}

async function figmaFetch(pathname, token) {
  const response = await fetch(`https://api.figma.com/v1/${pathname}`, {
    headers: {
      "X-Figma-Token": token,
    },
  });

  if (!response.ok) {
    throw new Error(`Figma API ${pathname} failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

async function getFigmaMe(token) {
  const response = await figmaFetch("me", token);
  return response.json();
}

async function downloadFigmaScreenshots({ config, token }) {
  const params = new URLSearchParams({
    contents_only: String(config.figma.contentsOnly),
    format: config.figma.format,
    ids: config.states.map((state) => state.nodeId).join(","),
    scale: String(config.deviceScaleFactor),
  });

  const response = await figmaFetch(`images/${config.figma.fileKey}?${params.toString()}`, token);
  const payload = await response.json();
  const results: Array<{ image: PNG; state: string; }> = [];

  for (const state of config.states) {
    const imageUrl = payload.images?.[state.nodeId];

    if (!imageUrl) {
      throw new Error(`Figma did not return an image URL for ${state.name} (${state.nodeId})`);
    }

    const imageResponse = await fetch(imageUrl);

    if (!imageResponse.ok) {
      throw new Error(`Downloading ${state.name} Figma PNG failed: ${imageResponse.status}`);
    }

    const bytes = Buffer.from(await imageResponse.arrayBuffer());

    results.push({
      image: PNG.sync.read(bytes),
      state: state.name,
    });
  }

  return new Map(results.map((result) => [result.state, result]));
}

function rectFromFigmaBox(box) {
  if (!box) return null;

  return {
    height: box.height,
    width: box.width,
    x: box.x,
    y: box.y,
  };
}

function flattenFigmaNodes(node, depth = 0, nodes: any[] = []) {
  nodes.push({
    absoluteBoundingBox: rectFromFigmaBox(node.absoluteBoundingBox),
    characters: node.characters,
    depth,
    id: node.id,
    name: node.name,
    type: node.type,
  });

  for (const child of node.children ?? []) {
    flattenFigmaNodes(child, depth + 1, nodes);
  }

  return nodes;
}

async function measureFigmaStates({ config, token }) {
  const params = new URLSearchParams({
    ids: config.states.map((state) => state.nodeId).join(","),
  });
  const response = await figmaFetch(
    `files/${config.figma.fileKey}/nodes?${params.toString()}`,
    token,
  );
  const payload = await response.json();
  const measurements: Record<string, unknown> = {};

  for (const state of config.states) {
    const root = payload.nodes?.[state.nodeId]?.document;

    if (!root) {
      throw new Error(`Figma nodes API did not return ${state.nodeId}`);
    }

    const flattened = flattenFigmaNodes(root);
    const namedMeasurements = state.figmaMeasurements.map((item) => {
      const matches = flattened.filter((node) =>
        node.name === item.nodeName || node.characters === item.nodeName
      );

      return {
        matches: matches.map((node) => ({
          absoluteBoundingBox: node.absoluteBoundingBox,
          characters: node.characters,
          depth: node.depth,
          id: node.id,
          name: node.name,
          type: node.type,
        })),
        name: item.name,
        nodeName: item.nodeName,
      };
    });

    measurements[state.name] = {
      root: {
        absoluteBoundingBox: rectFromFigmaBox(root.absoluteBoundingBox),
        id: root.id,
        name: root.name,
        type: root.type,
      },
      namedMeasurements,
    };
  }

  return measurements;
}

function compositeOverBackground(source, background) {
  const composited = new PNG({ width: source.width, height: source.height });
  const [r, g, b] = background;

  for (let index = 0; index < source.data.length; index += 4) {
    const alpha = source.data[index + 3] / 255;

    composited.data[index] = Math.round(source.data[index] * alpha + r * (1 - alpha));
    composited.data[index + 1] = Math.round(source.data[index + 1] * alpha + g * (1 - alpha));
    composited.data[index + 2] = Math.round(source.data[index + 2] * alpha + b * (1 - alpha));
    composited.data[index + 3] = 255;
  }

  return composited;
}

async function preparePage(page, config, state) {
  await page.setViewportSize(config.viewport);
  await page.goto(config.appUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(state.waitForSelector);
  await page.waitForTimeout(100);
  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), state.scrollY);

  if (state.waitForStateAttribute) {
    await page.waitForFunction(
      ({ selector, attribute, value }) =>
        document.querySelector(selector)?.getAttribute(attribute) === value,
      state.waitForStateAttribute,
    );
  }

  await page.waitForTimeout(config.pageSetup.waitAfterScrollMs);
  await page.evaluate(() => document.fonts.ready);

  if (config.pageSetup.pauseVideos) {
    await page.evaluate(() => {
      for (const video of document.querySelectorAll("video")) {
        video.pause();
      }
    });
  }

  const hideCss = config.pageSetup.hideSelectors
    .map((selector) => `${selector} { visibility: hidden !important; }`)
    .join("\n");

  await page.addStyleTag({
    content: `
      html,
      body {
        background: rgb(${config.compare.compositeBackground.join(" ")}) !important;
      }

      ${hideCss}
      ${config.pageSetup.style ?? ""}
    `,
  });
  await page.waitForTimeout(config.pageSetup.waitAfterStyleMs);
}

async function measureBrowserState({ config, page, state }) {
  await preparePage(page, config, state);

  return page.evaluate(
    ({ browserClip, measurements, viewport }) => {
      const readElement = ({ name, selector }) => {
        const element = document.querySelector(selector);

        if (!element) {
          return {
            found: false,
            name,
            selector,
          };
        }

        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);

        return {
          found: true,
          name,
          rect: {
            height: rect.height,
            width: rect.width,
            x: rect.x,
            y: rect.y,
          },
          selector,
          style: {
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
          },
        };
      };

      return {
        browserClip,
        devicePixelRatio: window.devicePixelRatio,
        elements: measurements.map(readElement),
        scrollY: window.scrollY,
        viewport,
      };
    },
    {
      browserClip: state.browserClip,
      measurements: state.webMeasurements,
      viewport: config.viewport,
    },
  );
}

async function captureBrowser({ config, page, state }) {
  const imageBuffer = await page.screenshot({
    clip: state.browserClip,
    scale: "device",
    timeout: 60000,
  });

  return {
    image: PNG.sync.read(imageBuffer),
  };
}

async function compareState({ actual, config, outputDir, reference, state }) {
  if (
    reference.image.width !== actual.image.width || reference.image.height !== actual.image.height
  ) {
    throw new Error(
      `${state.name} size mismatch: figma=${reference.image.width}x${reference.image.height}, browser=${actual.image.width}x${actual.image.height}`,
    );
  }

  const groupDir = path.join(outputDir, stateGroupName(state));
  await fs.mkdir(groupDir, { recursive: true });

  const expectedFile = path.join(groupDir, `01-expected-figma@${config.deviceScaleFactor}x.png`);
  const actualFile = path.join(groupDir, `02-actual-chromium@${config.deviceScaleFactor}x.png`);
  const diffFile = path.join(groupDir, "03-diff-pixelmatch.png");
  const expected = compositeOverBackground(reference.image, config.compare.compositeBackground);
  const actualComparison = compositeOverBackground(
    actual.image,
    config.compare.compositeBackground,
  );

  await fs.writeFile(expectedFile, PNG.sync.write(expected));
  await fs.writeFile(actualFile, PNG.sync.write(actualComparison));

  const diff = new PNG({ width: actual.image.width, height: actual.image.height });
  const mismatchedPixels = pixelmatch(
    actualComparison.data,
    expected.data,
    diff.data,
    actual.image.width,
    actual.image.height,
    { threshold: config.compare.threshold },
  );

  await fs.writeFile(diffFile, PNG.sync.write(diff));

  const totalPixels = actual.image.width * actual.image.height;

  return {
    state: state.name,
    expected: reportPath(outputDir, expectedFile),
    actual: reportPath(outputDir, actualFile),
    diff: reportPath(outputDir, diffFile),
    size: `${actual.image.width}x${actual.image.height}`,
    mismatchedPixels,
    totalPixels,
    diffPercent: Number(((mismatchedPixels / totalPixels) * 100).toFixed(4)),
  };
}

const program = new Command();
program.requiredOption("-c, --config <path>", "JSON config path");
program.parse();

const options = program.opts();
const configPath = resolveFromWorkspace(options.config);
const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
const config = configSchema.parse(rawConfig);
const outputDir = resolveFromWorkspace(config.outputDir);
const token = readShellEnv(config.figma.tokenEnv);

if (!token) {
  throw new Error(`${config.figma.tokenEnv} is not set in process env or fish`);
}

await ensureOutputDir(outputDir);

const me = await getFigmaMe(token);
console.log(
  JSON.stringify(
    {
      figmaMe: {
        email: me.email,
        handle: me.handle,
        id: me.id,
      },
    },
    null,
    2,
  ),
);

const figmaReferences = await downloadFigmaScreenshots({ config, token });
const figmaMeasurements = await measureFigmaStates({ config, token });
const browser = await chromium.launch({
  ...(config.browser.executablePath ? { executablePath: config.browser.executablePath } : {}),
  headless: config.browser.headless,
});
const context = await browser.newContext({
  deviceScaleFactor: config.deviceScaleFactor,
  viewport: config.viewport,
});
const page = await context.newPage();

try {
  const results: Array<Awaited<ReturnType<typeof compareState>>> = [];
  const browserMeasurements: Record<string, unknown> = {};

  for (const state of config.states) {
    const reference = figmaReferences.get(state.name);

    if (!reference) {
      throw new Error(`Missing Figma reference for ${state.name}`);
    }

    browserMeasurements[state.name] = await measureBrowserState({ config, page, state });
    const actual = await captureBrowser({ config, page, state });
    results.push(await compareState({ actual, config, outputDir, reference, state }));
  }

  const measurements = {
    browser: browserMeasurements,
    figma: figmaMeasurements,
  };
  const maxDiffPercent = Math.max(...results.map((result) => result.diffPercent));
  const passed = maxDiffPercent <= config.compare.maxPixelDiffPercent;
  const report = {
    appUrl: config.appUrl,
    config: path.relative(workspaceRoot, configPath),
    figmaFileKey: config.figma.fileKey,
    figmaMe: {
      email: me.email,
      handle: me.handle,
      id: me.id,
    },
    generatedAt: new Date().toISOString(),
    maxAllowedDiffPercent: config.compare.maxPixelDiffPercent,
    maxDiffPercent,
    measurements,
    outputDir: path.relative(workspaceRoot, outputDir),
    scale: config.deviceScaleFactor,
    passed,
    threshold: config.compare.threshold,
    results,
  };

  await fs.writeFile(
    path.join(outputDir, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  await browser.close();
}
