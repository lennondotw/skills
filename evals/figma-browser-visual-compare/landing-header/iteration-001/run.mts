import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pixelmatch from "pixelmatch";
import { chromium, type Page } from "playwright";
import { PNG } from "pngjs";

type CssRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type Comparison = {
  browserClip?: CssRect;
  browserSelector: string;
  captureMode: "manual-clip" | "figma-sized-selector";
  expectedCropCss?: CssRect;
  figmaNodeId: string;
  groupName: string;
  name: string;
  normalizeNearWhiteBackground?: boolean;
  scrollY: number;
  storyId: string;
  waitForState: "compact" | "expanded";
};

const iterationDir = path.dirname(fileURLToPath(import.meta.url));

const settings = {
  browser: {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  },
  compare: {
    compositeBackground: [245, 245, 245] as const,
    maxPixelDiffPercent: 1,
    threshold: 0.02,
  },
  captureBackground: "#f5f5f5",
  deviceScaleFactor: 4,
  figma: {
    contentsOnly: true,
    fileKey: "iwlDssSi4zlRLCaanZoTKp",
    format: "png",
    tokenEnv: "FIGMA_DEV_TOKEN",
  },
  storybookUrl: "http://localhost:6009",
  viewport: { width: 1440, height: 1000 },
};

const comparisons: Comparison[] = [
  {
    browserSelector: "[data-landing-header-active-nav-tab]",
    captureMode: "figma-sized-selector",
    figmaNodeId: "1058:5053",
    groupName: "soft-gradient-pill-tab",
    name: "soft-gradient-pill-tab",
    scrollY: 80,
    storyId: "landing-header--soft-gradient-pill-tab",
    waitForState: "compact",
  },
  {
    browserSelector: "[data-landing-header-login]",
    captureMode: "figma-sized-selector",
    figmaNodeId: "I926:977;1312:2084",
    groupName: "gradient-stroke-pill-button",
    name: "gradient-stroke-pill-button",
    scrollY: 80,
    storyId: "landing-header--gradient-stroke-pill-button",
    waitForState: "compact",
  },
];

function readShellEnv(name: string) {
  if (process.env[name]) return process.env[name];

  return execFileSync("fish", ["-lc", `printf %s "$${name}"`], {
    encoding: "utf8",
  }).trim();
}

async function figmaFetch(pathname: string, token: string) {
  const response = await fetch(`https://api.figma.com/v1/${pathname}`, {
    headers: { "X-Figma-Token": token },
  });

  if (!response.ok) {
    throw new Error(`Figma API ${pathname} failed: ${response.status} ${await response.text()}`);
  }

  return response;
}

function compositeOverBackground(source: PNG, background: readonly [number, number, number]) {
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

function cropPng(source: PNG, cropCss: CssRect) {
  const scale = settings.deviceScaleFactor;
  const sourceX = Math.round(cropCss.x * scale);
  const sourceY = Math.round(cropCss.y * scale);
  const width = Math.round(cropCss.width * scale);
  const height = Math.round(cropCss.height * scale);
  const cropped = new PNG({ width, height });

  PNG.bitblt(source, cropped, sourceX, sourceY, width, height, 0, 0);

  return cropped;
}

function normalizeNearWhiteBackground(source: PNG) {
  const normalized = new PNG({ width: source.width, height: source.height });
  source.data.copy(normalized.data);

  for (let index = 0; index < normalized.data.length; index += 4) {
    const red = normalized.data[index];
    const green = normalized.data[index + 1];
    const blue = normalized.data[index + 2];

    if (red >= 245 && green >= 245 && blue >= 245) {
      normalized.data[index] = 255;
      normalized.data[index + 1] = 255;
      normalized.data[index + 2] = 255;
      normalized.data[index + 3] = 255;
    }
  }

  return normalized;
}

async function getFigmaReferences(token: string) {
  const params = new URLSearchParams({
    contents_only: String(settings.figma.contentsOnly),
    format: settings.figma.format,
    ids: comparisons.map((comparison) => comparison.figmaNodeId).join(","),
    scale: String(settings.deviceScaleFactor),
  });
  const response = await figmaFetch(`images/${settings.figma.fileKey}?${params.toString()}`, token);
  const payload = await response.json();
  const references = new Map<string, PNG>();

  for (const comparison of comparisons) {
    const imageUrl = payload.images?.[comparison.figmaNodeId];

    if (!imageUrl) {
      throw new Error(`Figma did not return ${comparison.name} (${comparison.figmaNodeId})`);
    }

    const imageResponse = await fetch(imageUrl);

    if (!imageResponse.ok) {
      throw new Error(`Downloading ${comparison.name} failed: ${imageResponse.status}`);
    }

    references.set(comparison.name, PNG.sync.read(Buffer.from(await imageResponse.arrayBuffer())));
  }

  return references;
}

function simplifyFigmaNode(node: any, depth = 0): any {
  return {
    absoluteBoundingBox: node.absoluteBoundingBox ?? null,
    blendMode: node.blendMode,
    characters: node.characters,
    children: (node.children ?? []).map((child: any) => simplifyFigmaNode(child, depth + 1)),
    effects: node.effects,
    fills: node.fills,
    id: node.id,
    layoutMode: node.layoutMode,
    name: node.name,
    opacity: node.opacity,
    relativeTransform: node.relativeTransform,
    strokes: node.strokes,
    type: node.type,
    visible: node.visible,
  };
}

async function getFigmaHierarchies(token: string) {
  const params = new URLSearchParams({
    ids: comparisons.map((comparison) => comparison.figmaNodeId).join(","),
  });
  const response = await figmaFetch(
    `files/${settings.figma.fileKey}/nodes?${params.toString()}`,
    token,
  );
  const payload = await response.json();
  const hierarchies: Record<string, unknown> = {};

  for (const comparison of comparisons) {
    const root = payload.nodes?.[comparison.figmaNodeId]?.document;

    if (!root) {
      throw new Error(
        `Figma did not return node hierarchy for ${comparison.name} (${comparison.figmaNodeId})`,
      );
    }

    hierarchies[comparison.name] = simplifyFigmaNode(root);
  }

  return hierarchies;
}

async function preparePage(page: Page, comparison: Comparison) {
  await page.setViewportSize(settings.viewport);
  await page.goto(
    `${settings.storybookUrl}/iframe.html?id=${comparison.storyId}&viewMode=story&globals=theme:light`,
    { waitUntil: "domcontentloaded" },
  );
  await page.evaluate("globalThis.__name = (value) => value");
  await page.waitForSelector("#storybook-root");
  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), comparison.scrollY);
  if (comparison.browserSelector === "[data-landing-header-state]") {
    await page.waitForFunction(
      (state) =>
        document.querySelector("[data-landing-header-state]")?.getAttribute(
          "data-landing-header-state",
        ) === state,
      comparison.waitForState,
    );
  }
  await page.waitForTimeout(700);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    for (const video of document.querySelectorAll("video")) {
      video.pause();
    }
  });
  await page.addStyleTag({
    content: `
      html,
      body {
        background: ${settings.captureBackground} !important;
      }

      #storybook-root,
      #root,
      #__next,
      main {
        background: ${settings.captureBackground} !important;
      }

      main > section {
        visibility: hidden !important;
      }
    `,
  });
  await page.waitForSelector(comparison.browserSelector);
  await page.waitForTimeout(250);
}

async function resolveBrowserClip(page: Page, comparison: Comparison, expected: PNG) {
  if (comparison.captureMode === "manual-clip") {
    if (!comparison.browserClip) {
      throw new Error(`${comparison.name} is manual-clip but has no browserClip`);
    }

    return comparison.browserClip;
  }

  const rect = await page.locator(comparison.browserSelector).boundingBox();

  if (!rect) {
    throw new Error(`${comparison.name} selector did not resolve: ${comparison.browserSelector}`);
  }

  const width = expected.width / settings.deviceScaleFactor;
  const height = expected.height / settings.deviceScaleFactor;

  return {
    height,
    width,
    x: rect.x + rect.width / 2 - width / 2,
    y: rect.y + rect.height / 2 - height / 2,
  };
}

async function measureBrowser(page: Page, comparison: Comparison, browserClip: CssRect) {
  return page.evaluate(
    ({ browserClip, browserSelector, viewport }) => {
      const rectOf = (element: Element | null) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();

        return {
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      };

      const summarizeElement = (element: Element | null, depth = 0): any => {
        if (!element || depth > 5) return null;

        return {
          ariaLabel: element.getAttribute("aria-label"),
          className: element.getAttribute("class"),
          dataAttributes: Object.fromEntries(
            Array.from(element.attributes)
              .filter((attribute) => attribute.name.startsWith("data-"))
              .map((attribute) => [attribute.name, attribute.value]),
          ),
          rect: rectOf(element),
          role: element.getAttribute("role"),
          tagName: element.tagName.toLowerCase(),
          text: Array.from(element.children).length === 0 ? element.textContent?.trim() : undefined,
          children: Array.from(element.children).map((child) => summarizeElement(child, depth + 1)),
        };
      };

      const target = document.querySelector(browserSelector);
      const ancestorChain: any[] = [];
      let current: Element | null = target;

      while (current && current !== document.body) {
        ancestorChain.push(summarizeElement(current, 0));
        current = current.parentElement;
      }

      return {
        browserClip,
        devicePixelRatio: window.devicePixelRatio,
        hierarchy: {
          ancestorChain,
          headerTree: summarizeElement(document.querySelector("[data-landing-header-state]")),
          target: summarizeElement(target),
        },
        scrollY: window.scrollY,
        selector: browserSelector,
        viewport,
      };
    },
    {
      browserClip,
      browserSelector: comparison.browserSelector,
      viewport: settings.viewport,
    },
  );
}

async function captureActual(page: Page, browserClip: CssRect) {
  const buffer = await page.screenshot({
    clip: browserClip,
    scale: "device",
    timeout: 60000,
  });

  return PNG.sync.read(buffer);
}

async function compareImages(
  { actual, comparison, expected }: { actual: PNG; comparison: Comparison; expected: PNG; },
) {
  const groupDir = path.join(iterationDir, comparison.groupName);
  await fs.mkdir(groupDir, { recursive: true });

  const expectedSource = comparison.expectedCropCss
    ? cropPng(expected, comparison.expectedCropCss)
    : expected;
  const compositedExpected = compositeOverBackground(
    expectedSource,
    settings.compare.compositeBackground,
  );
  const compositedActual = compositeOverBackground(actual, settings.compare.compositeBackground);
  const expectedForComparison = comparison.normalizeNearWhiteBackground
    ? normalizeNearWhiteBackground(compositedExpected)
    : compositedExpected;
  const actualForComparison = comparison.normalizeNearWhiteBackground
    ? normalizeNearWhiteBackground(compositedActual)
    : compositedActual;
  const expectedFile = path.join(groupDir, `01-expected-figma@${settings.deviceScaleFactor}x.png`);
  const actualFile = path.join(groupDir, `02-actual-chromium@${settings.deviceScaleFactor}x.png`);
  const diffFile = path.join(groupDir, "03-diff-pixelmatch.png");

  await fs.writeFile(expectedFile, PNG.sync.write(expectedForComparison));
  await fs.writeFile(actualFile, PNG.sync.write(actualForComparison));

  if (
    expectedForComparison.width !== actualForComparison.width
    || expectedForComparison.height !== actualForComparison.height
  ) {
    throw new Error(
      `${comparison.name}: expected ${expectedForComparison.width}x${expectedForComparison.height}, got ${actualForComparison.width}x${actualForComparison.height}`,
    );
  }

  const diff = new PNG({ width: actualForComparison.width, height: actualForComparison.height });
  const mismatchedPixels = pixelmatch(
    actualForComparison.data,
    expectedForComparison.data,
    diff.data,
    actualForComparison.width,
    actualForComparison.height,
    { threshold: settings.compare.threshold },
  );

  await fs.writeFile(diffFile, PNG.sync.write(diff));

  const totalPixels = actualForComparison.width * actualForComparison.height;

  return {
    actual: path.relative(iterationDir, actualFile),
    diff: path.relative(iterationDir, diffFile),
    diffPercent: Number(((mismatchedPixels / totalPixels) * 100).toFixed(4)),
    expected: path.relative(iterationDir, expectedFile),
    mismatchedPixels,
    size: `${actualForComparison.width}x${actualForComparison.height}`,
    state: comparison.name,
    totalPixels,
  };
}

const token = readShellEnv(settings.figma.tokenEnv);

if (!token) {
  throw new Error(`${settings.figma.tokenEnv} is not set in process env or fish`);
}

const me = await (await figmaFetch("me", token)).json();
console.log(
  JSON.stringify({ figmaMe: { email: me.email, handle: me.handle, id: me.id } }, null, 2),
);

const [references, figmaHierarchies] = await Promise.all([
  getFigmaReferences(token),
  getFigmaHierarchies(token),
]);

const browser = await chromium.launch(settings.browser);
const context = await browser.newContext({
  deviceScaleFactor: settings.deviceScaleFactor,
  viewport: settings.viewport,
});
const page = await context.newPage();

try {
  const measurements: {
    browser: Record<string, unknown>;
    figma: Record<string, unknown>;
  } = {
    browser: {},
    figma: figmaHierarchies,
  };
  const results: Array<Awaited<ReturnType<typeof compareImages>>> = [];

  for (const comparison of comparisons) {
    await preparePage(page, comparison);

    const expected = references.get(comparison.name);

    if (!expected) {
      throw new Error(`Missing Figma reference for ${comparison.name}`);
    }

    const browserClip = await resolveBrowserClip(page, comparison, expected);
    measurements.browser[comparison.name] = await measureBrowser(page, comparison, browserClip);

    const actual = await captureActual(page, browserClip);
    results.push(await compareImages({ actual, comparison, expected }));
  }

  const maxDiffPercent = Math.max(...results.map((result) => result.diffPercent));
  const report = {
    storybookUrl: settings.storybookUrl,
    figmaFileKey: settings.figma.fileKey,
    generatedAt: new Date().toISOString(),
    maxAllowedDiffPercent: settings.compare.maxPixelDiffPercent,
    maxDiffPercent,
    passed: maxDiffPercent <= settings.compare.maxPixelDiffPercent,
    results,
    scale: settings.deviceScaleFactor,
    threshold: settings.compare.threshold,
  };

  await fs.writeFile(
    path.join(iterationDir, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(iterationDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  await browser.close();
}
