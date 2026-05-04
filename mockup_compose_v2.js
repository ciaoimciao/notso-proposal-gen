/**
 * mockup_compose_v2 — Node port of mockup-assets/compose.py.
 *
 * Produces phone + laptop mockups using @napi-rs/canvas. No Puppeteer,
 * no Gemini, no chromium-min — pure pixel composition. Output matches
 * mockup-assets/samples/phone-yazi.png and laptop-yazi.png at ~5000x5000.
 *
 * Usage:
 *   const { composePhoneMockup, composeLaptopMockup } = require('./mockup_compose_v2');
 *   const buf = await composePhoneMockup({ mascotPath, mascotName, brandColor, ... });
 *   fs.writeFileSync('phone.png', buf);
 */
const fs = require('fs');
const path = require('path');
const {
  createCanvas, loadImage, GlobalFonts,
} = require('@napi-rs/canvas');

// ── Register bundled fonts (Vercel Lambda has no system DejaVu) ──
const FONTS_DIR = path.join(__dirname, 'fonts');
try {
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'DejaVuSans.ttf'),       'DejaVu Sans');
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf'),  'DejaVu Sans');
} catch (e) {
  console.warn('  ⚠️ Could not register DejaVu fonts:', e.message);
}

// ── compose.py constants (verified against the high-quality samples) ──
const PHONE_SCREEN  = { x1: 1615, y1: 601,  x2: 3391, y2: 4398 };
const LAPTOP_SCREEN = { x1: 768,  y1: 1211, x2: 3396, y2: 2858 };
const PHONE_SCREEN_RADIUS  = 220;
const LAPTOP_SCREEN_RADIUS = 20;

// ── compose.py industry → dialogue table ──
// 3 lines now: mascot intro / user / mascot follow-up (short, 1-2 sentences)
const DIALOGUES = {
  nutrition: ["Hi! I'm {name}. What did you eat today?",                  "A big salad and coffee",          "Nice — solid choice! Want a snack idea? 🥗"],
  health:    ["Hi! I'm {name}. How can I support your health today?",     "What should I eat for dinner?",   "Try grilled salmon with veggies."],
  fitness:   ["Hi! I'm {name}. Ready for today's workout?",               "Give me a quick 20-min routine", "Got it — let's start with squats."],
  finance:   ["Hi! I'm {name}. Let's talk about your finances.",          "How do I save more this month?",  "Start with auto-transfers — easy win."],
  sport:     ["Hi! I'm {name}. Where's your club running into trouble?",  "Our finances need help",          "I'll pull up the budget tools."],
  education: ["Hi! I'm {name}. Ready to learn something new?",            "Teach me about photosynthesis",   "Sure! Plants turn sunlight into food."],
  retail:    ["Hi! I'm {name}. Looking for anything in particular?",      "A red shirt in size M",           "Found 12 options — want to see them?"],
  charity:   ["Hi! I'm {name}. Want to hear about our mission?",          "How can I help donate today?",    "Even $5 makes a difference. 💚"],
  default:   ["Hi! I'm {name}. What can I help you with?",                "Tell me more about what you do",  "Happy to walk you through it!"],
};

function pickDialogue(industry, mascotName) {
  const key = String(industry || 'default').toLowerCase();
  for (const k of Object.keys(DIALOGUES)) {
    if (k !== 'default' && key.includes(k)) {
      const [m, u, m2] = DIALOGUES[k];
      return [m.replace('{name}', mascotName), u, m2];
    }
  }
  const [m, u, m2] = DIALOGUES.default;
  return [m.replace('{name}', mascotName), u, m2];
}

// ── Chroma-key: knock out near-white background pixels (alpha = 0) ──
// Uses edge-flood: only pixels reachable from the image border get knocked
// out. This preserves bright-white highlights inside the mascot body.
function knockOutWhiteBackground(img, threshold = 235) {
  const w = img.width, h = img.height;
  const tmp = createCanvas(w, h);
  const tctx = tmp.getContext('2d');
  tctx.drawImage(img, 0, 0);
  let imgData;
  try { imgData = tctx.getImageData(0, 0, w, h); }
  catch (e) { return tmp; } // CORS / tainted — give up gracefully
  const data = imgData.data;
  const visited = new Uint8Array(w * h);
  const queue = [];
  // Seed with all border pixels that are "near white"
  function isNearWhite(i) {
    return data[i] >= threshold && data[i+1] >= threshold && data[i+2] >= threshold;
  }
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = (y * w + x) * 4;
      if (isNearWhite(i)) { queue.push(x + y * w); visited[x + y * w] = 1; }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const i = (y * w + x) * 4;
      if (isNearWhite(i)) { queue.push(x + y * w); visited[x + y * w] = 1; }
    }
  }
  // BFS flood
  while (queue.length) {
    const p = queue.shift();
    const x = p % w, y = (p - x) / w;
    const i = p * 4;
    data[i+3] = 0; // alpha 0
    const neighbours = [[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (visited[np]) continue;
      const ni = np * 4;
      if (isNearWhite(ni)) { visited[np] = 1; queue.push(np); }
    }
  }
  tctx.putImageData(imgData, 0, 0);
  return tmp;
}

// ── Helpers ────────────────────────────────────────────────────────

function hexToRgb(h) {
  let s = String(h || '#888').replace('#','');
  if (s.length === 3) s = s.split('').map(c => c+c).join('');
  return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)];
}

function rgbStr(rgb, a = 1) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/** Stroke or fill a rounded rectangle — mirrors PIL rounded_rectangle. */
function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Word-wrap into lines that fit max_w. Mirrors compose.py's wrapping logic. */
function wrapText(ctx, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = (line ? line + ' ' : '') + w;
    if (ctx.measureText(test).width < maxW) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Mask a sub-canvas to a rounded rect (everything outside becomes transparent). */
function applyRoundedMask(ctx, x, y, w, h, r) {
  const tmp = createCanvas(w, h);
  const tctx = tmp.getContext('2d');
  // Copy current region
  tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  // Clear original region
  ctx.clearRect(x, y, w, h);
  // Re-draw clipped to rounded path
  ctx.save();
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(tmp, x, y);
  ctx.restore();
}

// ── Build the phone screen content (chat UI) ────────────────────────

function buildPhoneScreenContent({ sw, sh, mascot, mascotName, brandRgb,
                                   mascotLine, userLine, mascotLine2, industry }) {
  if (!mascotLine || !userLine || !mascotLine2) {
    const [m, u, m2] = pickDialogue(industry, mascotName);
    mascotLine  = mascotLine  || m;
    userLine    = userLine    || u;
    mascotLine2 = mascotLine2 || m2;
  }

  const canvas = createCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';

  // Background — light grey (matches compose.py BG = (242,242,242))
  ctx.fillStyle = 'rgb(242, 242, 242)';
  ctx.fillRect(0, 0, sw, sh);

  // Font sizes — mirror compose.py
  const fSmall = Math.max(32, Math.floor(sh / 100));
  const fBody  = Math.max(58, Math.floor(sh / 60));
  const fLabel = Math.max(38, Math.floor(sh / 90));
  const fInput = Math.max(52, Math.floor(sh / 70));

  // Top-right "online"
  const topPad = Math.floor(sh * 0.055);
  ctx.font = `${fSmall}px "DejaVu Sans"`;
  ctx.fillStyle = 'rgba(60, 60, 60, 1)';
  const onlineW = ctx.measureText('online').width;
  ctx.fillText('online', sw - onlineW - Math.floor(sw * 0.08), topPad);

  // Label "{name} // online"
  const labelY = topPad + Math.floor(sh * 0.04);
  ctx.font = `${fLabel}px "DejaVu Sans"`;
  ctx.fillStyle = 'rgba(90, 90, 90, 1)';
  ctx.fillText(`${mascotName} // online`, Math.floor(sw * 0.08), labelY);

  // ── Bubble drawer (closure to share state) ──
  ctx.font = `${fBody}px "DejaVu Sans"`;
  function drawBubble(text, align, topY, isUser) {
    ctx.font = `${fBody}px "DejaVu Sans"`;
    const padX = Math.floor(sw * 0.055);
    const padY = Math.floor(sh * 0.022);
    const maxW = Math.floor(sw * 0.78);
    const lines = wrapText(ctx, text, maxW - 2 * padX);
    const lineH = fBody + 16;
    const textW = Math.max(...lines.map(ln => ctx.measureText(ln).width));
    const bw = Math.floor(textW + 2 * padX);
    const bh = Math.floor(lines.length * lineH + 2 * padY + 10);
    const margin = Math.floor(sw * 0.07);
    const x1 = align === 'left' ? margin : (sw - margin - bw);
    const y1 = topY;
    const x2 = x1 + bw;
    const y2 = y1 + bh;

    // Soft shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 5;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = isUser ? rgbStr(brandRgb, 1) : 'rgb(255, 255, 255)';
    roundedRectPath(ctx, x1, y1, bw, bh, Math.floor(sw * 0.03));
    ctx.fill();
    ctx.restore();

    // Text
    ctx.fillStyle = isUser ? 'rgb(255, 255, 255)' : 'rgb(30, 30, 30)';
    let ty = y1 + padY;
    for (const ln of lines) {
      ctx.fillText(ln, x1 + padX, ty);
      ty += lineH;
    }
    return y2;
  }

  // 3 bubbles: mascot intro (L) → user (R) → mascot follow-up (L, short)
  const firstY  = labelY + Math.floor(sh * 0.05);
  const bub1End = drawBubble(mascotLine,  'left',  firstY,                              false);
  const bub2End = drawBubble(userLine,    'right', bub1End + Math.floor(sh * 0.018),    true);
  const bub3End = drawBubble(mascotLine2, 'left',  bub2End + Math.floor(sh * 0.018),    false);

  // ── Mascot image (smaller — 70% of available area, centred) ──
  const bottomBarH   = Math.floor(sh * 0.10);
  const bottomBarPad = Math.floor(sh * 0.035);
  const mascotTop    = bub3End + Math.floor(sh * 0.015);
  const mascotBottom = sh - bottomBarH - bottomBarPad - Math.floor(sh * 0.01);
  const mascotAreaH  = (mascotBottom - mascotTop) * 0.78;   // shrink vertical area
  const mascotAreaW  = Math.floor(sw * 0.70);              // shrink horizontal area
  if (mascot && mascotAreaH > 0) {
    // Knock out white background so the figure floats on the chat bg
    const masked = knockOutWhiteBackground(mascot, 235);
    const scale = Math.min(mascotAreaW / masked.width, mascotAreaH / masked.height);
    const newW = Math.floor(masked.width * scale);
    const newH = Math.floor(masked.height * scale);
    const mx = Math.floor((sw - newW) / 2);
    const my = mascotTop + Math.floor(((mascotBottom - mascotTop) - newH) / 2);
    ctx.drawImage(masked, mx, my, newW, newH);
  }

  // ── Bottom input bar ──
  const inputMargin = Math.floor(sw * 0.06);
  const ix1 = inputMargin;
  const ix2 = sw - inputMargin;
  const iy1 = sh - bottomBarH - bottomBarPad;
  const iy2 = sh - bottomBarPad;
  const ih = iy2 - iy1;
  ctx.fillStyle = 'rgb(255, 255, 255)';
  roundedRectPath(ctx, ix1, iy1, ix2 - ix1, ih, ih / 2);
  ctx.fill();
  ctx.strokeStyle = rgbStr(brandRgb, 1);
  ctx.lineWidth = 4;
  roundedRectPath(ctx, ix1, iy1, ix2 - ix1, ih, ih / 2);
  ctx.stroke();
  // Placeholder text
  ctx.font = `${fInput}px "DejaVu Sans"`;
  ctx.fillStyle = 'rgba(120, 120, 120, 1)';
  ctx.fillText('Ask a question', ix1 + Math.floor(sw * 0.05), iy1 + (ih - fInput) / 2 - 4);
  // Chevron
  const chevSize = Math.floor(ih * 0.55);
  ctx.font = `bold ${chevSize}px "DejaVu Sans"`;
  ctx.fillStyle = rgbStr(brandRgb, 1);
  const cw = ctx.measureText('>').width;
  ctx.fillText('>', ix2 - cw - Math.floor(sw * 0.06), iy1 + (ih - chevSize) / 2 - 4);

  return canvas;
}

// ── Build the chat-popup widget for laptop overlay ──────────────────

function buildChatWindow({ w, h, mascot, mascotName, brandRgb,
                           mascotLine, userLine, industry, cornerRadius = 32 }) {
  if (!mascotLine || !userLine) {
    const [m, u] = pickDialogue(industry, mascotName);
    mascotLine = mascotLine || m;
    userLine   = userLine   || u;
  }
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';

  // White rounded body
  ctx.fillStyle = 'rgb(255, 255, 255)';
  roundedRectPath(ctx, 0, 0, w, h, cornerRadius);
  ctx.fill();

  // Header (brand color, only top corners rounded — draw a rect and clip)
  const headerH = Math.floor(h * 0.11);
  ctx.save();
  ctx.beginPath();
  // path that's rounded only on the top
  ctx.moveTo(0, headerH);
  ctx.lineTo(0, cornerRadius);
  ctx.quadraticCurveTo(0, 0, cornerRadius, 0);
  ctx.lineTo(w - cornerRadius, 0);
  ctx.quadraticCurveTo(w, 0, w, cornerRadius);
  ctx.lineTo(w, headerH);
  ctx.closePath();
  ctx.fillStyle = rgbStr(brandRgb, 1);
  ctx.fill();
  ctx.restore();

  const fHeader = Math.max(22, Math.floor(h / 30));
  const fSmall  = Math.max(16, Math.floor(h / 42));
  const fBody   = Math.max(20, Math.floor(h / 34));
  const fInput  = Math.max(18, Math.floor(h / 38));

  // Header text
  ctx.font = `bold ${fHeader}px "DejaVu Sans"`;
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillText(mascotName, Math.floor(w * 0.05), (headerH - fHeader) / 2 - 2);

  // online dot + text
  const dotR  = Math.max(5, Math.floor(h / 140));
  const dotCx = Math.floor(w * 0.72);
  const dotCy = headerH / 2;
  ctx.fillStyle = 'rgb(180, 255, 180)';
  ctx.beginPath();
  ctx.arc(dotCx, dotCy, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `${fSmall}px "DejaVu Sans"`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillText('online', dotCx + dotR + 8, dotCy - fSmall / 2 - 2);

  // ── Bubbles ──
  const bodyX = Math.floor(w * 0.05);
  const bodyRight = w - bodyX;
  const bubbleTop = headerH + Math.floor(h * 0.035);

  function drawBubble(text, align, topY, isUser) {
    ctx.font = `${fBody}px "DejaVu Sans"`;
    const padX = Math.floor(w * 0.04);
    const padY = Math.floor(h * 0.016);
    const maxW = Math.floor((bodyRight - bodyX) * 0.82);
    const lines = wrapText(ctx, text, maxW - 2 * padX);
    const lineH = fBody + 10;
    const textW = Math.max(...lines.map(ln => ctx.measureText(ln).width));
    const bw = Math.floor(textW + 2 * padX);
    const bh = Math.floor(lines.length * lineH + 2 * padY + 6);
    const x1 = align === 'left' ? bodyX : (bodyRight - bw);
    const y1 = topY;
    const radius = Math.floor(h * 0.022);

    // Light shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = isUser ? rgbStr(brandRgb, 1) : 'rgb(240, 240, 242)';
    roundedRectPath(ctx, x1, y1, bw, bh, radius);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = isUser ? 'rgb(255, 255, 255)' : 'rgb(30, 30, 30)';
    let ty = y1 + padY;
    for (const ln of lines) {
      ctx.fillText(ln, x1 + padX, ty);
      ty += lineH;
    }
    return y1 + bh;
  }

  const bub1End = drawBubble(mascotLine, 'left',  bubbleTop, false);
  const bub2End = drawBubble(userLine,   'right', bub1End + Math.floor(h * 0.012), true);

  // Mascot image
  const bottomBarH = Math.floor(h * 0.10);
  const bottomPad  = Math.floor(h * 0.028);
  const mascotTop    = bub2End + Math.floor(h * 0.01);
  const mascotBottom = h - bottomBarH - bottomPad - Math.floor(h * 0.012);
  const mascotAreaH  = Math.max(0, mascotBottom - mascotTop);
  const mascotAreaW  = Math.floor(w * 0.80);
  if (mascot && mascotAreaH > 20) {
    const masked = knockOutWhiteBackground(mascot, 235);
    const scale = Math.min(mascotAreaW / masked.width, mascotAreaH / masked.height);
    const nw = Math.floor(masked.width * scale);
    const nh = Math.floor(masked.height * scale);
    const mx = Math.floor((w - nw) / 2);
    const my = mascotTop + Math.floor((mascotAreaH - nh) / 2);
    ctx.drawImage(masked, mx, my, nw, nh);
  }

  // Input bar
  const ix1 = Math.floor(w * 0.05);
  const ix2 = w - ix1;
  const iy1 = h - bottomBarH - bottomPad;
  const iy2 = h - bottomPad;
  const ih  = iy2 - iy1;
  ctx.fillStyle = 'rgb(255, 255, 255)';
  roundedRectPath(ctx, ix1, iy1, ix2 - ix1, ih, ih / 2);
  ctx.fill();
  ctx.strokeStyle = rgbStr(brandRgb, 1);
  ctx.lineWidth = 3;
  roundedRectPath(ctx, ix1, iy1, ix2 - ix1, ih, ih / 2);
  ctx.stroke();
  ctx.font = `${fInput}px "DejaVu Sans"`;
  ctx.fillStyle = 'rgb(140, 140, 140)';
  ctx.fillText('Ask a question', ix1 + Math.floor(w * 0.04), iy1 + (ih - fInput) / 2 - 3);
  const chevSize = Math.floor(ih * 0.55);
  ctx.font = `bold ${chevSize}px "DejaVu Sans"`;
  ctx.fillStyle = rgbStr(brandRgb, 1);
  const cw = ctx.measureText('>').width;
  ctx.fillText('>', ix2 - cw - Math.floor(w * 0.05), iy1 + (ih - chevSize) / 2 - 4);

  // Clip to rounded corners (everything outside transparent)
  const clipped = createCanvas(w, h);
  const cctx = clipped.getContext('2d');
  cctx.save();
  roundedRectPath(cctx, 0, 0, w, h, cornerRadius);
  cctx.clip();
  cctx.drawImage(canvas, 0, 0);
  cctx.restore();
  return clipped;
}

// ── Public: composePhoneMockup({...}) ──────────────────────────────

async function composePhoneMockup({
  mascotDataUrl, mascotPath, phoneFramePath,
  mascotName = 'Notso', brandColor = '#DC2626',
  industry = '', mascotLine = null, userLine = null, mascotLine2 = null,
}) {
  const framePath = phoneFramePath ||
                    path.join(__dirname, 'mockup-assets', 'phone-frame.png');
  const frame = await loadImage(framePath);

  // Mascot from path or data URL
  const mascot = await loadImage(mascotPath ||
    Buffer.from(String(mascotDataUrl).replace(/^data:image\/[^;]+;base64,/, ''), 'base64'));

  const brandRgb = hexToRgb(brandColor);
  const sx1 = PHONE_SCREEN.x1, sy1 = PHONE_SCREEN.y1;
  const sw  = PHONE_SCREEN.x2 - PHONE_SCREEN.x1;
  const sh  = PHONE_SCREEN.y2 - PHONE_SCREEN.y1;

  // 1) Build screen content
  const content = buildPhoneScreenContent({
    sw, sh, mascot, mascotName, brandRgb, mascotLine, userLine, mascotLine2, industry,
  });

  // 2) Mask to rounded rect (matches bezel interior)
  const masked = createCanvas(sw, sh);
  const mctx = masked.getContext('2d');
  mctx.save();
  roundedRectPath(mctx, 0, 0, sw, sh, PHONE_SCREEN_RADIUS);
  mctx.clip();
  mctx.drawImage(content, 0, 0);
  mctx.restore();

  // 3) Final canvas: paste content at screen coords, then frame on top
  const out = createCanvas(frame.width, frame.height);
  const octx = out.getContext('2d');
  octx.drawImage(masked, sx1, sy1);
  octx.drawImage(frame, 0, 0);

  return out.toBuffer('image/png');
}

// ── Public: composeLaptopMockup({...}) ─────────────────────────────

async function composeLaptopMockup({
  mascotDataUrl, mascotPath, laptopFramePath, websiteImageUrl, websitePath,
  mascotName = 'Notso', brandColor = '#DC2626',
  industry = '', mascotLine = null, userLine = null,
  windowScale = 0.72, outputMaxW = 2000,
}) {
  const framePath = laptopFramePath ||
                    path.join(__dirname, 'mockup-assets', 'laptop-frame.png');
  const frame = await loadImage(framePath);

  const mascot = await loadImage(mascotPath ||
    Buffer.from(String(mascotDataUrl).replace(/^data:image\/[^;]+;base64,/, ''), 'base64'));

  // Website — from data URL, path, or fallback to bundled website.png
  let websiteImg = null;
  if (websiteImageUrl && websiteImageUrl.startsWith('data:')) {
    const b64 = websiteImageUrl.replace(/^data:image\/[^;]+;base64,/, '');
    websiteImg = await loadImage(Buffer.from(b64, 'base64'));
  } else if (websitePath) {
    websiteImg = await loadImage(websitePath);
  } else {
    const fallback = path.join(__dirname, 'mockup-assets', 'website.png');
    if (fs.existsSync(fallback)) websiteImg = await loadImage(fallback);
  }

  const brandRgb = hexToRgb(brandColor);
  const sx1 = LAPTOP_SCREEN.x1, sy1 = LAPTOP_SCREEN.y1;
  const sw  = LAPTOP_SCREEN.x2 - LAPTOP_SCREEN.x1;
  const sh  = LAPTOP_SCREEN.y2 - LAPTOP_SCREEN.y1;

  // Cover-fit website into screen
  const screen = createCanvas(sw, sh);
  const sctx = screen.getContext('2d');
  if (websiteImg) {
    const ratio = Math.max(sw / websiteImg.width, sh / websiteImg.height);
    const nw = websiteImg.width * ratio;
    const nh = websiteImg.height * ratio;
    const cx = (nw - sw) / 2;
    const cy = (nh - sh) / 2;
    sctx.drawImage(websiteImg, -cx, -cy, nw, nh);
  } else {
    sctx.fillStyle = 'rgb(255, 255, 255)';
    sctx.fillRect(0, 0, sw, sh);
  }

  // Apply rounded screen corner mask
  const screenMasked = createCanvas(sw, sh);
  const smctx = screenMasked.getContext('2d');
  smctx.save();
  roundedRectPath(smctx, 0, 0, sw, sh, LAPTOP_SCREEN_RADIUS);
  smctx.clip();
  smctx.drawImage(screen, 0, 0);
  smctx.restore();

  // Build chat widget — taller than wide (chat dock proportions)
  const winH = Math.floor(sh * windowScale);
  const winW = Math.floor(winH * 0.56);
  const cornerR = Math.floor(Math.min(winW, winH) * 0.045);
  const chat = buildChatWindow({
    w: winW, h: winH, mascot, mascotName, brandRgb,
    mascotLine, userLine, industry, cornerRadius: cornerR,
  });

  // Position widget bottom-right of screen with shadow
  const rightInset  = Math.floor(sw * 0.03);
  const bottomInset = Math.floor(sh * 0.04);
  const wx = sw - winW - rightInset;
  const wy = sh - winH - bottomInset;

  // Compose chat onto screen with drop shadow
  smctx.save();
  smctx.shadowColor = 'rgba(0, 0, 0, 0.30)';
  smctx.shadowBlur = 36;
  smctx.shadowOffsetX = 0;
  smctx.shadowOffsetY = 20;
  smctx.drawImage(chat, wx, wy);
  smctx.restore();

  // Final canvas: paste screen at coords, frame on top
  const out = createCanvas(frame.width, frame.height);
  const octx = out.getContext('2d');
  octx.drawImage(screenMasked, sx1, sy1);
  octx.drawImage(frame, 0, 0);

  // Downscale if huge
  if (out.width > outputMaxW) {
    const ratio = outputMaxW / out.width;
    const small = createCanvas(outputMaxW, Math.floor(out.height * ratio));
    small.getContext('2d').drawImage(out, 0, 0, small.width, small.height);
    return small.toBuffer('image/png');
  }
  return out.toBuffer('image/png');
}

module.exports = {
  composePhoneMockup,
  composeLaptopMockup,
  pickDialogue,
};
