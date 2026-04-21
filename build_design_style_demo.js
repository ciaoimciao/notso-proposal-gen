#!/usr/bin/env node
/**
 * Build a 4-way design-style comparison from the Save-the-Children fixture.
 *
 * Output:
 *   /sessions/exciting-bold-ptolemy/mnt/VibeCoding/design-style-demo/
 *   ├── notso-signature.html   (one full proposal)
 *   ├── minimal.html
 *   ├── editorial.html
 *   ├── neo.html
 *   └── index.html             (compare all four side-by-side in iframes)
 *
 * Usage:
 *   cd notso-proposal-gen
 *   node build_design_style_demo.js
 */

const fs = require('fs');
const path = require('path');
const { buildProposalHtml } = require('./generate_html');

// ── 1. Load fixture (Save the Children) ───────────────────────────────
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/demo/01-save-the-children.json'), 'utf8')
);

// ── 2. Build a seed proposal (simulates what Claude would produce) ────
// Only the fields actually referenced by renderSlide_* — slides fall back
// to sensible defaults for anything else. Kept short and realistic so the
// comparison focuses on STYLE differences, not content differences.
const seedProposal = {
  mascot_name: fixture.mascotName || 'Hope',

  s1: {
    mascot_name: fixture.mascotName || 'Hope',
    lead: 'The digital fundraiser that turns every visitor into a donor.',
  },

  s3: {
    headline: 'The real problem',
    lead: `${fixture.clientName}'s donation team is overwhelmed answering repetitive questions about where the money goes.`,
    pains: [
      { title: 'Donor drop-off', body: '62% of first-time visitors leave before donating because their questions go unanswered in real time.' },
      { title: 'Support overload', body: 'The small human team spends 40% of its week on the same 20 repetitive donor FAQs.' },
      { title: 'Emotional disconnect', body: 'Static pages can\'t convey the warmth of real impact stories at the moment visitors are deciding.' },
    ],
  },

  s4: {
    headline: 'A $340B market, not enough empathy',
    lead: 'Global charitable giving keeps growing, but first-time donor retention has been falling since 2020. AI companions are the fastest-growing engagement channel for NGOs.',
    industry_size: { value: '$340B', label: 'Global giving' },
    growth_rate: { value: '7.4% CAGR', label: '5-yr digital giving' },
    projected_size: { value: '$486B by 2030', label: 'Projected' },
  },

  s5: {
    headline: 'Three capabilities, one buddy',
    features: [
      { title: 'Empathetic Q&A', body: 'Answers donor questions 24/7 in the brand\'s voice.' },
      { title: 'Impact storytelling', body: 'Surfaces real children\'s stories at the moment of decision.' },
      { title: 'Live campaign push', body: 'Surfaces the right emergency campaign based on donor signals.' },
    ],
  },

  s6: { headline: 'Meet Hope', lead: 'Three candidates, one winner.' },
  s7: { headline: 'Design sheet', lead: 'Turn the iconic red child figure into a 3D digital ambassador.' },
  s8: { headline: 'Personality & Expressions', lead: 'Warm, hopeful, resilient — always kind, never cloying.' },

  s9: {
    headline: 'Chat in action',
    messages: [
      { role: 'user', text: 'Where does my money actually go?' },
      { role: 'mascot', text: 'Great question. About 87 cents of every dollar goes straight to children. Last year, that meant 45 million kids in 117 countries.' },
      { role: 'user', text: 'Can I see a real story?' },
      { role: 'mascot', text: 'Yes! Meet Amara — a 9-year-old in Sudan whose family received shelter and schooling thanks to our monthly giving community.' },
    ],
  },

  s10: { headline: 'Conversation flow', lead: 'From greeting to donation in under 60 seconds.' },
  s11: { headline: 'Knowledge base', lead: 'Donor FAQ, program briefs, impact reports — all kept current.' },
  s12: { headline: 'Data insights', lead: 'Donor intent, drop-off points, top-asked questions.' },

  s13: {
    headline: 'Proven ROI',
    lead: 'Case studies from comparable NGO deployments.',
    metrics: [
      { label: 'Conversion lift', value: '+38%' },
      { label: 'Support volume', value: '-52%' },
      { label: 'Avg gift size', value: '+21%' },
    ],
  },

  s14: {
    headline: 'Roadmap',
    phases: [
      { title: 'Discovery', weeks: 'W1-2', body: 'Brand voice, donor journey audit, Q&A corpus.' },
      { title: 'Design & build', weeks: 'W3-6', body: 'Mascot, conversation flows, site integration.' },
      { title: 'Launch & iterate', weeks: 'W7+', body: 'A/B campaigns, donor feedback loop, knowledge tuning.' },
    ],
  },

  s15: {
    headline: 'Investment',
    tiers: [
      { name: 'Pilot', price: '$18K', items: ['1 mascot', '50 FAQs', '3-month license'] },
      { name: 'Full launch', price: '$48K', items: ['Mascot + 3 expressions', 'Unlimited FAQs', 'Annual license'] },
      { name: 'Always-on', price: '$9K/mo', items: ['Full support', 'Monthly content updates', 'Quarterly reviews'] },
    ],
  },

  s16: { headline: 'Promo materials', lead: 'Social stickers, donation page banners, email avatar set.' },
  s17: { headline: 'Licensing', lead: 'Perpetual use on savethechildren.org, derivative works with notso.ai attribution.' },
  s18: {
    headline: 'Thank you',
    contact: {
      email: 'hello@notso.ai',
      phone: '+1 (555) 012-3456',
      web: 'notso.ai',
    },
  },
};

// ── 3. Build client object shared across variants ────────────────────
const baseClient = {
  name: fixture.clientName,
  industry: fixture.industry,
  color1: fixture.color1hex,      // #E2231A (SCF red)
  color2: fixture.color2hex,      // #1A1A1A
  color3: fixture.color3hex,      // #FFFFFF
  color4: fixture.color4hex,      // #F5A623
  mascotName: fixture.mascotName, // Hope
};

// ── 4. The 4 styles we're comparing ──────────────────────────────────
const STYLES = [
  { id: 'notso-signature', name: 'Notso Signature', note: '預設風格,溫暖灰底 (#F5F5F5),現代 tech 感,字距略緊。' },
  { id: 'minimal',         name: 'Minimal',         note: '純白底 (#FFF),更緊的字距,排版乾淨,像 Apple keynote。' },
  { id: 'editorial',       name: 'Editorial',       note: '暖奶油底 (#FAF7F2),像雜誌排版,字色偏暖黑,文學感。' },
  { id: 'neo',             name: 'Neo-Brutalism',   note: '鮮黃底 (#FFF6D5) + 3px 黑框,h1/h2 全大寫,搶眼強烈。' },
];

// ── 5. Render each variant ──────────────────────────────────────────
const OUT_DIR = '/sessions/exciting-bold-ptolemy/mnt/VibeCoding/design-style-demo';
fs.mkdirSync(OUT_DIR, { recursive: true });

STYLES.forEach(style => {
  const client = Object.assign({}, baseClient, { designStyle: style.id });
  const html = buildProposalHtml({ proposal: JSON.parse(JSON.stringify(seedProposal)), client });
  const outPath = path.join(OUT_DIR, `${style.id}.html`);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`✔ wrote ${style.id}.html (${(html.length/1024).toFixed(1)} KB)`);
});

// ── 6. Build index.html — 2x2 iframe grid for side-by-side comparison ─
const indexHtml = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8"/>
<title>notso.ai — 4 種設計風格同資料對照</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
  html,body{font-family:'Poppins','PingFang TC','Microsoft JhengHei',sans-serif;background:#EDEDE8;margin:0;color:#111}
  .banner{max-width:1800px;margin:0 auto;padding:22px 28px 10px}
  .banner h1{font-size:22px;font-weight:800;margin:0 0 6px;letter-spacing:-.4px}
  .banner p{font-size:13px;color:#444;margin:0;max-width:1200px;line-height:1.6}
  .banner .meta{margin-top:8px;font-size:11px;color:#6B7280}
  .banner .meta code{font-family:'SFMono-Regular',Menlo,monospace;background:#fff;padding:2px 6px;border-radius:4px;border:1px solid #E5E7EB}
  .grid{max-width:1800px;margin:16px auto 40px;padding:0 28px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 32px rgba(0,0,0,.06);display:flex;flex-direction:column}
  .card-head{padding:14px 18px;border-bottom:1px solid #eee;display:flex;align-items:flex-start;gap:10px;justify-content:space-between}
  .card-head h3{margin:0;font-size:15px;font-weight:800;letter-spacing:-.2px}
  .card-head p{margin:3px 0 0;font-size:11px;color:#6B7280;line-height:1.5}
  .card-head a{font-size:11px;font-weight:700;text-decoration:none;padding:6px 12px;border-radius:999px;border:1.5px solid #111;color:#111;white-space:nowrap}
  .card-head a:hover{background:#111;color:#fff}
  .iframe-wrap{width:100%;aspect-ratio:1440/810;background:#F5F5F5}
  iframe{width:100%;height:100%;border:0;display:block}
  .scale-wrap{width:100%;aspect-ratio:1440/810;overflow:hidden;background:#F5F5F5;position:relative}
  .scale-wrap iframe{width:1440px;height:auto;min-height:calc(810px * 18);border:0;transform-origin:0 0;position:absolute;top:0;left:0}
  @media (max-width: 1100px){ .grid{grid-template-columns:1fr} }
</style>
</head>
<body>

<div class="banner">
  <h1>4 種設計風格對照 · 同一份提案資料</h1>
  <p>用 Save the Children 這筆 fixture 當資料(真實可公開的 NGO 品牌、紅色 #E2231A + 黑色 #1A1A1A、吉祥物叫 Hope),把 18 張投影片套上 4 種設計風格。底下每一張是該風格的完整提案,可以滾動看全部 18 張。</p>
  <div class="meta">資料來源: <code>fixtures/demo/01-save-the-children.json</code> · 產出檔: <code>design-style-demo/{notso-signature,minimal,editorial,neo}.html</code></div>
</div>

<div class="grid">
${STYLES.map(style => `
  <div class="card">
    <div class="card-head">
      <div>
        <h3>${style.name} <span style="font-weight:500;color:#6B7280;font-size:12px">· ${style.id}</span></h3>
        <p>${style.note}</p>
      </div>
      <a href="${style.id}.html" target="_blank">Open ↗</a>
    </div>
    <div class="iframe-wrap">
      <iframe src="${style.id}.html" loading="lazy" title="${style.name}"></iframe>
    </div>
  </div>
`).join('')}
</div>

<script>
  // Scroll the iframes to the S1 cover slide when they load (full proposal is long)
  document.querySelectorAll('iframe').forEach(f => {
    f.addEventListener('load', () => {
      try {
        const doc = f.contentDocument;
        if (doc) {
          const style = doc.createElement('style');
          style.textContent = \`
            body{overflow-y:scroll;zoom:.45}
            .slide{margin-bottom:20px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
          \`;
          doc.head.appendChild(style);
        }
      } catch(e) { /* cross-origin, ignore */ }
    });
  });
</script>
</body>
</html>`;

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');
console.log(`✔ wrote index.html`);
console.log(`\n→ Open: ${OUT_DIR}/index.html`);
