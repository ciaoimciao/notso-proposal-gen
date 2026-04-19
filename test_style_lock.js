#!/usr/bin/env node
/**
 * Style Lock verification script.
 *
 * Generates two images through the Notso style lock v1.0 and saves them
 * to ./output/ so you can eyeball whether the lock is actually taking effect:
 *
 *   1. Fin — canonical hero reference from REFERENCE_CAST. Text-only.
 *   2. Client mascot — image-to-image style transfer using a reference PNG.
 *
 * Usage
 * -----
 *   export GEMINI_API_KEY=AIza...
 *   node test_style_lock.js                          # Fin only (no reference image)
 *   node test_style_lock.js ./path/to/client.png     # Fin + style transfer on client.png
 *
 * The script uses the same model that server.js uses in auto-mode
 * (gemini-2.5-flash-image) and falls back to gemini-3-pro-image-preview
 * if the flash model isn't available on your key.
 *
 * Locked: 2026-04-12  (style lock v1.0)
 */

const fs = require('fs');
const path = require('path');
const {
  buildStylePrompt,
  referencePrompt,
  STYLE_VERSION,
} = require('./notso_style_prompt');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('✗ GEMINI_API_KEY environment variable is required.');
  console.error('  Example: export GEMINI_API_KEY=AIza... && node test_style_lock.js');
  process.exit(1);
}

const CLIENT_REF_PATH = process.argv[2] || null;

// Models to try, in priority order. Matches server.js auto-mode.
const MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
];

const OUTPUT_DIR = path.join(__dirname, 'output', 'style_lock_test');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function generate({ label, positive, negative, refImagePath = null }) {
  console.log(`\n── ${label} ──`);
  console.log(`   positive: ${positive.slice(0, 140)}...`);

  const parts = [{ text: positive + '\n\nNEGATIVE: ' + negative }];
  if (refImagePath) {
    if (!fs.existsSync(refImagePath)) {
      console.error(`   ✗ Reference image not found: ${refImagePath}`);
      return null;
    }
    const mimeType = refImagePath.toLowerCase().endsWith('.jpg') || refImagePath.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg'
      : 'image/png';
    const data = fs.readFileSync(refImagePath).toString('base64');
    parts.push({ inlineData: { mimeType, data } });
    console.log(`   ref: ${path.basename(refImagePath)} (${(data.length * 0.75 / 1024).toFixed(0)}KB)`);
  }

  for (const modelName of MODELS) {
    try {
      console.log(`   → trying ${modelName}...`);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
          }),
        }
      );
      if (!res.ok) {
        const err = await res.text();
        console.log(`     ✗ ${res.status}: ${err.slice(0, 200)}`);
        continue;
      }
      const data = await res.json();
      const respParts = data?.candidates?.[0]?.content?.parts || [];
      const img = respParts.find((p) => p.inlineData);
      if (!img) {
        console.log(`     ✗ no image part in response`);
        continue;
      }
      const outPath = path.join(OUTPUT_DIR, `${label}_${modelName.replace(/[^\w.-]/g, '_')}.png`);
      fs.writeFileSync(outPath, Buffer.from(img.inlineData.data, 'base64'));
      console.log(`     ✓ saved: ${outPath}`);
      return outPath;
    } catch (e) {
      console.log(`     ✗ ${modelName} threw: ${e.message}`);
    }
  }
  console.log(`   ✗ all models failed for ${label}`);
  return null;
}

async function main() {
  console.log(`Notso style lock verification — v${STYLE_VERSION}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);

  const results = [];

  // ── Test 1: Fin canonical reference, text-only. ──
  const fin = referencePrompt('fin');
  results.push(
    await generate({
      label: 'fin_canonical',
      positive: fin.positive,
      negative: fin.negative,
    })
  );

  // ── Test 2: Client mascot style transfer. ──
  if (CLIENT_REF_PATH) {
    const client = buildStylePrompt({
      characterDescription:
        'the character shown in the reference image — a fluffy cyan/teal yeti-style monster ' +
        'with two small horns, white face patch, big round eyes, holding a smartphone for a selfie. ' +
        'Preserve the teal body colour, horn shape, white facial patch, and phone prop exactly.',
      brandColorName: 'teal',
      tier: 'hero',
      species: 'animal',
      mood: 'friendly',
      styleTransfer: true,
    });
    results.push(
      await generate({
        label: 'client_mascot_transfer',
        positive: client.positive,
        negative: client.negative,
        refImagePath: CLIENT_REF_PATH,
      })
    );
  } else {
    console.log('\n── client_mascot_transfer: SKIPPED (no reference image path given) ──');
    console.log('   Pass a PNG path as the first CLI argument to run the style-transfer test.');
  }

  console.log('\n──── SUMMARY ────');
  const ok = results.filter((r) => r).length;
  const fail = results.length - ok;
  console.log(`${ok} success, ${fail} failed`);
  if (ok > 0) {
    console.log(`View results: open ${OUTPUT_DIR}`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
