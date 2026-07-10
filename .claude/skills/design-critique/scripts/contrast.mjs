#!/usr/bin/env node
// WCAG 2.1 relative-luminance contrast checker for the design harness.
// design-critic runs this to verify every text/background pairing with hard
// numbers instead of eyeballing — contrast failures are the #1 silent defect.
//
// Usage:
//   node contrast.mjs "#1a1a1a" "#ffffff"
//   node contrast.mjs "#8a8a8a" "#ffffff" --large    (large text => 3:1 threshold)
//   node contrast.mjs --pairs pairs.json             (batch: [{fg,bg,large?,label?}])
//
// Output: ratio + pass/fail for AA, AA-large, AAA. Exit code 1 if any AA fail.

function hexToRgb(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: "${hex}" (expected #rgb or #rrggbb)`);
  }
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// WCAG relative luminance
function luminance([r, g, b]) {
  const a = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function contrastRatio(fg, bg) {
  const l1 = luminance(hexToRgb(fg));
  const l2 = luminance(hexToRgb(bg));
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function evaluate(fg, bg, large, label) {
  const ratio = contrastRatio(fg, bg);
  const r = Math.round(ratio * 100) / 100;
  return {
    label: label ?? `${fg} on ${bg}`,
    ratio: r,
    large: !!large,
    AA: large ? ratio >= 3 : ratio >= 4.5,
    AAA: large ? ratio >= 4.5 : ratio >= 7,
    threshold_AA: large ? 3 : 4.5,
  };
}

const argv = process.argv.slice(2);
let results = [];

if (argv[0] === '--pairs') {
  const fs = await import('node:fs');
  const pairs = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  results = pairs.map((p) => evaluate(p.fg, p.bg, p.large, p.label));
} else {
  const fg = argv[0];
  const bg = argv[1];
  const large = argv.includes('--large');
  if (!fg || !bg) {
    console.error('Usage: node contrast.mjs <fg-hex> <bg-hex> [--large]  |  --pairs pairs.json');
    process.exit(2);
  }
  results = [evaluate(fg, bg, large)];
}

let anyFail = false;
for (const r of results) {
  if (!r.AA) anyFail = true;
  const tag = r.AA ? (r.AAA ? 'AAA' : 'AA ') : 'FAIL';
  console.log(`[${tag}] ${r.ratio}:1  (need ${r.threshold_AA}:1)  ${r.label}`);
}
console.log(JSON.stringify(results, null, 2));
process.exit(anyFail ? 1 : 0);
