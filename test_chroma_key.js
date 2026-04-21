#!/usr/bin/env node
/**
 * Test harness for the browser chroma-key pipeline in index.html.
 *
 * Why: the function runs in-browser on <canvas>, but we want to verify
 * algorithmic correctness without spinning up a browser or a real Gemini
 * call.
 *
 * What this does:
 *   1. Synthesizes a PNG that reproduces the user's bug pattern:
 *        • white background (what Gemini usually outputs)
 *        • a big blue "mascot body" blob in the middle
 *        • a cloud-head shape with two WHITE EYES (enclosed white regions
 *          exactly the same colour as the bg — these MUST be preserved)
 *        • dark "debris" chunks floating near the head (topologically
 *          disconnected — Pass E should drop them)
 *   2. Ports the SAME three-pass algorithm to pure JS / Uint8Array:
 *        Pass B (edge flood) → Pass D (hard snap) → Pass E (island drop)
 *   3. Writes two PNGs:
 *        test_chroma_input.png   — the synthesized buggy image
 *        test_chroma_output.png  — after the full pipeline
 *   4. Asserts:
 *        • main mascot body center is still fully opaque
 *        • cloud-head center is still opaque
 *        • WHITE EYES are still opaque (the bug we just fixed!)
 *        • every debris chunk is now transparent
 *        • edge-ring is transparent
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// ─────────────────────────────────────────────────────────────────────────
// Algorithm — must stay in lockstep with chromaKeyWhiteBackground() in
// index.html. If that one changes, update this one too.
// ─────────────────────────────────────────────────────────────────────────
function chromaKey(d, w, h) {
  const FLOOD_TOLERANCE = 90;
  const HARD_ALPHA_CUTOFF = 140;
  const MIN_ISLAND_RATIO = 0.05;

  // Pass 0 — sample edge dominant colour
  const buckets = new Map();
  const edgeStep = Math.max(1, Math.floor(Math.min(w, h) / 128));
  const sampleAt = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    if (d[i+3] < 200) return;
    const key = ((d[i] >> 5) << 10) | ((d[i+1] >> 5) << 5) | (d[i+2] >> 5);
    const e = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    e.count++; e.r += d[i]; e.g += d[i+1]; e.b += d[i+2];
    buckets.set(key, e);
  };
  for (let dx = 0; dx < w; dx += edgeStep) {
    sampleAt(dx, 0); sampleAt(dx, h - 1);
    sampleAt(dx, 4); sampleAt(dx, h - 5);
  }
  for (let dy = 0; dy < h; dy += edgeStep) {
    sampleAt(0, dy); sampleAt(w - 1, dy);
    sampleAt(4, dy); sampleAt(w - 5, dy);
  }
  let bgR = 255, bgG = 255, bgB = 255, topCount = 0;
  for (const { count, r, g, b } of buckets.values()) {
    if (count > topCount) {
      topCount = count;
      bgR = Math.round(r / count);
      bgG = Math.round(g / count);
      bgB = Math.round(b / count);
    }
  }
  const totalSamples = Array.from(buckets.values()).reduce((n, e) => n + e.count, 0);
  if (!totalSamples || topCount / totalSamples < 0.15) {
    bgR = 255; bgG = 255; bgB = 255;
  }
  const colorDist = (r, g, b) => {
    const dr = r - bgR, dg = g - bgG, db = b - bgB;
    return Math.sqrt(dr*dr + dg*dg + db*db);
  };

  // Pass B — edge flood fill (ONLY pixel-removal pass)
  const visited = new Uint8Array(w * h);
  const stack = [];
  const pushIfBg = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (visited[p]) return;
    const i = p * 4;
    if (d[i+3] === 0) { visited[p] = 1; return; }
    if (colorDist(d[i], d[i+1], d[i+2]) < FLOOD_TOLERANCE) {
      visited[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) { pushIfBg(x, 0); pushIfBg(x, h - 1); }
  for (let y = 0; y < h; y++) { pushIfBg(0, y); pushIfBg(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const i = p * 4;
    d[i+3] = 0;
    const x = p % w;
    const y = (p - x) / w;
    pushIfBg(x + 1, y);
    pushIfBg(x - 1, y);
    pushIfBg(x, y + 1);
    pushIfBg(x, y - 1);
  }

  // Pass D — hard snap alpha
  for (let i = 0; i < d.length; i += 4) {
    d[i+3] = d[i+3] >= HARD_ALPHA_CUTOFF ? 255 : 0;
  }

  // Pass E — island drop
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const estack = [];
  for (let seed = 0; seed < w * h; seed++) {
    if (labels[seed] !== 0) continue;
    if (d[seed * 4 + 3] === 0) continue;
    const lab = sizes.length;
    sizes.push(0);
    labels[seed] = lab;
    estack.push(seed);
    while (estack.length) {
      const q = estack.pop();
      sizes[lab]++;
      const x = q % w;
      if (x + 1 < w) {
        const np = q + 1;
        if (labels[np] === 0 && d[np * 4 + 3] > 0) {
          labels[np] = lab; estack.push(np);
        }
      }
      if (x > 0) {
        const np = q - 1;
        if (labels[np] === 0 && d[np * 4 + 3] > 0) {
          labels[np] = lab; estack.push(np);
        }
      }
      if (q + w < w * h) {
        const np = q + w;
        if (labels[np] === 0 && d[np * 4 + 3] > 0) {
          labels[np] = lab; estack.push(np);
        }
      }
      if (q >= w) {
        const np = q - w;
        if (labels[np] === 0 && d[np * 4 + 3] > 0) {
          labels[np] = lab; estack.push(np);
        }
      }
    }
  }
  let biggest = 0;
  for (let k = 1; k < sizes.length; k++) {
    if (sizes[k] > sizes[biggest]) biggest = k;
  }
  const minKeep = sizes[biggest] * MIN_ISLAND_RATIO;
  let droppedIslandPixels = 0;
  for (let p = 0; p < w * h; p++) {
    const lab = labels[p];
    if (lab === 0) continue;
    if (sizes[lab] < minKeep && lab !== biggest) {
      d[p * 4 + 3] = 0;
      droppedIslandPixels++;
    }
  }

  return { bgR, bgG, bgB, biggestBlobSize: sizes[biggest], droppedIslandPixels, numIslands: sizes.length - 1 };
}

// ─────────────────────────────────────────────────────────────────────────
// Build synthetic test image: 512×512 with blue mascot + eyes + debris
// ─────────────────────────────────────────────────────────────────────────
function synthesize() {
  const w = 512, h = 512;
  const png = new PNG({ width: w, height: h });

  // Fill white bg
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    png.data[i] = 255;
    png.data[i+1] = 255;
    png.data[i+2] = 255;
    png.data[i+3] = 255;
  }

  const setPixel = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    png.data[i] = r;
    png.data[i+1] = g;
    png.data[i+2] = b;
    png.data[i+3] = 255;
  };
  const filledDisc = (cx, cy, rad, r, g, b) => {
    for (let y = cy - rad; y <= cy + rad; y++) {
      for (let x = cx - rad; x <= cx + rad; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy <= rad*rad) setPixel(x, y, r, g, b);
      }
    }
  };
  // Main orange body (saturated — like the real mascot; clearly outside
  // FLOOD_TOLERANCE of white so Pass B doesn't eat through it).
  filledDisc(256, 256, 140, 240, 110, 50);
  // Cloud head (same saturated orange) on top
  filledDisc(256, 170, 95, 240, 110, 50);
  filledDisc(220, 160, 55, 240, 110, 50);
  filledDisc(292, 160, 55, 240, 110, 50);

  // ★ EYES — white (#FFFFFF) circles ENCLOSED by the cloud-head. These
  //   are the same colour as the bg. Old algorithm (Pass A / Pass C) zapped
  //   them. New algorithm (Pass B edge-flood only) must preserve them.
  const eyes = [
    { cx: 232, cy: 168, rad: 12 },  // left eye
    { cx: 280, cy: 168, rad: 12 },  // right eye
  ];
  for (const e of eyes) {
    filledDisc(e.cx, e.cy, e.rad, 255, 255, 255);
    // Add a dark pupil inside each eye (so the eye-white is partially
    // visible as a donut around the pupil). Pupil at 0,0,0 — far from bg.
    filledDisc(e.cx + 2, e.cy, 5, 20, 20, 20);
  }

  // ✗ BUG DEBRIS — dark chunks floating NEAR but not touching the head.
  const debrisChunks = [
    { cx: 180, cy: 55,  rad: 10 },
    { cx: 330, cy: 50,  rad: 12 },
    { cx: 260, cy: 30,  rad: 7  },
    { cx: 420, cy: 200, rad: 8  },
    { cx: 90,  cy: 350, rad: 9  },
  ];
  for (const c of debrisChunks) {
    filledDisc(c.cx, c.cy, c.rad, 40, 40, 40);
  }

  return { png, w, h, debrisChunks, eyes };
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
const outDir = __dirname;
const inputPath = path.join(outDir, 'test_chroma_input.png');
const outputPath = path.join(outDir, 'test_chroma_output.png');

const { png: inputPng, w, h, debrisChunks, eyes } = synthesize();
fs.writeFileSync(inputPath, PNG.sync.write(inputPng));
console.log(`✔ wrote synthesized input  → ${inputPath}  (${w}×${h})`);

// Clone and run chroma
const outPng = new PNG({ width: w, height: h });
outPng.data = Buffer.from(inputPng.data);
const stats = chromaKey(outPng.data, w, h);
fs.writeFileSync(outputPath, PNG.sync.write(outPng));
console.log(`✔ wrote chroma output      → ${outputPath}`);

// Check results
const alphaAt = (x, y) => outPng.data[(y * w + x) * 4 + 3];

const results = [];
// 1. Center of body should be opaque
const centerA = alphaAt(256, 256);
results.push({
  test: 'Mascot body center at (256,256) stays opaque',
  expect: 'alpha=255',
  got: `alpha=${centerA}`,
  pass: centerA === 255,
});

// 2. Head center should be opaque
const headA = alphaAt(256, 170);
results.push({
  test: 'Cloud head center at (256,170) stays opaque',
  expect: 'alpha=255',
  got: `alpha=${headA}`,
  pass: headA === 255,
});

// 3. ★ EYE WHITES — must stay opaque (this is the bug we fixed).
//    Sample the outer ring of the eye (avoiding the pupil).
for (const e of eyes) {
  const ringX = e.cx - e.rad + 2; // just inside the eye outline
  const ringY = e.cy;
  const a = alphaAt(ringX, ringY);
  results.push({
    test: `Eye white outer ring at (${ringX},${ringY}) preserved (RGB=255,255,255 enclosed)`,
    expect: 'alpha=255',
    got: `alpha=${a}`,
    pass: a === 255,
  });
  // Also sample the top of the eye
  const topA = alphaAt(e.cx, e.cy - e.rad + 2);
  results.push({
    test: `Eye white top at (${e.cx},${e.cy - e.rad + 2}) preserved`,
    expect: 'alpha=255',
    got: `alpha=${topA}`,
    pass: topA === 255,
  });
}

// 4. Every debris chunk should be fully transparent
for (const c of debrisChunks) {
  const a = alphaAt(c.cx, c.cy);
  results.push({
    test: `Debris at (${c.cx},${c.cy}) r=${c.rad} removed`,
    expect: 'alpha=0',
    got: `alpha=${a}`,
    pass: a === 0,
  });
}

// 5. Corner pixels (original white bg) transparent
const corners = [[0,0], [w-1,0], [0,h-1], [w-1,h-1]];
for (const [x,y] of corners) {
  const a = alphaAt(x, y);
  results.push({
    test: `Corner (${x},${y}) bg is transparent`,
    expect: 'alpha=0',
    got: `alpha=${a}`,
    pass: a === 0,
  });
}

// 6. Body not riddled with holes — sample 9 interior points
const bodyCheckPoints = [
  [230, 230], [256, 230], [280, 230],
  [230, 260], [256, 260], [280, 260],
  [230, 290], [256, 290], [280, 290],
];
let bodyHoles = 0;
for (const [x,y] of bodyCheckPoints) {
  if (alphaAt(x, y) !== 255) bodyHoles++;
}
results.push({
  test: 'Body interior (9 samples) fully opaque — not riddled with holes',
  expect: '0 holes',
  got: `${bodyHoles} holes`,
  pass: bodyHoles === 0,
});

// 7. Edge-ring cleaned (no stray opaque pixels at y=2)
let edgeOpaque = 0;
for (let x = 0; x < w; x++) {
  if (alphaAt(x, 2) === 255) edgeOpaque++;
}
results.push({
  test: 'Top edge ring (y=2) fully cleaned',
  expect: '0 opaque',
  got: `${edgeOpaque} opaque`,
  pass: edgeOpaque === 0,
});

// ── Report ─────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(72));
console.log(`Chroma-key diagnostics:`);
console.log(`  detected bg color : rgb(${stats.bgR}, ${stats.bgG}, ${stats.bgB})`);
console.log(`  islands found     : ${stats.numIslands}  (biggest = mascot at ${stats.biggestBlobSize}px)`);
console.log(`  pass-E dropped    : ${stats.droppedIslandPixels} debris pixels`);
console.log('─'.repeat(72));
let passCount = 0;
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL';
  const pre = r.pass ? '✔' : '✗';
  console.log(`  ${pre} [${mark}] ${r.test}`);
  if (!r.pass) console.log(`         expected ${r.expect}, got ${r.got}`);
  if (r.pass) passCount++;
}
console.log('─'.repeat(72));
console.log(`${passCount} / ${results.length} tests passed`);
process.exit(passCount === results.length ? 0 : 1);
