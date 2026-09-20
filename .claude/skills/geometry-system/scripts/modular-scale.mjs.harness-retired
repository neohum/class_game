#!/usr/bin/env node
// Modular scale + spacing generator for the design harness.
// Deterministic: same inputs always yield the same scale, so geometry-architect
// never hand-computes ratios (a common source of off-by-rounding drift).
//
// Usage:
//   node modular-scale.mjs --base 16 --ratio 1.25 --up 6 --down 2
//   node modular-scale.mjs --ratio golden --base 16 --up 7
//   node modular-scale.mjs --spacing --unit 4 --steps 12 --mode geometric
//
// Flags:
//   --base   <px>    base font size / reference value (default 16)
//   --ratio  <n|name> ratio number or named ratio (default 1.25)
//   --up     <n>     steps above base (default 6)
//   --down   <n>     steps below base (default 2)
//   --round  <n>     decimal places for px (default 2)
//   --spacing        emit a spacing scale instead of a type scale
//   --unit   <px>    spacing base unit (default 8, often 4)
//   --steps  <n>     number of spacing steps (default 10)
//   --mode   <geometric|linear|fibonacci>  spacing progression (default linear-multiples)

const NAMED_RATIOS = {
  'minor-second': 1.067,
  'major-second': 1.125,
  'minor-third': 1.2,
  'major-third': 1.25,
  'perfect-fourth': 1.333,
  'aug-fourth': 1.414, // √2
  'perfect-fifth': 1.5,
  golden: 1.618,
  'major-sixth': 1.667,
};

function parseArgs(argv) {
  const a = { base: 16, ratio: '1.25', up: 6, down: 2, round: 2, spacing: false, unit: 8, steps: 10, mode: 'multiples' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--spacing') { a.spacing = true; continue; }
    const v = argv[++i];
    if (k === '--base') a.base = Number(v);
    else if (k === '--ratio') a.ratio = v;
    else if (k === '--up') a.up = Number(v);
    else if (k === '--down') a.down = Number(v);
    else if (k === '--round') a.round = Number(v);
    else if (k === '--unit') a.unit = Number(v);
    else if (k === '--steps') a.steps = Number(v);
    else if (k === '--mode') a.mode = v;
  }
  return a;
}

function resolveRatio(r) {
  if (NAMED_RATIOS[r] != null) return NAMED_RATIOS[r];
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 1) {
    console.error(`Invalid ratio "${r}". Use a number > 1 or one of: ${Object.keys(NAMED_RATIOS).join(', ')}`);
    process.exit(1);
  }
  return n;
}

const round = (n, d) => Number(n.toFixed(d));

function typeScale(a) {
  const ratio = resolveRatio(a.ratio);
  const rows = [];
  // step indices from -down .. +up, step 0 == base
  const names = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl'];
  for (let i = -a.down; i <= a.up; i++) {
    const px = a.base * Math.pow(ratio, i);
    const rem = px / 16;
    const idx = i + a.down; // 0-based for naming from xs
    const name = names[idx] ?? `step${i >= 0 ? '+' : ''}${i}`;
    rows.push({ step: i, name, px: round(px, a.round), rem: round(rem, 4) });
  }
  return { kind: 'type-scale', base: a.base, ratio, ratioName: a.ratio, steps: rows };
}

function spacingScale(a) {
  const rows = [];
  for (let i = 0; i <= a.steps; i++) {
    let px;
    if (a.mode === 'geometric') px = i === 0 ? 0 : a.unit * Math.pow(2, i - 1);
    else if (a.mode === 'fibonacci') {
      const fib = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
      px = (fib[i] ?? fib[fib.length - 1]) * a.unit;
    } else px = a.unit * i; // linear multiples of the base unit
    rows.push({ token: `space.${i}`, px: round(px, a.round), rem: round(px / 16, 4) });
  }
  return { kind: 'spacing-scale', unit: a.unit, mode: a.mode, steps: rows };
}

const a = parseArgs(process.argv);
const out = a.spacing ? spacingScale(a) : typeScale(a);
console.log(JSON.stringify(out, null, 2));
