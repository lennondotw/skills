import { execFileSync } from "node:child_process";

function readFigmaToken() {
  if (process.env.FIGMA_DEV_TOKEN) {
    return process.env.FIGMA_DEV_TOKEN;
  }

  return execFileSync("fish", ["-lc", 'printf %s "$FIGMA_DEV_TOKEN"'], {
    encoding: "utf8",
  }).trim();
}

const token = readFigmaToken();

if (!token) {
  throw new Error("FIGMA_DEV_TOKEN is not set in process env or fish");
}

const response = await fetch("https://api.figma.com/v1/me", {
  headers: {
    "X-Figma-Token": token,
  },
});

if (!response.ok) {
  throw new Error(`Figma /v1/me failed: ${response.status} ${await response.text()}`);
}

const me = await response.json();

console.log(
  JSON.stringify(
    {
      email: me.email,
      handle: me.handle,
      id: me.id,
    },
    null,
    2,
  ),
);
