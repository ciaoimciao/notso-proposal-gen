#!/usr/bin/env node
/**
 * Smoke test — happy-path HTML generation.
 *
 * Runs in ~1s with zero extra dependencies. Answers the question:
 *   "Is the proposal generator still alive?"
 *
 * What it verifies:
 *   ① server.js parses without syntax errors
 *   ② generate_html.js exports the expected functions
 *   ③ buildProposalHtml() builds a full 18-slide deck from a fixture
 *   ④ Custom brand colors flow through to CSS vars (palette picker contract)
 *   ⑤ No previously-baked brand hex values leak back into the output
 *
 * Usage:
 *   node test/smoke.js
 *
 * Exit codes:
 *   0  everything passed
 *   1  at least one check failed (prints which)
 *
 * Run this before every push. If this goes red, do NOT deploy.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert').strict;

// ─── Terminal colors for readable output ─────────────────────────────
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const ok   = (msg) => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const fail = (msg) => console.log(`  ${RED}✗${RESET} ${msg}`);

let failures = 0;
function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    fail(`${label}\n    ${DIM}${err.message || err}${RESET}`);
    failures++;
  }
}

// ─── ① server.js parse check ─────────────────────────────────────────
console.log('\n① server.js syntax');
check('server.js parses', () => {
  // Requiring server.js actually boots the server; we only want to
  // confirm it's syntactically valid. Use `node --check` under the hood.
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
  });
});

// ─── ② generate_html.js exports ──────────────────────────────────────
console.log('\n② generate_html.js exports');
const gh = require('../generate_html');
check('exports buildProposalHtml', () => {
  assert.equal(typeof gh.buildProposalHtml, 'function');
});
check('exports generatePDFBuffer', () => {
  assert.equal(typeof gh.generatePDFBuffer, 'function');
});

// ─── ③ happy-path HTML generation ────────────────────────────────────
console.log('\n③ HTML generation from fixture');

// Load a real demo fixture as Step-1 form data.
const fixturePath = path.join(__dirname, '..', 'fixtures', 'demo', '01-save-the-children.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Minimal seed proposal — each slide renderer has sensible defaults, so
// we only need to provide enough to prove data flows through. No Claude
// needed.
const seedProposal = {
  mascot_name: fixture.mascotName,
  s1:  { mascot_name: fixture.mascotName, lead: 'Test lead' },
  s3:  { headline: 'Problem', lead: 'x', pains: [
           { title: 'A', body: 'a' }, { title: 'B', body: 'b' }, { title: 'C', body: 'c' }] },
  s4:  { headline: 'Market', lead: 'x',
         industry_size:  { value: '$X', label: 'size' },
         growth_rate:    { value: '1%', label: 'growth' },
         projected_size: { value: '$Y', label: 'proj' } },
  s5:  { headline: 'Features', features: [
           { title: 'F1', body: 'x' }, { title: 'F2', body: 'y' }, { title: 'F3', body: 'z' }] },
  s13: { headline: 'ROI', metrics: [
           { label: 'A', value: '+1%' }, { label: 'B', value: '+2%' }, { label: 'C', value: '+3%' }] },
  s14: { headline: 'Roadmap', phases: [
           { title: 'P1', weeks: 'W1', body: 'x' },
           { title: 'P2', weeks: 'W2', body: 'y' },
           { title: 'P3', weeks: 'W3', body: 'z' }] },
  s15: { headline: 'Pricing', tiers: [
           { name: 'T1', price: '$1', items: ['x'] },
           { name: 'T2', price: '$2', items: ['y'] },
           { name: 'T3', price: '$3', items: ['z'] }] },
  s18: { headline: 'Thanks', contact: { email: 'x@y.z', phone: '1', web: 'n.a' } },
};

const client = {
  name:       fixture.clientName,
  industry:   fixture.industry,
  color1:     fixture.color1hex,  // #E2231A — Save the Children red
  color2:     fixture.color2hex,
  color3:     fixture.color3hex,
  color4:     fixture.color4hex,
  mascotName: fixture.mascotName,
};

const html = gh.buildProposalHtml({
  proposal: JSON.parse(JSON.stringify(seedProposal)),
  client,
});

check('output is a non-trivial HTML string', () => {
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 30000, `html only ${html.length} bytes, expected > 30K`);
});
check('output includes the client name', () => {
  assert.ok(html.includes(fixture.clientName), `missing "${fixture.clientName}" in output`);
});
check('output renders all 18 slides', () => {
  const slideMatches = html.match(/<div[^>]*class="[^"]*\bslide\b/g) || [];
  // Some slides may render as multiple divs — so we expect AT LEAST 18.
  assert.ok(slideMatches.length >= 18,
    `only ${slideMatches.length} .slide divs found, expected >= 18`);
});

// ─── ④ palette customization flows through ──────────────────────────
console.log('\n④ Palette customization flows to CSS vars');

const CUSTOM_C1 = '#7C3AED'; // purple — distinct from fixture's red
const customHtml = gh.buildProposalHtml({
  proposal: JSON.parse(JSON.stringify(seedProposal)),
  client: Object.assign({}, client, {
    color1: CUSTOM_C1,
    color2: '#EC4899',
    color5: '#F5F5F5', // 5th slot (new in palette v2)
  }),
});

check('custom c1 reaches --brand-c1', () => {
  assert.ok(customHtml.includes(`--brand-c1: ${CUSTOM_C1}`),
    `--brand-c1 not set to ${CUSTOM_C1}`);
});
check('emits 5-slot palette vars (c5 + tints)', () => {
  ['--brand-c5', '--c5-tint', '--brand-c1-wash', '--brand-c2-wash', '--brand-c1-glow']
    .forEach(v => assert.ok(customHtml.includes(v), `missing ${v}`));
});

// ─── ⑤ No baked legacy brand colors leaked ──────────────────────────
console.log('\n⑤ No baked brand hex leaks (palette v2 contract)');

// These are the hardcoded colors we purged during the palette v2 rewrite.
// If any reappear it means someone wrote raw hex/rgba instead of using
// a CSS var — palette picker will stop working on that slide.
const BAKED_COLORS = [
  { needle: 'rgba(59, 178, 142',  reason: 'notso green baked as rgba' },
  { needle: 'rgba(230, 57, 70',   reason: 'notso red baked as rgba' },
  { needle: '#6366f1',            reason: 'legacy indigo #6366f1 baked' },
];
BAKED_COLORS.forEach(({ needle, reason }) => {
  check(`no leak: ${needle}  (${reason})`, () => {
    assert.ok(!customHtml.includes(needle),
      `found "${needle}" in output — use CSS var instead`);
  });
});

// ─── Summary ────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log(`${GREEN}✔ All smoke checks passed.${RESET} Safe to push.`);
  process.exit(0);
} else {
  console.log(`${RED}✘ ${failures} check(s) failed.${RESET} Do NOT push.`);
  process.exit(1);
}
