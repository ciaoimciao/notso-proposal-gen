/**
 * mockup_compose.js — Node port of compose.py
 *
 * Renders the two asset-pack mockup images:
 *   composePhoneMockup()  — phone with chat UI (mascot bubble, user bubble, mascot, input)
 *   composeLaptopMockup() — laptop showing client website + chat-widget popup bottom-right
 *
 * Strategy: build an HTML page with the phone/laptop frame PNG layered on top
 * of an inline-rendered chat UI, then screenshot via Puppeteer. Avoids the
 * scipy dependency that ruled out Python on Vercel.
 *
 * Frame coordinates (matched to the pre-processed transparent PNGs in
 * mockup-assets/):
 *   phone-frame.png  : 5000×5000  · screen rect (1615, 601, 3391, 4398)
 *   laptop-frame.png : 4165×4165  · screen rect (768, 1211, 3396, 2858)
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./generate_html');

// ─── Frame geometry (pixels in original frame PNG resolution) ───
const PHONE = {
  size: 5000,
  screen: { x1: 1615, y1: 601, x2: 3391, y2: 4398, radius: 220 },
  framePath: path.join(__dirname, 'mockup-assets', 'phone-frame.png'),
};
const LAPTOP = {
  size: 4165,
  screen: { x1: 768, y1: 1211, x2: 3396, y2: 2858, radius: 20 },
  framePath: path.join(__dirname, 'mockup-assets', 'laptop-frame.png'),
};

// ─── Industry → dialogue templates (same as compose.py DIALOGUES) ───
const DIALOGUES = {
  nutrition: ["Hi! I'm {name}. What did you eat today?", 'A big salad and coffee'],
  health:    ["Hi! I'm {name}. How can I support your health today?", 'What should I eat for dinner?'],
  fitness:   ["Hi! I'm {name}. Ready for today's workout?", 'Give me a quick 20-min routine'],
  finance:   ["Hi! I'm {name}. Let's talk about your finances.", 'How do I save more this month?'],
  sport:     ["Hi! I'm {name}. Where's your club running into trouble?", 'Our finances need help'],
  education: ["Hi! I'm {name}. Ready to learn something new?", 'Teach me about photosynthesis'],
  retail:    ["Hi! I'm {name}. Looking for anything in particular?", 'A red shirt in size M'],
  charity:   ["Hi! I'm {name}. Want to hear about our mission?", 'How can I help donate today?'],
  default:   ["Hi! I'm {name}. What can I help you with?", 'Tell me more about what you do'],
};
function pickDialogue(industry, mascotName) {
  const key = String(industry || '').toLowerCase();
  for (const k of Object.keys(DIALOGUES)) {
    if (k !== 'default' && key.includes(k)) {
      const [m, u] = DIALOGUES[k];
      return [m.replace('{name}', mascotName), u];
    }
  }
  const [m, u] = DIALOGUES.default;
  return [m.replace('{name}', mascotName), u];
}

// ─── Helpers ───
function readFrameAsDataUrl(framePath) {
  const buf = fs.readFileSync(framePath);
  return 'data:image/png;base64,' + buf.toString('base64');
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────
// PHONE MOCKUP
// ─────────────────────────────────────────────────────────────────────
async function composePhoneMockup({
  mascotDataUrl,
  mascotName = 'Notso',
  brandColor = '#DC2626',
  industry = '',
  mascotLine = null,
  userLine = null,
  outputSize = 1500,            // px — final PNG is outputSize × outputSize
}) {
  const [m, u] = pickDialogue(industry, mascotName);
  const finalMascotLine = mascotLine || m;
  const finalUserLine = userLine || u;
  const frameDataUrl = readFrameAsDataUrl(PHONE.framePath);

  // Map original frame coords (5000×5000) to a 1000-unit canvas inside the HTML.
  // Puppeteer screenshots at outputSize, so we can use any internal scale.
  const N = 1000;
  const k = N / PHONE.size;
  const sx1 = PHONE.screen.x1 * k;
  const sy1 = PHONE.screen.y1 * k;
  const sw = (PHONE.screen.x2 - PHONE.screen.x1) * k;
  const sh = (PHONE.screen.y2 - PHONE.screen.y1) * k;
  const screenRadius = PHONE.screen.radius * k;

  const html = `<!doctype html><html><head><style>
    *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: transparent; }
    .stage {
      position: relative;
      width: ${N}px; height: ${N}px;
      background: transparent;
    }
    .screen {
      position: absolute;
      left: ${sx1}px; top: ${sy1}px;
      width: ${sw}px; height: ${sh}px;
      border-radius: ${screenRadius}px;
      background: #f2f2f2;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: ${sh * 0.045}px ${sw * 0.06}px ${sh * 0.04}px;
      font-family: 'Helvetica Neue', Arial, sans-serif;
      color: #1a1a1a;
    }
    .top-row { display: flex; justify-content: space-between; font-size: ${sh * 0.018}px; color: #555; margin-bottom: ${sh * 0.015}px; }
    .label-row { font-size: ${sh * 0.022}px; color: #555; margin-bottom: ${sh * 0.05}px; }
    .bubble {
      max-width: 78%;
      padding: ${sh * 0.022}px ${sw * 0.055}px;
      border-radius: ${sw * 0.06}px;
      font-size: ${sh * 0.027}px;
      line-height: 1.35;
      box-shadow: 0 4px 14px rgba(0,0,0,0.08);
      margin-bottom: ${sh * 0.018}px;
    }
    .bubble-mascot { background: #fff; color: #1a1a1a; align-self: flex-start; }
    .bubble-user   { background: ${brandColor}; color: #fff; align-self: flex-end; }
    .mascot-wrap {
      flex: 1;
      display: flex; align-items: center; justify-content: center;
      padding: ${sh * 0.015}px 0;
      min-height: 0;
    }
    .mascot-wrap img { max-width: 92%; max-height: 100%; object-fit: contain; }
    .input-bar {
      display: flex; align-items: center; justify-content: space-between;
      background: #fff;
      border: 2.5px solid ${brandColor};
      border-radius: ${sh * 0.055}px;
      padding: ${sh * 0.022}px ${sw * 0.06}px;
      font-size: ${sh * 0.025}px;
      color: #999;
      margin-top: ${sh * 0.012}px;
    }
    .input-bar .chev { color: ${brandColor}; font-weight: 700; font-size: ${sh * 0.038}px; }
    .frame {
      position: absolute; left: 0; top: 0;
      width: ${N}px; height: ${N}px;
      pointer-events: none;
    }
  </style></head>
  <body>
    <div class="stage">
      <div class="screen">
        <div class="top-row"><span></span><span>online</span></div>
        <div class="label-row">${escapeHtml(mascotName)} // online</div>
        <div class="bubble bubble-mascot">${escapeHtml(finalMascotLine)}</div>
        <div class="bubble bubble-user">${escapeHtml(finalUserLine)}</div>
        <div class="mascot-wrap">
          ${mascotDataUrl ? `<img src="${mascotDataUrl}" alt="">` : ''}
        </div>
        <div class="input-bar"><span>Ask a question</span><span class="chev">›</span></div>
      </div>
      <img class="frame" src="${frameDataUrl}">
    </div>
  </body></html>`;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: N, height: N, deviceScaleFactor: outputSize / N });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    const buf = await page.screenshot({
      type: 'png',
      omitBackground: true,
      clip: { x: 0, y: 0, width: N, height: N },
    });
    await page.close();
    return 'data:image/png;base64,' + buf.toString('base64');
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// LAPTOP MOCKUP
// ─────────────────────────────────────────────────────────────────────
async function composeLaptopMockup({
  mascotDataUrl,
  websiteImageUrl,            // data: URL OR http URL of client's website screenshot
  mascotName = 'Notso',
  brandColor = '#DC2626',
  industry = '',
  mascotLine = null,
  userLine = null,
  outputSize = 1500,
}) {
  const [m, u] = pickDialogue(industry, mascotName);
  const finalMascotLine = mascotLine || m;
  const finalUserLine = userLine || u;
  const frameDataUrl = readFrameAsDataUrl(LAPTOP.framePath);

  const N = 1000;
  const k = N / LAPTOP.size;
  const sx1 = LAPTOP.screen.x1 * k;
  const sy1 = LAPTOP.screen.y1 * k;
  const sw = (LAPTOP.screen.x2 - LAPTOP.screen.x1) * k;
  const sh = (LAPTOP.screen.y2 - LAPTOP.screen.y1) * k;

  // Chat widget popup, positioned bottom-right INSIDE the laptop screen.
  const widgetW = sw * 0.28;
  const widgetH = sh * 0.85;
  const widgetX = sx1 + sw - widgetW - sw * 0.02;
  const widgetY = sy1 + sh - widgetH - sh * 0.025;
  const widgetRadius = Math.min(widgetW, widgetH) * 0.045;

  const html = `<!doctype html><html><head><style>
    *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: transparent; }
    .stage { position: relative; width: ${N}px; height: ${N}px; background: transparent; }

    .screen {
      position: absolute;
      left: ${sx1}px; top: ${sy1}px;
      width: ${sw}px; height: ${sh}px;
      border-radius: ${LAPTOP.screen.radius * k}px;
      overflow: hidden;
      background: #fff;
    }
    .screen .website {
      width: 100%; height: 100%;
      object-fit: cover;
      object-position: top center;
    }

    .widget {
      position: absolute;
      left: ${widgetX}px; top: ${widgetY}px;
      width: ${widgetW}px; height: ${widgetH}px;
      background: #fff;
      border-radius: ${widgetRadius}px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.25);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: 'Helvetica Neue', Arial, sans-serif;
    }
    .widget-header {
      background: ${brandColor};
      color: #fff;
      padding: ${widgetH * 0.04}px ${widgetW * 0.07}px;
      display: flex; justify-content: space-between; align-items: center;
      font-size: ${widgetH * 0.032}px;
      font-weight: 700;
    }
    .widget-header .online {
      font-size: ${widgetH * 0.022}px; font-weight: 500; opacity: 0.9;
      display: flex; align-items: center; gap: 4px;
    }
    .widget-header .dot {
      width: ${widgetH * 0.012}px; height: ${widgetH * 0.012}px;
      border-radius: 50%; background: #b5f5b5;
    }
    .widget-body {
      flex: 1; min-height: 0;
      padding: ${widgetH * 0.035}px ${widgetW * 0.065}px;
      display: flex; flex-direction: column;
    }
    .wb-bubble {
      max-width: 82%;
      padding: ${widgetH * 0.018}px ${widgetW * 0.05}px;
      border-radius: ${widgetH * 0.028}px;
      font-size: ${widgetH * 0.024}px;
      line-height: 1.35;
      box-shadow: 0 2px 6px rgba(0,0,0,0.06);
      margin-bottom: ${widgetH * 0.014}px;
    }
    .wb-bubble.mascot { background: #f0f0f2; color: #1a1a1a; align-self: flex-start; }
    .wb-bubble.user { background: ${brandColor}; color: #fff; align-self: flex-end; }
    .wb-mascot {
      flex: 1; min-height: 0;
      display: flex; align-items: center; justify-content: center;
      padding: ${widgetH * 0.012}px 0;
    }
    .wb-mascot img { max-width: 80%; max-height: 100%; object-fit: contain; }
    .wb-input {
      display: flex; align-items: center; justify-content: space-between;
      border: 2px solid ${brandColor};
      border-radius: ${widgetH * 0.045}px;
      padding: ${widgetH * 0.018}px ${widgetW * 0.07}px;
      font-size: ${widgetH * 0.025}px;
      color: #888;
    }
    .wb-input .chev { color: ${brandColor}; font-weight: 700; font-size: ${widgetH * 0.04}px; }

    .frame {
      position: absolute; left: 0; top: 0;
      width: ${N}px; height: ${N}px;
      pointer-events: none;
    }
  </style></head>
  <body>
    <div class="stage">
      <div class="screen">
        ${websiteImageUrl ? `<img class="website" src="${websiteImageUrl}" alt="">` : ''}
      </div>
      <div class="widget">
        <div class="widget-header">
          <span>${escapeHtml(mascotName)}</span>
          <span class="online"><span class="dot"></span>online</span>
        </div>
        <div class="widget-body">
          <div class="wb-bubble mascot">${escapeHtml(finalMascotLine)}</div>
          <div class="wb-bubble user">${escapeHtml(finalUserLine)}</div>
          <div class="wb-mascot">
            ${mascotDataUrl ? `<img src="${mascotDataUrl}" alt="">` : ''}
          </div>
          <div class="wb-input"><span>Ask a question</span><span class="chev">›</span></div>
        </div>
      </div>
      <img class="frame" src="${frameDataUrl}">
    </div>
  </body></html>`;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: N, height: N, deviceScaleFactor: outputSize / N });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    const buf = await page.screenshot({
      type: 'png',
      omitBackground: true,
      clip: { x: 0, y: 0, width: N, height: N },
    });
    await page.close();
    return 'data:image/png;base64,' + buf.toString('base64');
  } finally {
    await browser.close();
  }
}

module.exports = { composePhoneMockup, composeLaptopMockup, pickDialogue };
