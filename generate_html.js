#!/usr/bin/env node
/**
 * notso-proposal-gen: HTML → Puppeteer → PDF slide generation
 * PROFESSIONAL DESIGN EDITION - matching Yazio deck quality
 *
 * Usage:
 *   echo '{"format":"pdf","proposal":{...},"client":{...},"selected_slides":[...]}' | node generate_html.js
 */

const fs = require('fs');
const path = require('path');
// Lazy-load puppeteer (only when generatePDF is called)
let puppeteer;

// ═════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═════════════════════════════════════════════════════════════════════════════

function stripEmoji(str) {
  if (!str) return '';
  return str
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
    .trim();
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToString(rgb) {
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

function tintColor(hex, tintAmount = 0.15) {
  const rgb = hexToRgb(hex);
  const white = { r: 255, g: 255, b: 255 };
  return {
    r: Math.round(rgb.r + (white.r - rgb.r) * tintAmount),
    g: Math.round(rgb.g + (white.g - rgb.g) * tintAmount),
    b: Math.round(rgb.b + (white.b - rgb.b) * tintAmount),
  };
}

function tintColorString(hex, tintAmount = 0.15) {
  return `rgba(${tintColor(hex, tintAmount).r}, ${tintColor(hex, tintAmount).g}, ${tintColor(hex, tintAmount).b}, 0.15)`;
}

function buildBrandCSS(client) {
  const c1 = client.color1 || '#3BB28E';
  const c2 = client.color2 || '#e63946';
  const c3 = client.color3 || '#f5a623';
  const c4 = client.color4 || '#e74c3c';
  // c5 is the 5th palette slot — optional. Used by S14 roadmap phase 5 and
  // as a "soft accent / ink" slot. Defaults to c4 so existing 4-slot clients
  // don't break anything.
  const c5 = client.color5 || c4;

  // Semantic vars in addition to the raw 5-slot palette. Each has a fallback
  // so a client that doesn't set it still gets the notso default. The slide
  // renderers read these (e.g. `var(--brand-highlight)`) instead of hard-
  // coding a hex, which is what makes the Canva-style palette swap actually
  // recolor every slide instead of just a few.
  //
  //   --brand-c*-dark → derived darker shade for hover/gradient/dark text
  //   --brand-c*-tint → transparent wash for callout backgrounds + glows
  //                     (replaces baked-in rgba(59,178,142,.08) etc.)
  //
  // CSS color-mix lets the derived shades track whatever client.color* is
  // rather than being pre-baked for the notso green.
  return `
    :root {
      --brand-c1: ${c1};
      --brand-c2: ${c2};
      --brand-c3: ${c3};
      --brand-c4: ${c4};
      --brand-c5: ${c5};
      --brand-main: ${c1};
      --accent: ${c2};
      --c1-tint: ${tintColorString(c1)};
      --c2-tint: ${tintColorString(c2)};
      --c3-tint: ${tintColorString(c3)};
      --c4-tint: ${tintColorString(c4)};
      --c5-tint: ${tintColorString(c5)};
      --brand-c1-dark:   color-mix(in srgb, ${c1} 70%, black);
      --brand-c1-darker: color-mix(in srgb, ${c1} 45%, black);
      --brand-c1-soft:   color-mix(in srgb, ${c1} 18%, white);
      --brand-c2-dark:   color-mix(in srgb, ${c2} 70%, black);
      --brand-c3-dark:   color-mix(in srgb, ${c3} 70%, black);
      --brand-c1-wash:   color-mix(in srgb, ${c1} 8%, transparent);
      --brand-c2-wash:   color-mix(in srgb, ${c2} 8%, transparent);
      --brand-c1-glow:   color-mix(in srgb, ${c1} 12%, transparent);
    }
  `;
}

// Emit CSS for the 6 approved design-style variants. The slide renderers in
// this file hard-code inline styles on every card/bubble/headline (because
// we originally only had one style). Rather than refactor all 18 renderers
// into class-based markup, we use attribute selectors like
// `div[style*="background: white"]` to grip those inline styles and override
// them. Every rule uses !important because it's competing against inline style.
//
// The shared "card" patterns in the slide renderers are:
//   - Card bg:       background: white;                 padding: 32px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05)
//   - Alt card bg:   background: #F4F4F3;               padding: 24px; border-radius: 16px
//   - Chat window:   background: #F9F9F9;               padding: 24px; border-radius: 16px
//   - Chat bubble:   background: #f3f4f6 / brand;       padding: 10px 14px; border-radius: 16px
//   - Big headline:  font-size: 48px; font-weight: 800; color: #1a1a1a
//   - Giant cover:   font-size: 72px / 90px; font-weight: 800
//
// Styles targeted:
//   notso-signature — rounded white cards, pill eyebrows, orange glow halo (default)
//   minimal         — pure white, no card bg, just hairlines, black/yellow mascot
//   editorial       — cream bg, italic brand/eyebrow, larger headline, hairline dividers
//   neo             — bright yellow bg + thick 3px black frame + hard 5px 5px 0 #111 shadows + CAPS
//   bento           — soft off-white, colored bento tiles (orange/teal/black alternating)
//   clay            — lavender bg + inset+outset neumorphic shadows + 22px radius
// ─────────────────────────────────────────────────────────────────────
// Text-color taxonomy + canvas mode + universal contrast safeguards.
// Active for ALL design styles. Adds 6 text-role CSS vars (display/headline/
// stat/body/caption/metadata), maps each font-size to its var via attribute
// selector, and wires canvas modes:
//   white  — default, slide bg follows the per-style original CSS
//   brand  — slide bg = var(--brand-c1) (immersive)
//   hybrid — first + last slide brand, middle slides white
// Universal contrast safeguards override known hazards (var(--brand-c3) text,
// c1-tint pills, c1 borders) so text never fades into bg.
// ─────────────────────────────────────────────────────────────────────
function buildTextAndContrastLayerCSS(client) {
  const tc = (client && client.textColors) || {};
  // 5-role taxonomy (down from 6, per user feedback):
  //   display  — giant cover/thank-you text (structural, rarely tweaked)
  //   heading  — page title + lead block ("Pain Points" + the line below it)
  //   stat     — large numbers (currency, %, counts in cards)
  //   body     — text inside cards (titles, descriptions, bullet lists)
  //   caption  — footers, page tags, "Prepared for X · by notso.ai"
  const display = tc.display || '#1a1a1a';
  const heading = tc.heading || tc.headline || '#1a1a1a';   // legacy fallback
  const stat    = tc.stat    || 'var(--brand-c1)';
  const body    = tc.body    || '#1a1a1a';
  const caption = tc.caption || tc.metadata || '#6b7280';   // medium grey, not too washed out
  return `
    /* ── 5 text-role CSS vars (overridable per-client via picker) ── */
    :root {
      --text-display:  ${display};
      --text-heading:  ${heading};
      --text-stat:     ${stat};
      --text-body:     ${body};
      --text-caption:  ${caption};
      /* Auto-contrast (computed by inline script based on each brand color) */
      --text-on-c1: #1a1a1a;
      --text-on-c2: #ffffff;
      --text-on-c3: #1a1a1a;
      --text-on-c4: #1a1a1a;
    }

    /* ── A. DISPLAY: 64-108px (cover / thank-you giants, mascot name) ── */
    .slide [style*="font-size: 64px"],
    .slide [style*="font-size: 72px"],
    .slide [style*="font-size: 90px"],
    .slide [style*="font-size: 96px"],
    .slide [style*="font-size: 108px"] { color: var(--text-display) !important; }

    /* ── B. HEADING: page title (48px) + lead/intro line (17-22px on slide bg) ──
       The lead is structurally part of the heading block. We force lead to use
       --text-heading by targeting common slide-bg locations (NOT inside cards). */
    .slide [style*="font-size: 48px"] { color: var(--text-heading) !important; }
    /* Lead text — sits directly on the slide bg, after the 48px headline.
       It uses 17-22px. Keep it SAME color as the heading. */
    .slide [style*="max-width: 70%"][style*="font-size: 22px"],
    .slide [style*="max-width: 70%"][style*="font-size: 20px"],
    .slide [style*="max-width: 70%"][style*="font-size: 19px"],
    .slide [style*="max-width: 70%"][style*="font-size: 18px"],
    .slide [style*="max-width: 70%"][style*="font-size: 17px"],
    .slide [style*="max-width: 70%"][style*="font-size: 16px"],
    .slide [style*="max-width: 90%"][style*="font-size: 22px"],
    .slide [style*="max-width: 90%"][style*="font-size: 20px"] {
      color: var(--text-heading) !important;
    }

    /* ── C. STAT: 28-40px (currency, %, large numbers, market values) ── */
    .slide [style*="font-size: 28px"],
    .slide [style*="font-size: 32px"],
    .slide [style*="font-size: 36px"],
    .slide [style*="font-size: 40px"]  { color: var(--text-stat) !important; }

    /* ── D. BODY: 16-22px inside cards (titles, descriptions, bullets) ──
       After the lead carve-out above, remaining 16-22px is card content. */
    .slide [style*="font-size: 22px"],
    .slide [style*="font-size: 20px"],
    .slide [style*="font-size: 19px"],
    .slide [style*="font-size: 18px"],
    .slide [style*="font-size: 17px"],
    .slide [style*="font-size: 16px"]  { color: var(--text-body) !important; }
    /* Re-assert the heading override AFTER body so it wins (later rule wins on equal specificity). */
    .slide [style*="max-width: 70%"][style*="font-size: 22px"],
    .slide [style*="max-width: 70%"][style*="font-size: 20px"],
    .slide [style*="max-width: 70%"][style*="font-size: 19px"],
    .slide [style*="max-width: 70%"][style*="font-size: 18px"],
    .slide [style*="max-width: 70%"][style*="font-size: 17px"],
    .slide [style*="max-width: 70%"][style*="font-size: 16px"],
    .slide [style*="max-width: 90%"][style*="font-size: 22px"],
    .slide [style*="max-width: 90%"][style*="font-size: 20px"] {
      color: var(--text-heading) !important;
    }

    /* ── E. CAPTION: 11-13px (footers, tags, "Prepared for X") ── */
    .slide [style*="font-size: 11px"],
    .slide [style*="font-size: 12px"],
    .slide [style*="font-size: 13px"],
    .slide [style*="font-size: 14px"],
    .slide [style*="font-size: 15px"]  { color: var(--text-caption) !important; }

    /* ── CANVAS MODE = brand: auto-flip text roles to contrast against bg ── */
    /* When the slide canvas is set to var(--brand-c1), text directly on the
       canvas (heading + caption) must use the computed contrast partner so it
       never disappears into the bg. Stat keeps brand-c1 because stats live on
       white cards. Body keeps dark because body lives on white cards. */
    html[data-canvas-mode="brand"] {
      --text-heading: var(--text-on-c1);
      --text-caption: var(--text-on-c1);
      --text-display: var(--text-on-c1);
    }
    html[data-canvas-mode="hybrid"] .slide:first-of-type,
    html[data-canvas-mode="hybrid"] .slide:last-of-type {
      /* Same idea, scoped to the first/last slide only */
    }
    html[data-canvas-mode="hybrid"] .slide:first-of-type [style*="font-size: 48px"],
    html[data-canvas-mode="hybrid"] .slide:last-of-type [style*="font-size: 48px"],
    html[data-canvas-mode="hybrid"] .slide:first-of-type [style*="max-width: 70%"][style*="font-size: 20px"],
    html[data-canvas-mode="hybrid"] .slide:last-of-type [style*="max-width: 70%"][style*="font-size: 20px"] {
      color: var(--text-on-c1) !important;
    }

    /* ── CONTRAST SAFEGUARDS (active for every canvas mode) ── */
    /* (1) brand-c3 used as text on a white card = invisible. Auto-replace. */
    .slide div[style*="background: white"] [style*="color: var(--brand-c3)"],
    .slide div[style*="background: #fff"] [style*="color: var(--brand-c3)"] {
      color: #1a1a1a !important;
    }
    /* (2) Phrase pills (S7) — background var(--c1-tint) blends into brand
       canvas. Force white pill with dark border + dark text. */
    .slide div[style*="background: var(--c1-tint)"][style*="border: 1px solid var(--brand-c1)"] {
      background: #ffffff !important;
      border-color: var(--brand-c2) !important;
      color: #1a1a1a !important;
    }

    /* ── CANVAS MODE: brand (immersive) ── */
    html[data-canvas-mode="brand"] .slide {
      background: var(--brand-c1) !important;
      color: var(--text-on-c1) !important;
    }
    html[data-canvas-mode="brand"] .slide div[style*="background: white"] {
      box-shadow: 0 4px 18px rgba(0,0,0,.10) !important;
    }
    /* Light-grey labels directly on the colored canvas: flip with --text-on-c1 */
    html[data-canvas-mode="brand"] .slide > * [style*="color: #9ca3af"],
    html[data-canvas-mode="brand"] .slide > * [style*="color: #d1d5db"] {
      color: var(--text-on-c1) !important;
      opacity: 0.75;
    }

    /* ── CANVAS MODE: hybrid (first + last brand, middle white) ── */
    html[data-canvas-mode="hybrid"] .slide:first-of-type,
    html[data-canvas-mode="hybrid"] .slide:last-of-type {
      background: var(--brand-c1) !important;
      color: var(--text-on-c1) !important;
    }
    html[data-canvas-mode="hybrid"] .slide:first-of-type div[style*="background: white"],
    html[data-canvas-mode="hybrid"] .slide:last-of-type div[style*="background: white"] {
      box-shadow: 0 4px 18px rgba(0,0,0,.10) !important;
    }
    html[data-canvas-mode="hybrid"] .slide:first-of-type > * [style*="color: #9ca3af"],
    html[data-canvas-mode="hybrid"] .slide:first-of-type > * [style*="color: #d1d5db"],
    html[data-canvas-mode="hybrid"] .slide:last-of-type > * [style*="color: #9ca3af"],
    html[data-canvas-mode="hybrid"] .slide:last-of-type > * [style*="color: #d1d5db"] {
      color: var(--text-on-c1) !important;
      opacity: 0.75;
    }
  `;
}

function buildStyleVariantCSS() {
  // Attribute-selector tokens that match the inline-styled elements the slide
  // renderers emit. Keep them as constants so adding a new style is just a
  // matter of adding a block below.
  const WHITE_CARD = `div[style*="background: white"]`;        // s3/s4/s5/s11 cards
  const ALT_CARD   = `div[style*="background: #F4F4F3"]`;      // s6/s8 option cards + page bg
  const CHAT_WIN   = `div[style*="background: #F9F9F9"]`;      // s9 chat window bg
  const BUBBLE     = `div[style*="padding: 10px 14px"]`;       // chat bubbles

  return `
    /* ═════════════════════════════════════════════════════════════════ */
    /* ① NOTSO.AI SIGNATURE — rounded white cards, pill eyebrows,       */
    /*    orange glow halo on mascot — the default / official look       */
    /* ═════════════════════════════════════════════════════════════════ */
    /* Slide bg = #FFFFFF so card grids (S2/S3/S4/S5/S6/S10/S11/S13/S14/S15/S16)
       don't show a grey cross through the grid gap. Cards still pop because
       of their box-shadow + occasional border-left accent. Was #F5F5F5 which
       caused the "grey grid cross" bug user reported. */
    [data-design-style='notso-signature'] .slide{background:#FFFFFF !important;color:#111 !important}
    [data-design-style='notso-signature'] .slide h1,
    [data-design-style='notso-signature'] .slide h2,
    [data-design-style='notso-signature'] .slide h3{letter-spacing:-.5px}
    [data-design-style='notso-signature'] .slide ${WHITE_CARD}{
      border-radius:18px !important;
      box-shadow:0 2px 14px rgba(0,0,0,.05) !important;
    }
    [data-design-style='notso-signature'] .slide ${ALT_CARD}{
      background:#fff !important;
      border-radius:18px !important;
      box-shadow:0 2px 14px rgba(0,0,0,.04) !important;
    }
    [data-design-style='notso-signature'] .slide ${CHAT_WIN}{
      background:#fff !important;
      border-radius:18px !important;
      box-shadow:0 2px 14px rgba(0,0,0,.04) !important;
    }
    [data-design-style='notso-signature'] .slide ${BUBBLE}{
      border-radius:18px !important;
      box-shadow:0 2px 10px rgba(0,0,0,.05);
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* ② MINIMALIST (Swiss) — no card backgrounds, just hairlines,      */
    /*    maximum whitespace, tighter tracking                           */
    /* ═════════════════════════════════════════════════════════════════ */
    [data-design-style='minimal'] .slide{background:#FFFFFF !important;color:#111 !important}
    [data-design-style='minimal'] .slide h1,
    [data-design-style='minimal'] .slide h2,
    [data-design-style='minimal'] .slide h3{letter-spacing:-.8px;font-weight:700}
    /* Strip the cards bare — flat, no bg, just a top hairline */
    [data-design-style='minimal'] .slide ${WHITE_CARD}{
      background:transparent !important;
      border-radius:0 !important;
      box-shadow:none !important;
      border-top:2px solid #111 !important;
      border-left:none !important;
      padding:20px 0 0 0 !important;
    }
    [data-design-style='minimal'] .slide ${ALT_CARD}{
      background:transparent !important;
      border:none !important;
      border-top:1px solid #E5E7EB !important;
      border-radius:0 !important;
      padding-top:18px !important;
    }
    [data-design-style='minimal'] .slide ${CHAT_WIN}{
      background:transparent !important;
      border:1px solid #E5E7EB !important;
      border-radius:0 !important;
    }
    [data-design-style='minimal'] .slide ${BUBBLE}{
      border-radius:4px !important;
      border:1px solid #E5E7EB;
    }
    /* Kill decorative dividers that become redundant against new borders */
    [data-design-style='minimal'] .slide div[style*="border-bottom: 1px solid rgba(0,0,0,0.1)"]{
      border-bottom:1px solid #111 !important;
    }
    /* Insight boxes become plain blockquotes */
    [data-design-style='minimal'] .slide div[style*="border-left: 4px solid"]{
      background:transparent !important;
      border-left:2px solid #111 !important;
      border-radius:0 !important;
      padding-left:20px !important;
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* ③ BENTO GRID — soft off-white bg, alternating colored tiles,     */
    /*    Japanese-minimal vibes                                         */
    /* ═════════════════════════════════════════════════════════════════ */
    [data-design-style='bento'] .slide{background:#F5F5F0 !important;color:#111 !important}
    [data-design-style='bento'] .slide ${WHITE_CARD}{
      border-radius:14px !important;
      box-shadow:0 2px 8px rgba(0,0,0,.04) !important;
    }
    /* Alternating tile colors via nth-child targeting the grid parent */
    [data-design-style='bento'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD}:nth-child(1){
      background:#111 !important;color:#fff !important;
    }
    [data-design-style='bento'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD}:nth-child(2){
      background:#E8A317 !important;color:#fff !important;
    }
    [data-design-style='bento'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD}:nth-child(3){
      background:#4ECDC4 !important;color:#fff !important;
    }
    [data-design-style='bento'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD} div{color:inherit !important}
    [data-design-style='bento'] .slide ${ALT_CARD}{
      background:#fff !important;border-radius:14px !important;
      box-shadow:0 2px 8px rgba(0,0,0,.04) !important;
    }
    [data-design-style='bento'] .slide ${CHAT_WIN}{
      background:#fff !important;border-radius:14px !important;
      box-shadow:0 2px 8px rgba(0,0,0,.04) !important;
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* ④ EDITORIAL MAGAZINE — cream bg, italic brand marks, larger      */
    /*    headlines with tighter tracking, hairline-divider cards        */
    /* ═════════════════════════════════════════════════════════════════ */
    [data-design-style='editorial'] .slide{background:#FAF7F2 !important;color:#2a2a2a !important}
    [data-design-style='editorial'] .slide div[style*="font-size: 48px"]{
      font-size:58px !important;letter-spacing:-1.2px !important;line-height:1.02 !important;
      font-weight:800 !important;
    }
    [data-design-style='editorial'] .slide div[style*="font-size: 72px"]{
      font-size:92px !important;letter-spacing:-2px !important;line-height:.98 !important;
    }
    [data-design-style='editorial'] .slide div[style*="font-size: 90px"]{
      font-size:108px !important;letter-spacing:-2.5px !important;line-height:.96 !important;
    }
    /* Strip card chrome; use hairlines and left-rule dividers instead */
    [data-design-style='editorial'] .slide ${WHITE_CARD}{
      background:transparent !important;
      border-radius:0 !important;
      box-shadow:none !important;
      border-top:1.5px solid #2a2a2a !important;
      border-left:none !important;
      padding:22px 0 0 0 !important;
    }
    [data-design-style='editorial'] .slide ${ALT_CARD}{
      background:transparent !important;
      border-left:1px solid #D4B895 !important;
      border-radius:0 !important;
      padding:8px 0 8px 20px !important;
    }
    [data-design-style='editorial'] .slide ${CHAT_WIN}{
      background:#fff !important;
      border:1px solid #E5DDD0 !important;
      border-radius:0 !important;
    }
    [data-design-style='editorial'] .slide ${BUBBLE}{
      border-radius:2px !important;
      border:1px solid #E5DDD0;
      font-style:italic;
    }
    /* Italicise the small muted "presents:" / "prepared for" marks */
    [data-design-style='editorial'] .slide div[style*="color: #9ca3af"]{
      font-style:italic !important;color:#8a7a5e !important;
    }
    /* Insight / market-gap panels: warm-tinted block instead of green */
    [data-design-style='editorial'] .slide div[style*="border-left: 4px solid"]{
      background:rgba(212,184,149,.18) !important;
      border-left:3px solid #8a7a5e !important;
      border-radius:0 !important;
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* ⑤ NEOBRUTALISM — bright yellow bg, thick 3px black frame,        */
    /*    hard 5px 5px 0 black drop shadows, ALL CAPS headlines          */
    /* ═════════════════════════════════════════════════════════════════ */
    [data-design-style='neo'] .slide{
      background:#FFF6D5 !important;color:#111 !important;
      border:3px solid #111 !important;border-radius:0 !important;
    }
    [data-design-style='neo'] .slide *{border-radius:0 !important}
    [data-design-style='neo'] .slide h1,
    [data-design-style='neo'] .slide h2{
      text-transform:uppercase;letter-spacing:-.2px;font-weight:900;
    }
    [data-design-style='neo'] .slide div[style*="font-size: 48px"],
    [data-design-style='neo'] .slide div[style*="font-size: 64px"],
    [data-design-style='neo'] .slide div[style*="font-size: 72px"],
    [data-design-style='neo'] .slide div[style*="font-size: 90px"]{
      text-transform:uppercase !important;font-weight:900 !important;letter-spacing:-.3px !important;
    }
    [data-design-style='neo'] .slide ${WHITE_CARD}{
      background:#fff !important;
      border:2.5px solid #111 !important;
      box-shadow:5px 5px 0 #111 !important;
      border-radius:0 !important;
    }
    /* Alternate accent colors across card rows so it looks punchy */
    [data-design-style='neo'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD}:nth-child(1){
      background:#FF6B6B !important;color:#fff !important;
    }
    [data-design-style='neo'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD}:nth-child(2){
      background:#4ECDC4 !important;color:#111 !important;
    }
    [data-design-style='neo'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD}:nth-child(3){
      background:#111 !important;color:#FFD93D !important;
    }
    [data-design-style='neo'] .slide div[style*="grid-template-columns: repeat(3, 1fr)"] > ${WHITE_CARD} div{color:inherit !important}
    [data-design-style='neo'] .slide ${ALT_CARD}{
      background:#fff !important;
      border:2.5px solid #111 !important;
      box-shadow:5px 5px 0 #111 !important;
      border-radius:0 !important;
    }
    [data-design-style='neo'] .slide ${CHAT_WIN}{
      background:#fff !important;
      border:2.5px solid #111 !important;
      box-shadow:5px 5px 0 #111 !important;
      border-radius:0 !important;
    }
    [data-design-style='neo'] .slide ${BUBBLE}{
      border:2.5px solid #111 !important;
      box-shadow:3px 3px 0 #111 !important;
      border-radius:0 !important;
      font-weight:700 !important;text-transform:uppercase;
    }
    /* The "AI Mascot Proposal" / "Contents" pill badges become hard blocks */
    [data-design-style='neo'] .slide div[style*="border-radius: 20px"]{
      border-radius:0 !important;
      border:2.5px solid #111 !important;
      box-shadow:3px 3px 0 #111 !important;
      text-transform:uppercase;font-weight:900;
    }
    /* Insight block: hard yellow block with thick border */
    [data-design-style='neo'] .slide div[style*="border-left: 4px solid"]{
      background:#FFD93D !important;
      border:2.5px solid #111 !important;
      box-shadow:5px 5px 0 #111 !important;
      border-radius:0 !important;
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* ⑥ CLAYMORPHISM — lavender bg, puffy 22px radius, inset+outset    */
    /*    neumorphic shadows, soft pastel mascot halos                   */
    /* ═════════════════════════════════════════════════════════════════ */
    [data-design-style='clay'] .slide{background:#F0ECFF !important;color:#2d2a50 !important}
    [data-design-style='clay'] .slide ${WHITE_CARD}{
      background:#F7F5FF !important;
      border-radius:22px !important;
      box-shadow:
        inset -4px -4px 10px rgba(255,255,255,.9),
        inset 4px 4px 10px rgba(163,150,220,.35),
        6px 6px 16px rgba(163,150,220,.25) !important;
    }
    [data-design-style='clay'] .slide ${ALT_CARD}{
      background:#F7F5FF !important;
      border-radius:22px !important;
      box-shadow:
        inset -3px -3px 8px rgba(255,255,255,.9),
        inset 3px 3px 8px rgba(163,150,220,.3),
        5px 5px 12px rgba(163,150,220,.2) !important;
    }
    [data-design-style='clay'] .slide ${CHAT_WIN}{
      background:#F7F5FF !important;
      border-radius:22px !important;
      box-shadow:
        inset -4px -4px 10px rgba(255,255,255,.9),
        inset 4px 4px 10px rgba(163,150,220,.25),
        6px 6px 16px rgba(163,150,220,.2) !important;
    }
    [data-design-style='clay'] .slide ${BUBBLE}{
      border-radius:18px !important;
      box-shadow:
        inset -2px -2px 6px rgba(255,255,255,.9),
        inset 2px 2px 6px rgba(163,150,220,.25),
        3px 3px 8px rgba(163,150,220,.15);
    }
    /* Round every pill/badge harder */
    [data-design-style='clay'] .slide div[style*="border-radius: 20px"]{
      border-radius:22px !important;
      box-shadow:4px 4px 10px rgba(163,150,220,.25);
    }
  `;
}

function readImageAsDataURI(imagePath) {
  try {
    // Callers increasingly pass a data: URI directly (Asset Pack images are
    // cached client-side as data URLs to survive Vercel cold starts, where
    // /tmp may have evaporated). Pass those through unchanged.
    if (typeof imagePath === 'string' && imagePath.startsWith('data:')) {
      return imagePath;
    }
    if (!fs.existsSync(imagePath)) {
      return null;
    }
    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.webp') mimeType = 'image/webp';
    return `data:${mimeType};base64,${base64}`;
  } catch (e) {
    return null;
  }
}

function getImageHTML(imagePath, alt = 'Image', classes = '', slotKey = '') {
  // slotKey (e.g. "cover_s1", "option_a", "expression_3") lets the client
  // identify which placed mascot an <img> belongs to so it can attach
  // transform controls and re-apply stored scale/rotate/flip/offset.
  const slotAttr = slotKey ? ` data-slot-key="${slotKey}"` : '';
  if (!imagePath) {
    return `<div class="image-placeholder ${classes}"${slotAttr}>
      <div style="text-align: center; color: #d1d5db; font-size: 17px; padding: 20px;">
        [Image placeholder]
      </div>
    </div>`;
  }

  const dataURI = readImageAsDataURI(imagePath);
  if (dataURI) {
    return `<img src="${dataURI}" alt="${alt}" style="max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center;"${slotAttr} />`;
  } else {
    return `<div class="image-placeholder ${classes}"${slotAttr}>
      <div style="text-align: center; color: #d1d5db; font-size: 17px; padding: 20px;">
        [Image not found]
      </div>
    </div>`;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Slide Template Functions (18 professional designs)
// ═════════════════════════════════════════════════════════════════════════════

function renderSlide_S1_Cover(proposal, client, mascotImages) {
  const d = proposal.s1 || {};
  const clientName = client.name || '';
  // Precedence: user's form input wins over Claude's stale proposal cache.
  // When user starts a new project, types a fresh mascot name, but doesn't
  // re-run Step 1's Generate, proposal.s1.mascot_name still holds the
  // previous project's name. The form field is the ground truth for user
  // intent — surface that first; fall back to Claude's suggestion only if
  // the form is blank.
  const mascotName = stripEmoji(client.mascotName || d.mascot_name || proposal.mascot_name || 'Buddy');
  // S1 lead: keep short — tagline-style. Defaults to industry-flavoured copy.
  const tagline = stripEmoji(d.lead || d.greeting || d.tagline || `The AI coach for ${clientName}`);
  const industry = stripEmoji(client.industry || client.useCase || 'business');

  // Hero card mockups: phone-left + laptop-right. Read from the canonical
  // asset-pack slots first; fall back to per-slide overrides for power users.
  const phoneMock  = mascotImages?.cover_s1_phone  || mascotImages?.cover_s9;
  const laptopMock = mascotImages?.cover_s1_laptop || mascotImages?.cover_s9_laptop;
  // Mascot fallback (when no asset-pack mockups have been generated yet):
  // show the cover mascot in a centered placeholder card so the slide isn't
  // blank pre-asset-pack.
  const coverMascot = mascotImages?.cover_s1 || mascotImages?.cover;

  // Today's date for the right-side slot (matches Finsport reference)
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Build the hero card body. ALWAYS show two distinct placement zones:
  // a portrait phone-shape on the LEFT and a landscape laptop-shape on the
  // RIGHT. Each zone shows its image if pinned, otherwise a labeled
  // placeholder so the user can clearly see where to drop each asset.
  // (Previous version collapsed to one big mascot when neither was pinned —
  // that hid the two-zone layout from users who hadn't run the asset pack
  // yet, which is the exact bug screenshotted.)
  const phoneZoneInner = phoneMock
    ? `<img src="${phoneMock}" alt="Phone Mockup" data-slot-key="cover_s1_phone"
            style="max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center;">`
    : `<div data-slot-key="cover_s1_phone"
            style="width: 100%; height: 100%; max-width: 240px; max-height: 480px; aspect-ratio: 9/19; border: 3px dashed #cbc8b8; border-radius: 28px; background: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: center; color: #9b9788; font-family: 'Poppins',sans-serif; font-size: 15px; font-weight: 600;">Phone mockup</div>`;
  const laptopZoneInner = laptopMock
    ? `<img src="${laptopMock}" alt="Laptop Mockup" data-slot-key="cover_s1_laptop"
            style="max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center;">`
    : `<div data-slot-key="cover_s1_laptop"
            style="width: 100%; height: 100%; max-width: 600px; max-height: 380px; aspect-ratio: 16/10; border: 3px dashed #cbc8b8; border-radius: 16px; background: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: center; color: #9b9788; font-family: 'Poppins',sans-serif; font-size: 15px; font-weight: 600;">Laptop mockup</div>`;
  const heroBody = `
    <div style="display: flex; align-items: center; justify-content: center; gap: 50px; height: 100%; padding: 40px 60px;">
      <div style="flex: 0 0 27%; height: 100%; display: flex; align-items: center; justify-content: center;">
        ${phoneZoneInner}
      </div>
      <div style="flex: 0 0 60%; height: 100%; display: flex; align-items: center; justify-content: center;">
        ${laptopZoneInner}
      </div>
    </div>
  `;

  return `
    <div class="slide" style="background: #FFFFFF; position: relative; display: flex; flex-direction: column; padding: 32px 40px;">
      <!-- Hero card: large rounded light-grey rectangle holding the mockups -->
      <div style="flex: 0 0 auto; height: 540px; background: #F1EFE8; border-radius: 32px; overflow: hidden;">
        ${heroBody}
      </div>

      <!-- Footer 3-column grid: left tagline · middle value-prop · right brand+date -->
      <div style="flex: 1; display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 40px; padding: 32px 16px 0;">
        <!-- Left: client tagline (the headline of the deck) -->
        <div style="font-family: 'Poppins', sans-serif;">
          <div style="font-size: 36px; font-weight: 800; color: #1a1a1a; line-height: 1.15;">${stripEmoji(mascotName)} —</div>
          <div style="font-size: 36px; font-weight: 800; color: #1a1a1a; line-height: 1.15;">The visual AI agent</div>
          <div style="font-size: 22px; font-weight: 600; color: #1a1a1a; line-height: 1.3; margin-top: 4px;">for ${stripEmoji(clientName)}</div>
        </div>

        <!-- Middle: value-prop / service blurb -->
        <div style="font-family: 'Poppins', sans-serif; align-self: center;">
          <div style="font-size: 18px; color: #1a1a1a; line-height: 1.5;">Service, Sales &amp; Support</div>
          <div style="font-size: 18px; color: #1a1a1a; line-height: 1.5;">for every</div>
          <div style="font-size: 18px; font-style: italic; font-weight: 700; color: var(--brand-c1, #1a1a1a); line-height: 1.5;">${industry}</div>
        </div>

        <!-- Right: notso.ai logo + date (matches Finsport "Geldig t/m..." slot) -->
        <div style="font-family: 'Poppins', sans-serif; align-self: center; text-align: right;">
          <div style="display: inline-flex; align-items: center; gap: 10px; margin-bottom: 8px;">
            <div style="width: 32px; height: 32px; border-radius: 8px; background: #1a1a1a; color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 18px;">N</div>
            <div style="font-size: 20px; font-weight: 800; color: #1a1a1a;">notso.ai</div>
          </div>
          <div style="font-size: 13px; color: #6b7280;">Generated ${dateStr}</div>
        </div>
      </div>
    </div>
  `;
}

function renderSlide_S2_TableOfContents(proposal, client, selectedSlides) {
  const slideNames = {
    s1: 'Cover',
    s2: 'Table of Contents',
    s3: 'Pain Points',
    s4: 'Market Opportunity',
    s5: 'Core Features',
    s6: 'Mascot Selection',
    s7: 'Mascot Design',
    s8: 'Personality & Empathy',
    s9: 'Chat Demo',
    s10: 'Chatflow Design',
    s11: 'Knowledge Base',
    s12: 'Data & Insights',
    s13: 'ROI Evidence',
    s14: 'Roadmap',
    s15: 'Pricing',
    s16: 'Promo Materials',
    s17: 'Licensing',
    s18: 'Thank You',
  };

  const allItems = selectedSlides
    .filter(s => s !== 's1' && s !== 's2' && s !== 's18')
    .map((s, idx) => {
      const name = slideNames[s] || s;
      return {
        num: idx + 1,
        title: name.split(' ')[0],
        subtitle: name.substring(name.indexOf(' ') + 1) || name,
      };
    });

  // Limit to 9 items (3x3 grid) to prevent overflow
  const items = allItems.slice(0, 9);
  // If there are more, group remaining into last card
  if (allItems.length > 9) {
    const remaining = allItems.length - 8;
    items[8] = { num: 9, title: `+${remaining} More`, subtitle: 'Sections' };
  }

  const itemCards = items
    .map(item => `
      <div style="background: #F4F0E8; padding: 20px; border-radius: 16px; display: flex; flex-direction: column; justify-content: center;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 18px; font-weight: 700; color: var(--brand-c1); margin-bottom: 8px;">${String(item.num).padStart(2, '0')}</div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 19px; font-weight: 700; color: #1a1a1a; margin-bottom: 4px;">${item.title}</div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">${item.subtitle}</div>
      </div>
    `)
    .join('');

  return `
    <div class="slide" style="background: white; padding: 50px;">
      <!-- Header: Logo + Page Number -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 50px; padding-bottom: 30px; border-bottom: 1px solid #f0f0f0;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 18px; font-weight: 700; color: #1a1a1a;">notso.ai</div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 13px; letter-spacing: 1px; color: #9ca3af; font-weight: 600; text-transform: uppercase;">02 / Client Proposal</div>
      </div>

      <!-- Content: Left Title + Right Grid -->
      <div style="display: flex; gap: 60px;">
        <!-- Left: Section Title -->
        <div style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
          <div style="font-family: 'Poppins', sans-serif; font-size: 13px; letter-spacing: 2px; color: var(--brand-c1); font-weight: 700; text-transform: uppercase; margin-bottom: 16px;">Contents</div>
          <div style="display: flex; gap: 4px; align-items: baseline; margin-bottom: 20px;">
            <div style="font-family: 'Poppins', sans-serif; font-size: 72px; font-weight: 800; line-height: 0.95; color: #1a1a1a;">Table</div>
          </div>
          <div style="display: flex; gap: 4px; align-items: baseline;">
            <div style="font-family: 'Poppins', sans-serif; font-size: 72px; font-weight: 800; line-height: 0.95; color: var(--brand-c1);">of</div>
          </div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 72px; font-weight: 800; line-height: 0.95; color: var(--brand-c1); margin-bottom: 20px;">contents.</div>
          <div style="width: 60px; height: 4px; background: var(--brand-c3); border-radius: 2px;"></div>
        </div>

        <!-- Right: Content Grid (3x3) -->
        <div style="flex: 1.2; display: grid; grid-template-columns: 1fr 1fr 1fr; grid-template-rows: repeat(3, auto); gap: 12px; align-content: start;">
          ${itemCards}
        </div>
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S3_PainPoints(proposal, client, mascotImages) {
  const d = proposal.s3 || {};
  const headline = stripEmoji(d.headline || 'Pain Points');
  const lead = stripEmoji(d.lead || d.intro || '');
  const points = (d.points || []).slice(0, 3);

  // Pain Points slide pairs naturally with the Apologetic expression
  // ("we're sorry your users feel this way…"). cover_s3 lets the user
  // override with any other asset; otherwise we default to expression_4
  // (Apologetic — the 5th expression slot, 0-indexed).
  const mascotImagePath = mascotImages?.cover_s3 || mascotImages?.expression_4;

  const cards = points
    .map((p, i) => {
      const colors = ['var(--brand-c1)', 'var(--brand-c4)', 'var(--brand-c2)'];
      return `
        <div style="background: white; padding: 32px; border-radius: 12px; border-top: 4px solid ${colors[i]}; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <div style="font-family: 'Poppins', sans-serif; font-size: 32px; font-weight: 800; color: ${colors[i]}; margin-bottom: 12px;">${String(i + 1).padStart(2, '0')}</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 12px;">${stripEmoji(p.title || '')}</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 18px; color: #6b7280; line-height: 1.6;">${stripEmoji(p.desc || '')}</div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; border-bottom: 1px solid rgba(0,0,0,0.1); padding-bottom: 30px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Content: 3-column grid -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 40px;">
        ${cards}
      </div>

      <!-- Mascot image area (bottom-right). Defaults to Apologetic expression. -->
      <div style="position: absolute; bottom: 80px; right: 50px; width: 280px; height: 240px; display: flex; align-items: flex-end; justify-content: flex-end;">
        ${getImageHTML(mascotImagePath, 'Apologetic Mascot', 'max-height:100%; max-width:100%; object-fit:contain;', 'cover_s3')}
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S4_MarketOpportunity(proposal, client, mascotImages) {
  const d = proposal.s4 || {};
  const headline = stripEmoji(d.headline || 'Market Opportunity');
  const lead = stripEmoji(d.lead || d.intro || '');
  // Per-slide mascot zone (cover_s4) — defaults to expression_2 (Curious)
  // which matches the "exploring market opportunity" tone. User can
  // override or resize via the transform panel like any other slot.
  const mascotImagePath = mascotImages?.cover_s4 || mascotImages?.expression_2 || mascotImages?.cover;
  // These can be objects {value, label, source} or plain strings
  const getStatValue = (v, fallback) => {
    if (!v) return fallback;
    if (typeof v === 'object') return stripEmoji(String(v.value || fallback));
    return stripEmoji(String(v));
  };
  const industry_size = getStatValue(d.industry_size, '$5.2B');
  const growth_rate = getStatValue(d.growth_rate, '23.5% CAGR');
  const projected_size = getStatValue(d.projected_size, '$12.1B by 2028');

  const statCards = [
    { value: industry_size, label: 'Total Market Size' },
    { value: growth_rate, label: 'Expected Growth' },
    { value: projected_size, label: 'Projected Size' },
  ]
    .map((stat, i) => {
      const colors = ['var(--brand-c1)', 'var(--brand-c4)', 'var(--brand-c2)'];
      return `
        <div style="background: white; padding: 32px; border-radius: 12px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <div style="font-family: 'Poppins', sans-serif; font-size: 36px; font-weight: 800; color: ${colors[i]}; margin-bottom: 12px; line-height: 1;">${stat.value}</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 18px; color: #6b7280; font-weight: 500;">${stat.label}</div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; border-bottom: 1px solid rgba(0,0,0,0.1); padding-bottom: 30px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Stats Grid -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 40px;">
        ${statCards}
      </div>

      <!-- Insight Box -->
      <div style="background: var(--brand-c1-wash); border-left: 4px solid var(--brand-c1); padding: 24px; border-radius: 8px; max-width: 780px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 18px; font-weight: 600; color: var(--brand-c1); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Market Gap</div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #1a1a1a; line-height: 1.6;">
          Notso fills a unique gap by providing AI companions that combine personality, empathy, and intelligence to create genuine user connections.
        </div>
      </div>

      <!-- Mascot image area (bottom-right · resizable via click). Defaults
           to expression_2 (Curious) — fits the "looking at market data"
           tone. User can swap or resize like any other slot. -->
      <div style="position: absolute; bottom: 80px; right: 50px; width: 280px; height: 240px; display: flex; align-items: flex-end; justify-content: flex-end;">
        ${getImageHTML(mascotImagePath, 'Mascot', 'max-height:100%; max-width:100%; object-fit:contain;', 'cover_s4')}
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S5_CoreFeatures(proposal, client) {
  const d = proposal.s5 || {};
  const headline = stripEmoji(d.headline || 'Core Features');
  const lead = stripEmoji(d.lead || d.intro || '');
  const features = (d.features || []).slice(0, 4);
  const colors = ['var(--brand-c1)', 'var(--brand-c2)', 'var(--brand-c4)', 'var(--brand-c1)'];

  const featureCards = features
    .map((f, i) => `
      <div style="background: white; padding: 32px; border-radius: 12px; border-left: 4px solid ${colors[i]}; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
        <div style="font-family: 'Poppins', sans-serif; font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 12px;">${stripEmoji(f.title || '')}</div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 18px; color: #6b7280; line-height: 1.6;">${stripEmoji(f.desc || '')}</div>
      </div>
    `)
    .join('');

  return `
    <div class="slide" style="background: white; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 50px; padding-bottom: 30px; border-bottom: 1px solid #f0f0f0;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Features Grid: 2x2 -->
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin-bottom: 50px;">
        ${featureCards}
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S6_MascotSelection(proposal, client, mascotImages) {
  const d = proposal.s6 || {};
  const headline = stripEmoji(d.headline || 'Mascot Selection');
  const lead = stripEmoji(d.lead || d.intro || '');

  // Build options array. Only render cards for options that have BOTH
  // copy (name/desc) AND a corresponding mascot image. Empty placeholders
  // were confusing — "Image placeholder" shouldn't appear in production.
  const fromArray = Array.isArray(d.options) ? d.options.slice(0, 3) : [];
  const fromObj = [d.option_a, d.option_b, d.option_c].filter(Boolean);
  const merged = fromArray.length ? fromArray : fromObj;
  const optionKeys = ['option_a', 'option_b', 'option_c'];
  const validOptions = [0, 1, 2]
    .map(i => ({ opt: merged[i] || {}, key: optionKeys[i], idx: i }))
    .filter(({ opt, key }) => {
      // Keep if there's an image for this slot OR the user has copy worth showing
      const hasImage = !!mascotImages?.[key];
      const hasCopy = !!(opt.name || opt.desc || opt.description || opt.archetype);
      return hasImage || hasCopy;
    });

  const count = validOptions.length || 1;       // at least one card so the page isn't blank
  const colsClass = count === 1 ? '1fr' : count === 2 ? '1fr 1fr' : '1fr 1fr 1fr';

  // Truncate description to ≤3 sentences. AI prompt asks for ≤2 but enforce
  // server-side so a chatty response doesn't blow up the layout.
  function trimToSentences(text, maxSentences) {
    if (!text) return '';
    const parts = String(text).split(/(?<=[。.!?！?])\s+/);
    return parts.slice(0, maxSentences).join(' ').trim();
  }

  const optionCards = validOptions
    .map(({ opt, key, idx }) => {
      const imagePath = mascotImages?.[key];
      const descText = trimToSentences(stripEmoji(opt.desc || opt.description || ''), 3);
      const nameText = stripEmoji(opt.name || `Option ${String.fromCharCode(65 + idx)}`);
      const archetype = stripEmoji(opt.archetype || '');
      const whyText = stripEmoji(opt.why || '');
      // Cap at 3 traits — keep them on a SINGLE row (nowrap) so the card
      // grid never breaks on a long fourth tag. AI prompt asks for 3 but we
      // hard-truncate here just in case Claude returns extras.
      const traits = Array.isArray(opt.traits) ? opt.traits.slice(0, 3) : [];
      // Tags MUST be centered — the parent card is text-align: center, but
      // we also lock flex centering at the container level so pill widths
      // don't drag the row to one side.
      const traitPills = traits.length ? `
        <div style="display:flex;flex-wrap:nowrap;gap:6px;justify-content:center;align-items:center;width:100%;margin-bottom:14px;overflow:hidden;">
          ${traits.map(t => `<span style="background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:5px 12px;font-size:13px;color:#374151;white-space:nowrap;">${stripEmoji(t)}</span>`).join('')}
        </div>` : '';
      // Font sizes bumped +3px from previous (16→19 name, 11→14 archetype/trait,
      //   12→15 desc, 11→14 why) so cards read at a glance from the back of a room.
      return `
        <div style="background: #F4F4F3; padding: 28px 24px; border-radius: 16px; text-align: center; display:flex; flex-direction:column;">
          <div style="font-family:'Poppins',sans-serif;font-size:19px;font-weight:700;color:#1a1a1a;margin-bottom:4px;">${nameText}</div>
          ${archetype ? `<div style="font-family:'Poppins',sans-serif;font-size:14px;color:var(--brand-c1);font-weight:600;text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px;">${archetype}</div>` : '<div style="margin-bottom:14px;"></div>'}
          <div style="width: 100%; height: ${count === 1 ? '320px' : '240px'}; background: transparent; border-radius: 12px; margin-bottom: 14px; display: flex; align-items: center; justify-content: center; overflow: hidden;">
            ${getImageHTML(imagePath, `Mascot Option ${idx + 1}`, '', key)}
          </div>
          ${traitPills}
          ${descText ? `<div style="font-family:'Poppins',sans-serif;font-size:15px;color:#4b5563;line-height:1.55;margin-bottom:${whyText ? '10px' : '0'};">${descText}</div>` : ''}
          ${whyText ? `<div style="font-family:'Poppins',sans-serif;font-size:14px;color:#1a1a1a;font-style:italic;line-height:1.5;margin-top:auto;padding-top:10px;border-top:1px solid #E5E7EB;">${whyText}</div>` : ''}
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: white; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; padding-bottom: 30px; border-bottom: 1px solid #f0f0f0;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Options Grid: 1 / 2 / 3 cards depending on how many mascots the user actually picked -->
      <div style="display: grid; grid-template-columns: ${colsClass}; gap: 24px; margin-bottom: 50px; max-width: ${count === 1 ? '600px' : count === 2 ? '900px' : 'none'}; margin-left: auto; margin-right: auto;">
        ${optionCards}
      </div>
      <!-- No footer on S6 — the option cards already crowd the slide and
           "Prepared for X" felt redundant when the cover slide says it. -->
    </div>
  `;
}

function renderSlide_S7_MascotDesign(proposal, client, mascotImages) {
  const d = proposal.s7 || {};
  // Same precedence rule as S1: user's form input wins over stale proposal.
  const mascotName = stripEmoji(client.mascotName || d.name || proposal.mascot_name || 'Mascot');
  const personality = stripEmoji(d.personality || d.tone_desc || 'Friendly, helpful, and engaging');
  const phrases = (d.phrases || []).slice(0, 3);
  // Per-slide cover key (cover_s7) — see note in S1.
  const coverImagePath = mascotImages?.cover_s7 || mascotImages?.cover;

  const phrasePills = phrases
    .map(phrase => `
      <div style="background: var(--c1-tint); padding: 10px 16px; border-radius: 20px; border: 1px solid var(--brand-c1); font-family: 'Poppins', sans-serif; font-size: 17px; font-weight: 600; color: var(--brand-c1); white-space: nowrap;">
        "${stripEmoji(phrase)}"
      </div>
    `)
    .join('');

  return `
    <div class="slide" style="background: white; display: flex; gap: 40px; padding: 50px;">
      <!-- Left: Content -->
      <div style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 64px; font-weight: 800; color: #1a1a1a; line-height: 0.95; margin-bottom: 24px;">${mascotName}</div>

        <div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; font-style: italic; margin-bottom: 32px; line-height: 1.6;">${personality}</div>

        ${phrasePills ? `
          <div style="display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 32px;">
            ${phrasePills}
          </div>
        ` : ''}

        <div style="background: var(--brand-c1-wash); border-left: 4px solid var(--brand-c1); padding: 24px; border-radius: 8px;">
          <div style="font-family: 'Poppins', sans-serif; font-size: 16px; font-weight: 700; color: var(--brand-c1); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Character Overview</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 18px; color: #1a1a1a; line-height: 1.6;">${stripEmoji(d.lead || d.description || 'A thoughtful character designed to guide users with empathy and intelligence.')}</div>
        </div>
      </div>

      <!-- Right: Mascot Image -->
      <div style="flex: 1; display: flex; align-items: center; justify-content: center; position: relative;">
        <div style="position: absolute; width: 400px; height: 400px; background: radial-gradient(circle, var(--brand-c1-wash) 0%, transparent 70%); border-radius: 50%; z-index: 0;"></div>
        <div style="position: relative; z-index: 1; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
          ${getImageHTML(coverImagePath, 'Mascot Design', '', 'cover_s7')}
        </div>
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S8_PersonalityEmpathy(proposal, client, mascotImages) {
  const d = proposal.s8 || {};
  const headline = stripEmoji(d.headline || 'Personality & Expressions');
  const lead = stripEmoji(d.lead || d.intro || '');
  const rawExpressions = Array.isArray(d.expressions) ? d.expressions : [];
  const expressions = rawExpressions.slice(0, 6);

  const expressionCards = expressions
    .map((expr, i) => {
      const exprKey = `expression_${i}`;
      const imagePath = mascotImages?.[exprKey];
      const exprName = typeof expr === 'string' ? expr : stripEmoji(String(expr.name || expr.label || expr.emotion || `Expression ${i + 1}`));
      return `
        <div style="text-align: center;">
          <div style="width: 100%; height: 200px; background: #F4F4F3; border-radius: 12px; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; overflow: hidden;">
            ${getImageHTML(imagePath, exprName, '', exprKey)}
          </div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 17px; font-weight: 600; color: #1a1a1a;">${exprName}</div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: #FFFFFF; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; border-bottom: 1px solid rgba(0,0,0,0.08); padding-bottom: 30px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Expressions Grid: 3x2 — slide bg white so gaps don't show grey -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 50px;">
        ${expressionCards}
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

// Cache the phone frame as a data URL so we don't re-read the file every time
// a slide is rendered. The frame is the pre-processed transparent PNG with
// outside + screen both alpha=0; it gets layered ON TOP of the chat content
// so the bezel masks anything that overflows the screen rect.
let _PHONE_FRAME_DATA_URL = null;
function _phoneFrameDataUrl() {
  if (_PHONE_FRAME_DATA_URL) return _PHONE_FRAME_DATA_URL;
  try {
    const fs = require('fs');
    const path = require('path');
    const buf = fs.readFileSync(path.join(__dirname, 'mockup-assets', 'phone-frame.png'));
    _PHONE_FRAME_DATA_URL = 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    _PHONE_FRAME_DATA_URL = '';   // graceful fallback if file missing
  }
  return _PHONE_FRAME_DATA_URL;
}

function renderSlide_S9_ChatDemo(proposal, client, mascotImages) {
  const d = proposal.s9 || {};
  const headline = stripEmoji(d.headline || 'Chat Experience');
  const lead = stripEmoji(d.lead || d.intro || '');
  const messages = (d.messages || d.chat || []).slice(0, 4);

  // Two pre-composed mockup images from the asset pack:
  //   cover_s9        ← mock-phone-chat (Node compositor) — image 2 layout
  //   cover_s9_laptop ← mock-website    (Node compositor) — image 3 layout
  // We render whichever ones are present at full hero size; the inline
  // phone-frame renderer is gone (it always looked cramped at 380px).
  const phoneMockup  = mascotImages?.cover_s9        || null;
  const laptopMockup = mascotImages?.cover_s9_laptop || null;

  // Halo-Support-style chat transcript: each mascot bubble is preceded by a
  // small circular brand-color avatar (with simple eyes + smile), each user
  // bubble has no avatar and is right-aligned. Bubbles use light grey for
  // mascot replies and brand-color for user messages.
  //
  // Hardcode brand color from client.color1 instead of using CSS variable —
  // some preview contexts (notably the Edit & Assign Assets iframe) don't
  // propagate --brand-c1 to nested elements reliably, leaving the avatars
  // looking grey/empty even though the chat bubbles next to them render
  // their brand color correctly. Inline hex is render-context-proof.
  // Also bumped from 36 → 44 px so the eyes/smile are actually visible at
  // the slide's typical display scale.
  const _avBrand = client.color1 || '#DC2626';
  const mascotAvatar = `
    <div style="flex-shrink:0; width:44px; height:44px; border-radius:50%; background:${_avBrand}; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 3px rgba(0,0,0,0.15);">
      <svg viewBox="0 0 44 44" width="28" height="28" xmlns="http://www.w3.org/2000/svg">
        <circle cx="16" cy="18" r="2.5" fill="#fff"/>
        <circle cx="28" cy="18" r="2.5" fill="#fff"/>
        <path d="M14 26 Q22 32 30 26" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      </svg>
    </div>
  `;

  const transcriptBubbles = messages
    .map(msg => {
      const role = msg.sender || msg.role || msg.r || msg.who || '';
      const isUser = role === 'user' || role === 'User' || role === 'u';
      const text = stripEmoji(String(msg.text || msg.message || msg.m || msg.content || '')).trim();
      if (isUser) {
        return `
          <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
            <div style="background:var(--brand-c1, var(--accent)); color:#fff; padding:11px 16px; border-radius:18px 18px 4px 18px; max-width:78%; font-family:'Poppins',sans-serif; font-size:17px; line-height:1.5;">
              ${text}
            </div>
          </div>
        `;
      }
      return `
        <div style="display:flex; justify-content:flex-start; align-items:flex-end; gap:10px; margin-bottom:12px;">
          ${mascotAvatar}
          <div style="background:#F1EFE8; color:#1a1a1a; padding:11px 16px; border-radius:18px 18px 18px 4px; max-width:78%; font-family:'Poppins',sans-serif; font-size:17px; line-height:1.5;">
            ${text}
          </div>
        </div>
      `;
    })
    .join('');

  // Body layout decision tree:
  //   both mockups   → phone left + laptop right (the most informative layout)
  //   phone only     → phone left + transcript right
  //   laptop only    → laptop hero centered
  //   neither        → transcript only (legacy fallback)
  let bodyHtml;
  if (phoneMockup && laptopMockup) {
    // Both — side-by-side phone+laptop. Both get data-slot-key so the
    // transform-controls panel (size/move/rotate/flip) opens on click.
    bodyHtml = `
      <div style="display: flex; gap: 40px; align-items: center; height: 540px;">
        <div style="flex: 1; min-width: 0; height: 100%; display: flex; align-items: center; justify-content: center;">
          <img src="${phoneMockup}" data-slot-key="cover_s9" style="max-height: 100%; max-width: 100%; object-fit: contain; transform-origin: center center;">
        </div>
        <div style="flex: 1.3; min-width: 0; height: 100%; display: flex; align-items: center; justify-content: center;">
          <img src="${laptopMockup}" data-slot-key="cover_s9_laptop" style="max-height: 100%; max-width: 100%; object-fit: contain; transform-origin: center center;">
        </div>
      </div>
    `;
  } else if (phoneMockup) {
    // Phone-only with chat transcript on right (the user's preferred default).
    // The transcript card is centred vertically next to the phone but only as
    // tall as its content (no stretching to 540px → no oversized white block).
    bodyHtml = `
      <div style="display: flex; gap: 40px; align-items: center; height: 540px;">
        <div style="flex-shrink: 0; width: 360px; height: 100%; display: flex; align-items: center; justify-content: center;">
          <img src="${phoneMockup}" data-slot-key="cover_s9" style="max-height: 100%; max-width: 100%; object-fit: contain; transform-origin: center center;">
        </div>
        <div style="flex: 1; min-width: 0; background: #F9F9F9; border-radius: 16px; padding: 24px 26px; display: flex; flex-direction: column; gap: 0;">
          ${transcriptBubbles}
        </div>
      </div>
    `;
  } else if (laptopMockup) {
    bodyHtml = `
      <div style="display: flex; align-items: center; justify-content: center; height: 540px;">
        <img src="${laptopMockup}" data-slot-key="cover_s9_laptop" style="max-height: 100%; max-width: 100%; object-fit: contain; transform-origin: center center;">
      </div>
    `;
  } else {
    bodyHtml = `
      <div style="background: #F9F9F9; border-radius: 16px; padding: 32px; max-width: 80%; margin: 0 auto;">
        ${transcriptBubbles}
      </div>
    `;
  }

  return `
    <div class="slide" style="background: white; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid #f0f0f0;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 12px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.55;">${lead}</div>` : ''}
      </div>

      <!-- Body: phone + laptop mockups (or fallback transcript) -->
      ${bodyHtml}

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S10_ChatflowDesign(proposal, client, mascotImages) {
  const d = proposal.s10 || {};
  const headline = stripEmoji(d.headline || 'Chatflow Design');
  const lead = stripEmoji(d.lead || d.intro || '');
  // Read from stages or flow.columns; filter out empty/legacy entries (no title)
  const rawStages = (d.stages || d.flow?.columns || [])
    .filter(s => s && (s.title || s.stage || s.name));
  const stages = rawStages.slice(0, 4);   // 4 cards lay out best in a row

  // Chatflow Design pairs naturally with the laptop/website mockup
  // ("here's how chat works in your product"). cover_s10 lets the user
  // override; otherwise default to the laptop mockup that's auto-assigned
  // to cover_s9_laptop by the asset pack.
  const laptopImagePath = mascotImages?.cover_s10 || mascotImages?.cover_s9_laptop;

  // Render each stage as a self-contained card with step number, title,
  // description, and a brand-colored arrow connector between siblings.
  const stageNodes = stages
    .map((stage, i) => {
      const title = stripEmoji(stage.title || stage.stage || stage.name || '');
      const desc  = stripEmoji(stage.description || stage.desc || stage.text || '');
      const isLast = i === stages.length - 1;
      return `
        <div style="flex: 1; min-width: 0; display: flex; align-items: stretch; gap: 16px;">
          <div style="flex: 1; min-width: 0; background: white; padding: 24px 22px; border-radius: 14px; border-top: 4px solid var(--brand-c1); box-shadow: 0 2px 12px rgba(0,0,0,0.06); display: flex; flex-direction: column;">
            <div style="font-family: 'Poppins', sans-serif; font-size: 12px; font-weight: 700; color: var(--brand-c1); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">Step ${i + 1}</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 20px; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; line-height: 1.2;">${title}</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: #4b5563; line-height: 1.55;">${desc}</div>
          </div>
          ${isLast ? '' : `
            <div style="flex-shrink: 0; align-self: center; font-family: 'Poppins', sans-serif; font-size: 28px; font-weight: 800; color: var(--brand-c1); user-select: none;">→</div>
          `}
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 36px; padding-bottom: 24px; border-bottom: 1px solid rgba(0,0,0,0.08);">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.55;">${lead}</div>` : ''}
      </div>

      <!-- Flow diagram: 4 cards with arrow connectors -->
      <div style="display: flex; align-items: stretch; gap: 0; margin-bottom: 30px;">
        ${stageNodes}
      </div>

      <!-- Laptop mockup area (bottom-right). Defaults to cover_s9_laptop (the
           composed laptop+chat-widget mockup from the asset pack). Wider
           aspect ratio than the mascot zones to fit the laptop frame. -->
      <div style="position: absolute; bottom: 80px; right: 50px; width: 380px; height: 280px; display: flex; align-items: flex-end; justify-content: flex-end;">
        ${getImageHTML(laptopImagePath, 'Laptop Mockup', 'max-height:100%; max-width:100%; object-fit:contain;', 'cover_s10')}
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S11_KnowledgeBase(proposal, client, mascotImages) {
  const d = proposal.s11 || {};
  const headline = stripEmoji(d.headline || 'Knowledge Base');
  const lead = stripEmoji(d.lead || d.intro || '');
  const categories = (d.categories || []).slice(0, 3);

  // Per-slide cover key (cover_s11) — falls back to shared cover.
  const mascotImagePath = mascotImages?.cover_s11 || mascotImages?.cover;

  // Compact input → output rows. Mascot icon is GONE from the middle —
  // it lives on the right side of the slide as a full-height hero now.
  const categoryRows = categories
    .map((cat, i) => `
      <div style="display: flex; align-items: center; gap: 18px; padding: 24px 26px; background: white; border-radius: 12px; margin-bottom: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
        <div style="flex: 1; min-width: 0;">
          <div style="font-family: 'Poppins', sans-serif; font-size: 15px; font-weight: 700; color: var(--brand-c1); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px;">Input</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 19px; font-weight: 600; color: #1a1a1a; line-height: 1.35;">${stripEmoji(cat.input_label || cat.title || '')}</div>
        </div>
        <div style="flex-shrink: 0; font-family: 'Poppins', sans-serif; font-size: 24px; font-weight: 700; color: var(--brand-c1);">→</div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-family: 'Poppins', sans-serif; font-size: 15px; font-weight: 700; color: var(--brand-c1); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px;">Output</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 19px; font-weight: 600; color: #1a1a1a; line-height: 1.35;">${stripEmoji(cat.output_label || cat.output || '')}</div>
        </div>
      </div>
    `)
    .join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 30px; border-bottom: 1px solid rgba(0,0,0,0.1); padding-bottom: 24px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 12px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Body: input/output rows LEFT, mascot image RIGHT -->
      <div style="display: flex; gap: 36px; align-items: stretch;">
        <!-- Left: 3 input → output rows -->
        <div style="flex: 1.4; min-width: 0;">
          ${categoryRows}
        </div>
        <!-- Right: full-height mascot image area -->
        <div style="flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center;">
          ${getImageHTML(mascotImagePath, 'Mascot', 'max-width:100%; max-height:420px; object-fit:contain;', 'cover_s11')}
        </div>
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S12_DataInsights(proposal, client, mascotImages) {
  const d = proposal.s12 || {};
  const headline = stripEmoji(d.headline || 'Real-Time Dashboard');
  const lead = stripEmoji(d.lead || d.intro || 'Monitor engagement, conversations, and user satisfaction in one centralized dashboard.');
  // Metrics: bullet list on the right side. Each metric becomes a row with
  // a bold label + a one-line description.
  const metrics = Array.isArray(d.metrics || d.badges) ? (d.metrics || d.badges).slice(0, 4) : [];
  // PDF export goes through Puppeteer.setContent() which has no base URL —
  // server-relative paths like "/mockup-assets/dashboard-mockup.png" fail
  // to resolve and the image renders broken in the PDF. Embed it as a
  // data URI so the bytes travel inside the HTML itself. Falls back to the
  // server-relative path if the file isn't found at render time (won't
  // help PDF, but at least live preview keeps working).
  const dashboardSrc = mascotImages?.dashboard ||
    readImageAsDataURI(path.join(__dirname, 'mockup-assets', 'dashboard-mockup.png')) ||
    '/mockup-assets/dashboard-mockup.png';

  const bullets = metrics.map((m, i) => {
    const lbl = typeof m === 'object' ? stripEmoji(String(m.label || m.name || m.value || '')) : stripEmoji(String(m));
    const desc = typeof m === 'object' ? stripEmoji(String(m.desc || m.description || m.value || '')) : '';
    // Don't repeat label as desc if both empty / equal
    const showDesc = desc && desc !== lbl;
    return `
      <li style="margin-bottom: 18px; display: flex; gap: 12px; align-items: baseline;">
        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--brand-c1); flex-shrink:0; transform: translateY(2px);"></span>
        <div style="flex:1; line-height:1.55;">
          <span style="font-family: 'Poppins', sans-serif; font-size: 19px; font-weight: 700; color: #1a1a1a;">${lbl}${showDesc ? ': ' : ''}</span>
          ${showDesc ? `<span style="font-family: 'Poppins', sans-serif; font-size: 19px; color: #4b5563;">${desc}</span>` : ''}
        </div>
      </li>
    `;
  }).join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 50px; display: flex; flex-direction: column; overflow: hidden;">
      <!-- Header -->
      <div style="margin-bottom: 28px; padding-bottom: 18px; border-bottom: 1px solid rgba(0,0,0,0.08);">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 10px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 90%; line-height: 1.5;">${lead}</div>` : ''}
      </div>

      <!-- Body: image LEFT, bullet list RIGHT -->
      <div style="flex: 1; display: flex; gap: 40px; align-items: stretch; min-height: 0;">
        <!-- Left: dashboard mockup -->
        <div style="flex: 1.1; display: flex; align-items: center; justify-content: center; min-width: 0;">
          <img src="${dashboardSrc}" alt="Real-Time Dashboard" data-slot-key="dashboard"
               style="max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; border-radius: 12px; transform-origin: center center;">
        </div>
        <!-- Right: bulleted metric list -->
        <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; min-width: 0;">
          <ul style="list-style: none; margin: 0; padding: 0;">
            ${bullets}
          </ul>
        </div>
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 30px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S13_ROIEvidence(proposal, client) {
  const d = proposal.s13 || {};
  const headline = stripEmoji(d.headline || 'ROI Evidence');
  const lead = stripEmoji(d.lead || d.intro || '');
  const rawStats = Array.isArray(d.stats) ? d.stats : [];
  const stats = rawStats.slice(0, 4);

  const statCards = stats
    .map((stat, i) => {
      const colors = ['var(--brand-c1)', 'var(--brand-c4)', 'var(--brand-c2)', 'var(--brand-c1)'];
      const val = typeof stat === 'object' ? stripEmoji(String(stat.n || stat.value || stat.v || stat.number || 'N/A')) : stripEmoji(String(stat));
      const lbl = typeof stat === 'object' ? stripEmoji(String(stat.l || stat.label || stat.name || '')) : '';
      return `
        <div style="background: white; padding: 28px; border-radius: 12px; text-align: center; border-top: 4px solid ${colors[i]}; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <div style="font-family: 'Poppins', sans-serif; font-size: 32px; font-weight: 800; color: ${colors[i]}; margin-bottom: 8px; line-height: 1;">${val}</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 17px; color: #6b7280; font-weight: 500;">${lbl}</div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; border-bottom: 1px solid rgba(0,0,0,0.1); padding-bottom: 30px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Stats Grid: 4 columns -->
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 40px;">
        ${statCards}
      </div>

      <!-- Before/After Comparison -->
      ${(() => {
        const ba = d.ba || {};
        let rows = ba.rows || [];
        if (!rows.length && (ba.before || ba.after)) {
          const bList = Array.isArray(ba.before) ? ba.before : [];
          const aList = Array.isArray(ba.after) ? ba.after : [];
          const labels = Array.isArray(ba.labels) ? ba.labels : [];
          for (let i = 0; i < Math.min(bList.length, aList.length, 3); i++) {
            rows.push({ label: labels[i] || '', before: bList[i], after: aList[i] });
          }
        }
        if (rows.length > 0) {
          return `<div style="background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
            <div style="display: grid; grid-template-columns: 1.2fr 2fr 0.3fr 2fr; padding: 12px 20px; background: #f8f8f8; font-family: 'Poppins', sans-serif; font-size: 16px; font-weight: 700; color: #6b7280;">
              <div></div><div style="color: var(--brand-c2); text-align: center;">Before</div><div></div><div style="color: var(--brand-c1); text-align: center;">After notso.ai</div>
            </div>
            ${rows.slice(0, 3).map(r => `<div style="display: grid; grid-template-columns: 1.2fr 2fr 0.3fr 2fr; padding: 10px 20px; border-top: 1px solid #f0f0f0; align-items: center;">
              <div style="font-family: 'Poppins', sans-serif; font-size: 13px; font-weight: 600; color: #1a1a1a;">${stripEmoji(String(r.label || ''))}</div>
              <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: #6b7280; text-align: center;">${stripEmoji(String(r.before || ''))}</div>
              <div style="text-align: center; font-size: 18px; color: var(--brand-c1);">→</div>
              <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: var(--brand-c1); font-weight: 600; text-align: center;">${stripEmoji(String(r.after || ''))}</div>
            </div>`).join('')}
          </div>`;
        }
        // Fallback: simple before/after cards
        const beforeText = stripEmoji(String(d.before || 'Manual processes and limited personalization'));
        const afterText = stripEmoji(String(d.after || 'AI-powered automation and tailored experiences'));
        return `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
          <div style="background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
            <div style="font-family: 'Poppins', sans-serif; font-size: 18px; font-weight: 700; color: var(--brand-c2); margin-bottom: 12px;">Before</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 17px; color: #6b7280; line-height: 1.5;">${beforeText}</div>
          </div>
          <div style="background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
            <div style="font-family: 'Poppins', sans-serif; font-size: 18px; font-weight: 700; color: var(--brand-c1); margin-bottom: 12px;">After</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 17px; color: #6b7280; line-height: 1.5;">${afterText}</div>
          </div>
        </div>`;
      })()}

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S14_Roadmap(proposal, client, mascotImages) {
  const d = proposal.s14 || {};
  const headline = stripEmoji(d.headline || 'Roadmap');
  const lead = stripEmoji(d.lead || d.intro || '');
  const rawMilestones = Array.isArray(d.milestones) ? d.milestones : Array.isArray(d.phases) ? d.phases : [];
  const milestones = rawMilestones.slice(0, 5);

  // Per-slide mascot key (cover_s14) — falls back to shared cover. Renders
  // bottom-right under the phase cards as a friendly accent so the lower
  // half of the slide isn't dead space.
  const mascotImagePath = mascotImages?.cover_s14 || mascotImages?.cover;

  const phaseColors = ['var(--brand-c1)', 'var(--brand-c3)', 'var(--brand-c1)', 'var(--brand-c2)', 'var(--brand-c5)'];
  const timelineItems = milestones
    .map((ms, i) => {
      const title = stripEmoji(String(ms.title || ms.phase || ms.name || `Phase ${i + 1}`));
      const desc = stripEmoji(String(ms.description || ms.desc || ms.details || ''));
      const time = stripEmoji(String(ms.time || ms.timeline || ms.duration || ms.when || ''));
      return `
        <div style="flex: 1; position: relative;">
          <div style="background: white; padding: 24px; border-radius: 12px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.05); border-top: 3px solid ${phaseColors[i] || 'var(--brand-c1)'};">
            ${time ? `<div style="font-family: 'Poppins', sans-serif; font-size: 13px; font-weight: 600; color: #9ca3af; margin-bottom: 6px;">${time}</div>` : ''}
            <div style="font-family: 'Poppins', sans-serif; font-size: 16px; font-weight: 700; color: var(--brand-c1); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Phase ${i + 1}</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 19px; font-weight: 700; color: #1a1a1a; margin-bottom: 12px;">${title}</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: #6b7280; line-height: 1.5;">${desc}</div>
          </div>
          ${i < milestones.length - 1 ? '<div style="position: absolute; right: -10px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; background: var(--brand-c1); border-radius: 50%; border: 3px solid #F4F4F3;"></div>' : ''}
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; border-bottom: 1px solid rgba(0,0,0,0.1); padding-bottom: 30px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Timeline -->
      <div style="display: flex; gap: 16px; margin-bottom: 30px; position: relative;">
        <div style="position: absolute; top: 50%; left: 0; right: 0; height: 2px; background: var(--brand-c1); z-index: 0;"></div>
        <div style="display: flex; gap: 16px; width: 100%; position: relative; z-index: 1;">
          ${timelineItems}
        </div>
      </div>

      <!-- Mascot image area (bottom-right). Per-slide cover_s14 key, falls
           back to the shared cover. Sits below the timeline so it doesn't
           crowd the phase cards. -->
      <div style="position: absolute; bottom: 90px; right: 50px; width: 320px; height: 280px; display: flex; align-items: flex-end; justify-content: flex-end;">
        ${getImageHTML(mascotImagePath, 'Mascot', 'max-height:100%; max-width:100%; object-fit:contain;', 'cover_s14')}
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S15_Pricing(proposal, client) {
  // Fixed pricing data (immutable)
  const FIXED_PRICING_TIERS = [
    {
      name: 'Starter',
      price: '€399,-',
      users: '1,000 unique users',
      journeys: '3,000 conversations',
      features: ['1 Journey', 'Basic custom character design', 'Knowledge Base: up to 3 pages', 'Media Pack: 10 images + 5 videos', 'Basic Analytics Portal', 'Email support (24-hour response)'],
    },
    {
      name: 'Premium',
      price: '€699,-',
      users: '2,000 unique users',
      journeys: '6,000 conversations',
      features: ['2 Journeys', 'Premium character design', 'Knowledge Base: up to 10 pages', 'Media Pack: 25 images + 10 videos', 'Premium Analytics Portal', 'Same-day email & phone support'],
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      users: 'Unlimited users',
      journeys: 'Unlimited conversations',
      features: ['Unlimited journeys', 'Tailor-made character design', 'API Access / Integrations', 'Unlimited media & branding content', 'Custom Analytics Portal', '24/7 support + dedicated account manager'],
    },
  ];

  const FIXED_PRICING_ADDONS = [
    { name: 'Extra Character Design', price: '+ €142 / month', desc: 'Add one additional character design to your tier.' },
    { name: 'Extra Journey Slot', price: '+ €96 / month', desc: 'Add one additional customer/client/event journey.' },
    { name: 'Partner License', price: '+ €149 / month per licence', desc: 'Sell the service under your brand ("Notso Powered").' },
    { name: 'Whitelabel License', price: '+ €349 / month per licence', desc: 'Fully rebrand the platform as your own (no Notso branding).' },
  ];

  const d = proposal.s15 || {};
  const headline = stripEmoji(d.headline || 'Pricing');
  // Pricing lead is the ONE sentence the buyer skims before reading the
  // tier cards. Trim to first sentence so it doesn't wall-of-text.
  const rawLead = stripEmoji(d.lead || d.reasoning || 'Flexible plans that scale with your needs');
  const lead = (rawLead.split(/(?<=[。.!?！?])\s+/)[0] || rawLead).trim();

  const tierCards = FIXED_PRICING_TIERS.map((tier, i) => {
    const colors = ['var(--brand-c1)', 'var(--brand-c4)', 'var(--brand-c2)'];
    // No "RECOMMENDED" tag — different clients fit different tiers, AI writes
    // per-client reasoning in d.reasoning instead.
    const isHighlight = false;
    return `
      <div style="background: white; padding: 22px 22px; border-radius: 12px; border: 1px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0,0,0,0.05); position: relative;">

        <div style="font-family: 'Poppins', sans-serif; font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 6px;">${tier.name}</div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 30px; font-weight: 800; color: ${colors[i]}; margin-bottom: 4px; line-height: 1;">${tier.price}</div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 14px; color: #6b7280; margin-bottom: 10px; border-bottom: 1px solid #f0f0f0; padding-bottom: 10px; line-height: 1.45;">
          ${tier.users} · ${tier.journeys}
        </div>
        <ul style="list-style: none; margin: 0; padding: 0; font-family: 'Poppins', sans-serif; font-size: 15px; color: #4b5563; line-height: 1.5;">
          ${tier.features.map(f => `<li style="margin-bottom: 3px;">✓ ${stripEmoji(f)}</li>`).join('')}
        </ul>
      </div>
    `;
  }).join('');

  // Add-ons: ALWAYS single-column full-width rows (1fr, NOT 1fr 1fr).
  // The 2-column layout on a 1440-wide slide pushes content past the
  // page edge. Single column keeps every row inside the safe area.
  const addonCards = FIXED_PRICING_ADDONS.map(addon => `
    <div style="display: flex; align-items: center; gap: 14px; background: white; padding: 9px 18px; border-radius: 10px; border: 1px solid #f0f0f0;">
      <div style="flex: 1; min-width: 0;">
        <span style="font-family: 'Poppins', sans-serif; font-size: 15px; font-weight: 700; color: #1a1a1a;">${stripEmoji(addon.name)}</span>
        <span style="font-family: 'Poppins', sans-serif; font-size: 14px; color: #6b7280;"> — ${stripEmoji(addon.desc)}</span>
      </div>
      <div style="font-family: 'Poppins', sans-serif; font-size: 15px; font-weight: 700; color: var(--brand-c1); white-space: nowrap;">${stripEmoji(addon.price)}</div>
    </div>
  `).join('');

  return `
    <div class="slide" style="background: #F4F4F3; padding: 36px 50px 40px; overflow: hidden;">
      <!-- Header — slim version so the tier cards + add-ons fit in 810px. -->
      <div style="margin-bottom: 16px; border-bottom: 1px solid rgba(0,0,0,0.1); padding-bottom: 12px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 44px; font-weight: 800; color: #1a1a1a; margin-bottom: 8px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 18px; color: #6b7280; max-width: 78%; line-height: 1.5;">${lead}</div>` : ''}
      </div>

      <!-- Pricing Tiers: 3 columns -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 14px;">
        ${tierCards}
      </div>

      <!-- Add-ons Section: full-width single-column rows -->
      <div>
        <div style="font-family: 'Poppins', sans-serif; font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 8px;">Add-ons</div>
        <div style="display: grid; grid-template-columns: 1fr; gap: 6px;">
          ${addonCards}
        </div>
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 30px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S16_PromoMaterials(proposal, client, mascotImages) {
  const d = proposal.s16 || {};
  const headline = stripEmoji(d.headline || 'Promotional Materials');
  const lead = stripEmoji(d.lead || d.intro || '');
  const materials = (d.materials || []).slice(0, 3);

  const materialCards = materials
    .map((mat, i) => {
      const matKey = `material_${i}`;
      const imagePath = mascotImages?.[matKey];
      // Slot is SQUARE (1:1) — Gemini natively returns square images so we
      // match that aspect to avoid any cropping or letter-boxing. When no
      // image is available yet, the slot shows a dashed placeholder; once
      // the image is pinned, the dashed border + flex-centring are removed
      // and the square image fills the slot edge-to-edge.
      //
      // We build the <img> tag directly here instead of going through
      // getImageHTML — that helper hard-codes object-fit:contain which
      // would re-introduce white margins inside the square slot.
      const dataURI = imagePath ? readImageAsDataURI(imagePath) : null;
      const slotStyle = dataURI
        ? 'width:100%; aspect-ratio:1/1; background:#F4F4F3; border-radius:8px; margin-bottom:14px; overflow:hidden;'
        : 'width:100%; aspect-ratio:1/1; background:#F4F4F3; border-radius:8px; margin-bottom:14px; display:flex; align-items:center; justify-content:center; border:2px dashed #d1d5db; overflow:hidden;';
      const slotInner = dataURI
        ? `<img src="${dataURI}" alt="Promo Material ${i + 1}" data-slot-key="${matKey}" style="width:100%; height:100%; object-fit:cover; display:block; transform-origin:center center;" />`
        : `<div class="image-placeholder" data-slot-key="${matKey}"><div style="text-align:center; color:#d1d5db; font-size:17px; padding:20px;">[Image placeholder]</div></div>`;
      return `
        <div style="background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <div style="font-family: 'Poppins', sans-serif; font-size: 20px; font-weight: 700; color: #1a1a1a; margin-bottom: 16px;">${stripEmoji(mat.name || `Material ${i + 1}`)}</div>
          <div style="${slotStyle}">
            ${slotInner}
          </div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 17px; color: #6b7280; line-height: 1.6;">${stripEmoji(mat.description || '')}</div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: white; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; padding-bottom: 30px; border-bottom: 1px solid #f0f0f0;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Materials Grid: 3 columns -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 50px;">
        ${materialCards}
      </div>

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S17_Licensing(proposal, client) {
  const d = proposal.s17 || {};
  const headline = stripEmoji(d.headline || 'Licensing');
  const lead = stripEmoji(d.lead || d.intro || '');
  const rawCards = Array.isArray(d.cards) ? d.cards : Array.isArray(d.licenses) ? d.licenses : [];
  const cards = rawCards.slice(0, 4);
  const note = stripEmoji(d.note || '');

  const licenseCards = cards
    .map((lic, i) => {
      const colors = ['var(--brand-c1)', 'var(--brand-c2)', 'var(--brand-c4)', 'var(--brand-c1)'];
      const name = stripEmoji(String(lic.name || lic.title || `License ${i + 1}`));
      const desc = stripEmoji(String(lic.description || lic.desc || lic.details || 'Details to be confirmed'));
      const terms = lic.terms || lic.term || '';
      return `
        <div style="background: white; padding: 28px; border-radius: 12px; border-left: 4px solid ${colors[i]}; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <div style="font-family: 'Poppins', sans-serif; font-size: 20px; font-weight: 700; color: #1a1a1a; margin-bottom: 12px;">${name}</div>
          <div style="font-family: 'Poppins', sans-serif; font-size: 18px; color: #6b7280; line-height: 1.6; margin-bottom: 12px;">${desc}</div>
          ${terms ? `<div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: var(--brand-c1); font-weight: 600;">${stripEmoji(String(terms))}</div>` : ''}
        </div>
      `;
    })
    .join('');

  return `
    <div class="slide" style="background: #FFFFFF; padding: 50px;">
      <!-- Header -->
      <div style="margin-bottom: 40px; border-bottom: 1px solid rgba(0,0,0,0.08); padding-bottom: 30px;">
        <div style="font-family: 'Poppins', sans-serif; font-size: 48px; font-weight: 800; color: #1a1a1a; margin-bottom: 16px;">${headline}</div>
        ${lead ? `<div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: #6b7280; max-width: 70%; line-height: 1.6;">${lead}</div>` : ''}
      </div>

      <!-- Licenses Grid: 2x2 — slide bg white so gaps don't show grey -->
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin-bottom: 40px;">
        ${licenseCards}
      </div>

      <!-- Note -->
      ${note ? `
        <div style="background: var(--brand-c2-wash); border-left: 4px solid var(--brand-c2); padding: 24px; border-radius: 8px;">
          <div style="font-family: 'Poppins', sans-serif; font-size: 17px; color: #1a1a1a; line-height: 1.6;">${note}</div>
        </div>
      ` : ''}

      <!-- Footer -->
      <div style="position: absolute; bottom: 40px; left: 50px; font-family: 'Poppins', sans-serif; font-size: 16px; color: #9ca3af;">
        Prepared for ${stripEmoji(client.name)} · by notso.ai
      </div>
    </div>
  `;
}

function renderSlide_S18_ThankYou(proposal, client, mascotImages) {
  const d = proposal.s18 || {};
  const closingTitle = stripEmoji(d.closing_title || d.headline || 'Thank');
  const lead = stripEmoji(d.lead || d.closing || 'Let\'s build something amazing together.');
  const phone = stripEmoji(d.phone || '+31 6 34 197 668');
  const email = stripEmoji(d.email || 'hello@notso.ai');
  const website = stripEmoji(d.website || 'www.notso.ai');

  // S18 Thank You: two overlapping mockup zones on the LEFT — a landscape
  // laptop sitting behind and a portrait phone overlapping its lower-left
  // corner (matches the demo earlier in the conversation). Each zone has
  // its own slot key so the user can pin two distinct images.
  // cover_s18 (the legacy single-image slot) still works as a fallback for
  // power users who explicitly pin to it.
  const phoneMockS18  = mascotImages?.cover_s18_phone  || mascotImages?.cover_s9;
  const laptopMockS18 = mascotImages?.cover_s18_laptop || mascotImages?.cover_s9_laptop;
  const coverImagePath = mascotImages?.cover_s18 || mascotImages?.cover;

  // Brand color wiring — color1 drives the gradient, color2 is the accent.
  // If the client didn't provide colors, fall back to notso green+yellow.
  const c1 = client.color1 || '#1a5c4a';
  const c2 = client.color2 || '#F5D547';
  // Derive a deeper shade of c1 for the gradient's bottom-right stop.
  const deeperC1 = (() => {
    const h = c1.replace('#','');
    if (h.length !== 6) return '#0f3d2e';
    const r = Math.max(0, parseInt(h.slice(0,2),16) - 40);
    const g = Math.max(0, parseInt(h.slice(2,4),16) - 40);
    const b = Math.max(0, parseInt(h.slice(4,6),16) - 40);
    return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
  })();

  return `
    <div class="slide" style="background: linear-gradient(135deg, ${c1} 0%, ${deeperC1} 100%); position: relative; display: flex; gap: 60px; align-items: stretch;">
      <!-- Left: Two overlapping mockup zones (laptop behind, phone overlapping) -->
      <div style="flex: 1; display: flex; align-items: center; justify-content: center; position: relative; padding: 40px;">
        <div style="position: absolute; width: 500px; height: 500px; background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 70%); border-radius: 50%; z-index: 0;"></div>
        <!-- Stage box gives both zones a stable coordinate system to overlap inside -->
        <div style="position: relative; z-index: 1; width: 100%; height: 100%; max-width: 560px; max-height: 460px;">
          <!-- Laptop zone — landscape, fills upper-right of the stage -->
          <div style="position: absolute; right: 0; top: 8%; width: 78%; height: 60%; display: flex; align-items: center; justify-content: center;">
            ${laptopMockS18
              ? `<img src="${laptopMockS18}" alt="Laptop Mockup" data-slot-key="cover_s18_laptop"
                       style="max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center;">`
              : `<div data-slot-key="cover_s18_laptop"
                      style="width: 100%; height: 100%; border: 3px dashed rgba(255,255,255,0.55); border-radius: 14px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.75); font-family: 'Poppins',sans-serif; font-size: 14px; font-weight: 600;">Laptop mockup</div>`}
          </div>
          <!-- Phone zone — portrait, overlaps the lower-left of the laptop -->
          <div style="position: absolute; left: 0; bottom: 0; width: 32%; height: 80%; display: flex; align-items: center; justify-content: center; z-index: 2;">
            ${phoneMockS18
              ? `<img src="${phoneMockS18}" alt="Phone Mockup" data-slot-key="cover_s18_phone"
                       style="max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center; filter: drop-shadow(0 12px 24px rgba(0,0,0,0.3));">`
              : `<div data-slot-key="cover_s18_phone"
                      style="width: 100%; height: 100%; border: 3px dashed rgba(255,255,255,0.55); border-radius: 24px; background: rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.75); font-family: 'Poppins',sans-serif; font-size: 14px; font-weight: 600;">Phone mockup</div>`}
          </div>
        </div>
      </div>

      <!-- Right: Content -->
      <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 50px 50px 50px 20px;">
        <!-- notso.ai logo -->
        <div style="font-family: 'Poppins', sans-serif; font-size: 18px; font-weight: 700; color: white; margin-bottom: 40px;">notso.ai</div>

        <!-- Title: AI-written punchy CTA — no hardcoded "you!" tail.
             The AI's closing_title IS the full punch line; appending "you!"
             below it produced "Ready to bring Yaz to life?\nyou!" garbage. -->
        <div style="margin-bottom: 24px;">
          <div style="font-family: 'Poppins', sans-serif; font-size: 90px; font-weight: 800; line-height: 0.98; color: white; margin: 0;">${closingTitle}</div>
        </div>

        <!-- Message -->
        <div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: rgba(255,255,255,0.7); line-height: 1.6; margin-bottom: 40px; max-width: 90%;">
          ${lead}
        </div>

        <!-- Contact Grid: 2x2 -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15);">
            <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: ${c2}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Email</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: white; font-weight: 600;">${email}</div>
          </div>
          <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15);">
            <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: ${c2}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Phone</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: white; font-weight: 600;">${phone}</div>
          </div>
          <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15);">
            <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: ${c2}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Web</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: white; font-weight: 600;">${website}</div>
          </div>
          <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15);">
            <div style="font-family: 'Poppins', sans-serif; font-size: 16px; color: ${c2}; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Office</div>
            <div style="font-family: 'Poppins', sans-serif; font-size: 20px; color: white; font-weight: 600;">Amsterdam, NL</div>
          </div>
        </div>
      </div>

      <!-- Decorative color strip -->
      <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: ${c2};"></div>
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Slide Renderer
// ═════════════════════════════════════════════════════════════════════════════

function renderSlide(slideId, proposal, client, mascotImages) {
  const renderFunctions = {
    s1: () => renderSlide_S1_Cover(proposal, client, mascotImages),
    s2: (selected) => renderSlide_S2_TableOfContents(proposal, client, selected),
    s3: () => renderSlide_S3_PainPoints(proposal, client, mascotImages),
    s4: () => renderSlide_S4_MarketOpportunity(proposal, client, mascotImages),
    s5: () => renderSlide_S5_CoreFeatures(proposal, client),
    s6: () => renderSlide_S6_MascotSelection(proposal, client, mascotImages),
    s7: () => renderSlide_S7_MascotDesign(proposal, client, mascotImages),
    s8: () => renderSlide_S8_PersonalityEmpathy(proposal, client, mascotImages),
    s9: () => renderSlide_S9_ChatDemo(proposal, client, mascotImages),
    s10: () => renderSlide_S10_ChatflowDesign(proposal, client, mascotImages),
    s11: () => renderSlide_S11_KnowledgeBase(proposal, client, mascotImages),
    s12: () => renderSlide_S12_DataInsights(proposal, client, mascotImages),
    s13: () => renderSlide_S13_ROIEvidence(proposal, client),
    s14: () => renderSlide_S14_Roadmap(proposal, client, mascotImages),
    s15: () => renderSlide_S15_Pricing(proposal, client),
    s16: () => renderSlide_S16_PromoMaterials(proposal, client, mascotImages),
    s17: () => renderSlide_S17_Licensing(proposal, client),
    s18: () => renderSlide_S18_ThankYou(proposal, client, mascotImages),
  };

  const renderFunc = renderFunctions[slideId];
  if (!renderFunc) return '';

  try {
    const html = (slideId === 's2')
      ? renderFunc(proposal._selected_slides || [])
      : renderFunc();
    // Tag every slide with its id so the client-side unified editor can
    // map the DOM slide back to its slot definitions (cover_s1, option_a,
    // expression_0, etc.). We inject into the outermost `.slide` div.
    // Purely additive — everything else (PDF export, legacy preview)
    // is oblivious to the attribute.
    return html.replace(
      /<div([^>]*class="[^"]*\bslide\b[^"]*"[^>]*)>/,
      (m, attrs) => `<div${attrs} data-slide-id="${slideId}">`
    );
  } catch (err) {
    console.error(`Error rendering slide ${slideId}:`, err.message);
    return `<div class="slide" data-slide-id="${slideId}" style="display:flex;align-items:center;justify-content:center;background:#fff;">
      <p style="color:red;font-size:24px;">Error rendering slide ${slideId}: ${err.message}</p>
    </div>`;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PDF Generation with Puppeteer
// ═════════════════════════════════════════════════════════════════════════════

// ─── Puppeteer launch (dual local/Vercel) ──────────────────────────────
// On Vercel we use puppeteer-core + @sparticuz/chromium (small, optimised
// for AWS Lambda). Locally we use the full `puppeteer` which ships its
// own Chromium so developers don't have to install anything.
async function launchBrowser() {
  const isVercel = !!process.env.VERCEL;
  if (isVercel) {
    // @sparticuz/chromium-min gates the al2/al2023 shared-library extraction
    // behind `AWS_EXECUTION_ENV` (see helper.js — it only treats us as a
    // Lambda when that var contains "AWS_Lambda_nodejs…"). Vercel sets its
    // own `VERCEL=1` but NOT that AWS var, so without this nudge chromium-min
    // skips unpacking libnss3.so and the browser crashes at launch.
    // Safe to set unconditionally on Vercel — we ARE on Lambda underneath.
    if (!process.env.AWS_EXECUTION_ENV) {
      process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
    }
    // Use @sparticuz/chromium-min: binary is streamed from GitHub Release at
    // runtime, so the Lambda function stays well under Vercel's 50MB limit.
    // Version MUST match the installed @sparticuz/chromium-min version.
    const chromium = require('@sparticuz/chromium-min');
    const puppeteerCore = require('puppeteer-core');
    const CHROMIUM_URL =
      process.env.CHROMIUM_URL ||
      'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';
    return puppeteerCore.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport || { width: 1440, height: 810 },
      executablePath: await chromium.executablePath(CHROMIUM_URL),
      headless: chromium.headless,
    });
  }
  if (!puppeteer) puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
}

async function generatePDF(html, outputPath) {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 810 });

    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await new Promise(r => setTimeout(r, 2000));

    await page.pdf({
      path: outputPath,
      width: '1440px',
      height: '810px',
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true,
      preferCSSPageSize: true,
    });

    console.error(`PDF generated: ${outputPath}`);
  } finally {
    await browser.close();
  }
}

// Return PDF as an in-memory Buffer (no file on disk). Used by the Vercel
// serverless entry where /tmp exists but we'd rather stream bytes back.
async function generatePDFBuffer(html) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 810 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    const buf = await page.pdf({
      width: '1440px',
      height: '810px',
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(buf);
  } finally {
    await browser.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Entry Point
// ═════════════════════════════════════════════════════════════════════════════

// Global uncaught error handler — ensures JSON output even on unexpected crashes
process.on('uncaughtException', (err) => {
  console.log(JSON.stringify({ success: false, error: 'Uncaught: ' + (err.message || String(err)) }));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.log(JSON.stringify({ success: false, error: 'Unhandled: ' + (err?.message || String(err)) }));
  process.exit(1);
});

// Build the full slide-deck HTML string from the raw proposal data.
// Exported so the Vercel serverless path can skip the CLI entirely.
function buildProposalHtml(data) {
  const { proposal, client, selected_slides } = data;

  if (!proposal._selected_slides) {
    proposal._selected_slides = selected_slides || ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12', 's13', 's14', 's15', 's16', 's17', 's18'];
  }

  const mascotImages = proposal._mascot_images || {};

  const allSlides = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','s12','s13','s14','s15','s16','s17','s18'];
  const slidesToRender = (selected_slides && selected_slides.length > 0) ? selected_slides : allSlides;
  const slides = slidesToRender
    .map(slideId => renderSlide(slideId, proposal, client, mascotImages))
    .filter(html => html.length > 0)
    .join('\n');

  const brandCSS = buildBrandCSS(client);
  const variantCSS = buildStyleVariantCSS();
  const textLayerCSS = buildTextAndContrastLayerCSS(client);
  const ds = (client && client.designStyle) || 'notso-signature';
  // Canvas mode controls the slide canvas behavior:
  //   white  — default per-design-style background (current legacy behaviour)
  //   brand  — full var(--brand-c1) on every slide (immersive)
  //   hybrid — first + last slide brand, middle slides white
  const canvasMode = (client && client.canvasMode) || 'white';

  return `<!DOCTYPE html>
<html lang="en" data-design-style="${ds}" data-canvas-mode="${canvasMode}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${stripEmoji(client.name || 'Proposal')} - Notso Proposal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Poppins', sans-serif;
      background: #fff;
    }

    .slides-container {
      display: flex;
      flex-direction: column;
    }

    * { box-sizing: border-box; }
    .slide {
      width: 1440px;
      height: 810px;
      page-break-after: always;
      break-after: page;
      position: relative;
      overflow: hidden !important;
    }

    ${brandCSS}
    ${variantCSS}
    ${textLayerCSS}

    @media print {
      .slide {
        margin: 0;
        padding: 0;
      }
    }
  </style>
  <!-- Auto-contrast: compute --text-on-cN per brand color via WCAG luminance -->
  <script>
  (function() {
    const luminance = hex => {
      if (!hex) return 1;
      hex = String(hex).replace('#','');
      if (hex.length === 3) hex = [...hex].map(c=>c+c).join('');
      if (hex.length !== 6) return 1;
      const [r,g,b] = [hex.slice(0,2), hex.slice(2,4), hex.slice(4,6)]
        .map(s => parseInt(s,16)/255)
        .map(c => c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4));
      return 0.2126*r + 0.7152*g + 0.0722*b;
    };
    const safeText = bg => luminance(bg) > 0.18 ? '#1a1a1a' : '#ffffff';
    const root = document.documentElement;
    const css = getComputedStyle(root);
    ['c1','c2','c3','c4'].forEach(k => {
      const v = (css.getPropertyValue('--brand-' + k) || '').trim();
      if (v) root.style.setProperty('--text-on-' + k, safeText(v));
    });
  })();
  </script>
</head>
<body data-design-style="${ds}" data-canvas-mode="${canvasMode}">
  <div class="slides-container" data-design-style="${ds}">
    ${slides}
  </div>
</body>
</html>`;
}

// Export for in-process use (Vercel serverless / server.js import).
module.exports = {
  buildProposalHtml,
  generatePDF,         // writes to a file path
  generatePDFBuffer,   // returns Buffer (preferred for serverless)
  launchBrowser,       // shared puppeteer launcher (used by mockup_compose.js)
};

// ───────── CLI mode (only when run directly: `node generate_html.js`) ─────────
if (require.main === module) {
  let inputData = '';

  process.stdin.on('data', chunk => {
    inputData += chunk;
  });

  process.stdin.on('end', async () => {
    try {
      const data = JSON.parse(inputData);
      const { client, format } = data;
      const html = buildProposalHtml(data);

      const outputDir = data.output_dir || require('os').tmpdir();
      const safeName = (client.name || 'draft').replace(/[^\w\-]/g, '-').replace(/-+/g, '-');

      if (format === 'html') {
        const outputPath = path.join(outputDir, `notso-proposal-${safeName}.html`);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(outputPath, html, 'utf-8');
        console.log(JSON.stringify({
          success: true,
          path: outputPath,
          filename: path.basename(outputPath),
          html: html,
        }));
      } else {
        const outputPath = path.join(outputDir, `notso-proposal-${safeName}.pdf`);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        await generatePDF(html, outputPath);
        console.log(JSON.stringify({
          success: true,
          path: outputPath,
          filename: path.basename(outputPath),
        }));
      }
    } catch (error) {
      console.log(JSON.stringify({
        success: false,
        error: error.message || 'Unknown error',
      }));
      process.exit(1);
    }
  });
}
