#!/usr/bin/env node
// design-render.mjs — inject a variant's tokens.css into the fixed demo layout
// and emit a standalone preview.html. capture-screenshot (Playwright) then shoots
// it so taste-judge can evaluate the ACTUAL rendered result, not the raw numbers.
//
// Design is judged with the eyes; numbers alone hide what a palette/scale feels like.
//
// Usage:
//   node design-render.mjs --tokens path/to/tokens.css --out path/to/preview.html [--label "v1: golden+minimal"] [--theme dark]
//
// Output: a self-contained HTML file (tokens inlined) at --out. Exit 1 on missing input.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, "..", "assets", "demo-page.html");

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const tokensPath = arg("--tokens");
const outPath = arg("--out");
const label = arg("--label", "variant");
const theme = arg("--theme"); // optional: "dark" sets data-theme on <html>

if (!tokensPath || !outPath) {
  console.error('Usage: node design-render.mjs --tokens <tokens.css> --out <preview.html> [--label "..."] [--theme dark]');
  process.exit(2);
}

let tokensCss, template;
try {
  tokensCss = readFileSync(resolve(tokensPath), "utf8");
} catch {
  console.error(`Cannot read tokens css: ${tokensPath}`);
  process.exit(1);
}
try {
  template = readFileSync(TEMPLATE, "utf8");
} catch {
  console.error(`Cannot read demo template: ${TEMPLATE}`);
  process.exit(1);
}

let html = template
  .replace("/* __TOKENS_CSS__ */", () => tokensCss)
  .replace(/__VARIANT_LABEL__/g, () => label.replace(/</g, "&lt;"));

if (theme === "dark") {
  html = html.replace("<html lang=\"ko\">", '<html lang="ko" data-theme="dark">');
}

writeFileSync(resolve(outPath), html);
console.log(JSON.stringify({ rendered: outPath, label, theme: theme || "light", bytes: html.length }));
