/**
 * notso.ai Proposal Generator — Local Server
 *
 * Endpoints:
 *   /api/mascot/*    — Gemini mascot generation pipeline
 *   /api/assetpack/* — expression / pose asset pack generator
 *   /api/generate    — PDF: node generate_html.js (HTML→Puppeteer→PDF), PPTX: python3 generate.py
 *   /api/gslides/*   — Google Slides export (OAuth2 + Drive upload convert)
 *
 * Usage:  node server.js
 * Then open http://127.0.0.1:8080
 *
 * Environment variables (or edit the defaults below):
 *   GOOGLE_CLIENT_ID     — OAuth 2.0 Client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET — OAuth 2.0 Client Secret from Google Cloud Console
 *   GOOGLE_REDIRECT_URI  — must match the Authorized redirect URI on the
 *                          OAuth client (default http://127.0.0.1:8080)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');

// ─── NOTSO STYLE LOCK ───
// Every mascot generation call MUST route through this module so that the
// rules in notso_style_lock.md are enforced at the prompt layer. Do not
// bypass it. See notso_style_prompt.js for the canonical implementation.
const { buildStylePrompt, STYLE_VERSION, NEGATIVE_SUFFIX, STYLE_TRANSFER_MODIFIER, FAITHFUL_TRANSFER_MODIFIER } = require('./notso_style_prompt');

// ─── CONFIG ───
const PORT              = 8080;

// ─── GOOGLE SLIDES OAUTH CONFIG ───
// Create OAuth 2.0 Client ID in Google Cloud Console:
//   https://console.cloud.google.com/apis/credentials
//   Application type: "Web application"
//   Authorized redirect URIs: http://127.0.0.1:8080  (and your Vercel URL later)
// Required APIs enabled: "Google Slides API", "Google Drive API"
// Required OAuth scopes: drive.file + presentations
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI  || `http://127.0.0.1:${PORT}`;
const GOOGLE_AUTH_URL       = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL      = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_UPLOAD   = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const GOOGLE_SCOPES         = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/presentations',
].join(' ');

// ─── MIME MAP ───
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf':  'application/pdf',
};

// ─── HELPERS ───
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Import-Metadata');
}

// Collect request body as Buffer
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── SLIDES TEXT-REPLACEMENT MAPPING ───
// Shared mapping function used by the Google Slides export path.
// Maps proposal data → a flat { '{{placeholder}}': 'value' } dictionary that
// is handed to presentations.batchUpdate via replaceAllText requests.
// Kept as a generic "slides mapping" so it can be reused if we swap the
// backend export target later.
function buildSlidesMapping(proposal, clientData) {
  const d = proposal;
  const c = clientData;
  const mascotName = (d.s1 || {}).mascot_name || (d.s5 || {}).name || 'Buddy';

  // Page-by-page text mapping (field name → replacement text)
  // These feed the replaceAllText batchUpdate request in Google Slides
  return {
    cover: {
      mascot_name: mascotName,
      client_name: c.name || '',
      greeting: (d.s1 || {}).greeting || '',
      tagline: (d.s1 || {}).tagline || '',
      date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    },
    pain_points: {
      headline: (d.s2 || {}).headline || '',
      intro: (d.s2 || {}).intro || '',
      points: ((d.s2 || {}).points || []).map(p => ({ title: p.title, desc: p.desc })),
    },
    solutions: {
      headline: (d.s3 || {}).headline || '',
      subtitle: (d.s3 || {}).subtitle || `${mascotName} 是 ${c.name} 的 3D 動態 AI 吉祥物，全天候駐守在你的平台上。`,
      features: ((d.s3 || {}).features || []).map(f => ({ title: f.title, desc: f.desc })),
    },
    mascot_selection: {
      headline: (d.s4 || {}).headline || `為 ${c.name} 找到最合適的 ${mascotName} 樣貌`,
      option_a: {
        name: ((d.s4 || {}).option_a || {}).name || `${mascotName}（活力版）`,
        desc: ((d.s4 || {}).option_a || {}).desc || '',
      },
      option_b: {
        name: ((d.s4 || {}).option_b || {}).name || `${mascotName}（專業版）`,
        desc: ((d.s4 || {}).option_b || {}).desc || '',
      },
      option_c: {
        name: ((d.s4 || {}).option_c || {}).name || `${mascotName}（療癒版）`,
        desc: ((d.s4 || {}).option_c || {}).desc || '',
      },
    },
    mascot_intro: {
      title: `${mascotName}（吉祥物介紹）`,
      personality: (d.s5 || {}).personality || '',
      tone_desc: (d.s5 || {}).tone_desc || '',
      phrases: (d.s5 || {}).phrases || [],
    },
    chat_demo: {
      title: `Chat Demo: ${mascotName}`,
      chat: ((d.s6 || {}).chat || []).map(m => ({
        role: m.r === 'user' ? 'User' : mascotName,
        message: m.m,
      })),
      tone_note: (d.s6 || {}).tone_note || '',
    },
    thank_you: {
      closing: (d.s9 || {}).closing || '',
    },
  };
}

// ─── REQUEST HANDLER ───
// Exported as `module.exports` so it can be imported as a Vercel serverless
// function. When run directly (`node server.js`) the bottom of this file
// wraps it in an http.createServer() and calls .listen(PORT).
const handler = async (req, res) => {
  const host = req.headers && req.headers.host ? req.headers.host : `127.0.0.1:${PORT}`;
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'http';
  const url = new URL(req.url, `${proto}://${host}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  cors(res);

  // ──────────────────────────────────────
  // API: Frontend bootstrap config
  // GET /api/config
  //
  // Returns:
  //   env        — "vercel" | "local"
  //   isVercel   — boolean (env === 'vercel')
  //   claudeKey  — prefilled Claude key for local dev ONLY (empty on Vercel)
  //   geminiKey  — prefilled Gemini key for local dev ONLY (empty on Vercel)
  //   fixtures   — array of { preset_id, title, source, data } for ?preset=
  //
  // Key precedence (local only):
  //   process.env.CLAUDE_API_KEY > .secrets.json > ''
  //
  // On Vercel we deliberately do NOT expose keys — each end user pastes
  // their own Claude key in the form so our API budget isn't consumed by
  // everyone who visits proposal.notso.ai.
  // ──────────────────────────────────────
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const isVercel = !!process.env.VERCEL;

    let claudeKey = '';
    let geminiKey = '';
    if (!isVercel) {
      claudeKey = process.env.CLAUDE_API_KEY || '';
      geminiKey = process.env.GEMINI_API_KEY || '';
      try {
        const secretsPath = path.join(__dirname, '.secrets.json');
        if (fs.existsSync(secretsPath)) {
          const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
          if (!claudeKey) claudeKey = secrets.CLAUDE_API_KEY || '';
          if (!geminiKey) geminiKey = secrets.GEMINI_API_KEY || '';
        }
      } catch (_) { /* ignore malformed .secrets.json */ }
    }

    const fixtures = [];
    const readFixturesDir = (dir, source) => {
      try {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir).sort();
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue;
          if (entry === 'fixture.example.json') continue;
          const full = path.join(dir, entry);
          try {
            const stat = fs.statSync(full);
            if (!stat.isFile()) continue;
            const data = JSON.parse(fs.readFileSync(full, 'utf8'));
            const meta = data._meta || {};
            const preset_id = meta.preset_id || entry.replace(/\.json$/, '');
            const title     = meta.title || data.clientName || preset_id;
            fixtures.push({ preset_id, title, source, data });
          } catch (_) { /* skip invalid fixture */ }
        }
      } catch (_) { /* ignore */ }
    };
    readFixturesDir(path.join(__dirname, 'fixtures', 'demo'), 'demo');
    readFixturesDir(path.join(__dirname, 'fixtures'), 'local');

    return json(res, 200, {
      env: isVercel ? 'vercel' : 'local',
      isVercel,
      claudeKey,
      geminiKey,
      fixtures,
    });
  }

  // ──────────────────────────────────────
  // API: Brandfetch proxy — auto-fetch brand colors from a client's website
  // GET /api/brandfetch?domain=jumbo.com
  // Returns: { colors: [{ hex, type, brightness }], name, domain }
  //
  // Free tier: 500 requests/month. Key lives in BRANDFETCH_API_KEY env var
  // (or .secrets.json for local dev). Without a key we 503 with a clear
  // message so the frontend can point the user at the signup page.
  // ──────────────────────────────────────
  if (url.pathname === '/api/brandfetch' && req.method === 'GET') {
    try {
      const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
      if (!domain) return json(res, 400, { error: 'Missing ?domain=' });
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
        return json(res, 400, { error: 'Invalid domain — expected something like jumbo.com' });
      }

      let bfKey = process.env.BRANDFETCH_API_KEY || '';
      if (!bfKey) {
        try {
          const secretsPath = path.join(__dirname, '.secrets.json');
          if (fs.existsSync(secretsPath)) {
            const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
            bfKey = secrets.BRANDFETCH_API_KEY || '';
          }
        } catch (_) { /* ignore */ }
      }
      if (!bfKey) {
        return json(res, 503, { error: 'BRANDFETCH_API_KEY not configured on the server' });
      }

      const bfUrl = `https://api.brandfetch.io/v2/brands/${encodeURIComponent(domain)}`;
      const bfRes = await fetch(bfUrl, {
        headers: { 'Authorization': `Bearer ${bfKey}`, 'Accept': 'application/json' },
      });
      if (!bfRes.ok) {
        const body = await bfRes.text();
        return json(res, bfRes.status, {
          error: `Brandfetch ${bfRes.status}: ${body.slice(0, 200)}`,
        });
      }
      const data = await bfRes.json();
      const colors = Array.isArray(data.colors)
        ? data.colors.filter(c => c && typeof c.hex === 'string')
        : [];
      return json(res, 200, {
        domain,
        name: data.name || '',
        colors: colors.map(c => ({
          hex: c.hex,
          type: c.type || 'unknown',
          brightness: typeof c.brightness === 'number' ? c.brightness : null,
        })),
      });
    } catch (err) {
      return json(res, 500, { error: 'Brandfetch request failed: ' + err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Google Slides OAuth config (for frontend)
  // GET /api/gslides/config
  // ──────────────────────────────────────
  if (url.pathname === '/api/gslides/config' && req.method === 'GET') {
    return json(res, 200, {
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      auth_url: GOOGLE_AUTH_URL,
      scopes: GOOGLE_SCOPES,
      has_secret: !!GOOGLE_CLIENT_SECRET,
      configured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    });
  }

  // ──────────────────────────────────────
  // API: Exchange OAuth code → access_token
  // POST /api/gslides/token  { code }
  // ──────────────────────────────────────
  if (url.pathname === '/api/gslides/token' && req.method === 'POST') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      const { code } = body;
      if (!code) return json(res, 400, { error: 'Missing code' });
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return json(res, 500, { error: 'Google OAuth is not configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.' });
      }

      const params = new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      });

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        return json(res, tokenRes.status, { error: 'Google token exchange failed', detail: tokenData });
      }
      return json(res, 200, tokenData);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Refresh Google OAuth token
  // POST /api/gslides/refresh  { refresh_token }
  // ──────────────────────────────────────
  if (url.pathname === '/api/gslides/refresh' && req.method === 'POST') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      const { refresh_token } = body;
      if (!refresh_token) return json(res, 400, { error: 'Missing refresh_token' });

      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type: 'refresh_token',
      });
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const tokenData = await tokenRes.json();
      return json(res, tokenRes.ok ? 200 : tokenRes.status, tokenData);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Upload PPTX → Google Drive with auto-convert to Google Slides.
  // POST /api/gslides/export
  // Headers: Authorization: Bearer <access_token from /api/gslides/token>
  // Body: multipart/form-data OR JSON: { filename, pptxBase64 }
  //
  // This is the simplest viable Google Slides integration — we already
  // generate a .pptx via python-pptx (generate.py → /api/generate), so we
  // just POST it to Google Drive with target mimeType
  // application/vnd.google-apps.presentation and Drive converts it.
  // Returns: { fileId, webViewLink }
  // ──────────────────────────────────────
  if (url.pathname === '/api/gslides/export' && req.method === 'POST') {
    try {
      const authHeader = req.headers['authorization'];
      if (!authHeader) return json(res, 401, { error: 'Missing Authorization header (Google access token)' });

      const body = JSON.parse((await collectBody(req)).toString());
      const { filename = 'notso-proposal.pptx', pptxBase64 } = body;
      if (!pptxBase64) return json(res, 400, { error: 'Missing pptxBase64 (base64-encoded .pptx bytes)' });

      const pptxBytes = Buffer.from(pptxBase64, 'base64');

      // Build multipart/related body by hand (Drive v3 expects this exact shape
      // for a single-request metadata + media upload).
      const boundary = '-------notso-' + Date.now().toString(36);
      const metadata = {
        name: filename.replace(/\.pptx$/i, ''),
        mimeType: 'application/vnd.google-apps.presentation', // request conversion on upload
      };
      const metaPart =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) + `\r\n`;
      const mediaHeader =
        `--${boundary}\r\n` +
        `Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`;
      const tail = `\r\n--${boundary}--`;

      const multipartBody = Buffer.concat([
        Buffer.from(metaPart, 'utf8'),
        Buffer.from(mediaHeader, 'utf8'),
        pptxBytes,
        Buffer.from(tail, 'utf8'),
      ]);

      const driveRes = await fetch(
        GOOGLE_DRIVE_UPLOAD + '&fields=id,name,webViewLink,mimeType',
        {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': String(multipartBody.length),
          },
          body: multipartBody,
        }
      );
      const driveData = await driveRes.json();
      if (!driveRes.ok) {
        return json(res, driveRes.status, { error: 'Google Drive upload failed', detail: driveData });
      }
      console.log(`  📊 Google Slides created: ${driveData.name} (${driveData.id})`);
      return json(res, 200, {
        fileId: driveData.id,
        name: driveData.name,
        webViewLink: driveData.webViewLink || `https://docs.google.com/presentation/d/${driveData.id}/edit`,
      });
    } catch (err) {
      console.error('gslides export error:', err);
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Suggest 9 bespoke mascot archetypes via Claude
  // POST /api/mascot/archetypes  { claudeKey, clientName, industry, useCase, desc, mascotName, mascotDesc }
  // Returns: { archetypes: [ "<short description>", ... 9 items ] }
  // ──────────────────────────────────────
  if (url.pathname === '/api/mascot/archetypes' && req.method === 'POST') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      const { claudeKey, clientName, industry, useCase = '', desc = '', mascotName = '', mascotDesc = '' } = body;
      if (!claudeKey) return json(res, 400, { error: 'Missing Claude API key' });

      const sys = `You are a senior character designer for notso.ai, a studio that creates cute 3D mascot characters for SaaS / consumer brands. Your job: propose 9 DIVERSE mascot concepts tailored to a specific client.

Rules:
- Mix animal, creature, object, food, and abstract archetypes — do NOT pick 9 animals.
- Every concept must fit the client's industry, product, and brand vibe.
- Each concept = ONE short descriptive sentence (12–25 words). Describe the archetype, body shape, personality hint, and 1 distinctive visual detail.
- No numbering, no headers — just the 9 sentences as a JSON array of strings.
- Do NOT include brand color or the word "brand-colored" (the server adds that).
- Do NOT mention "single character" or "transparent background" (the server adds those too).
- Be creative — if the client has an existing mascot concept (e.g. "blue monster"), make concept #1 match that style very closely, then explore 8 alternatives.

Output format — ONLY a JSON array, nothing else:
["Concept 1 description...", "Concept 2 description...", ..., "Concept 9 description..."]`;

      const userMsg = `Client: ${clientName}
Industry: ${industry}
Use case: ${useCase}
Description: ${desc}
${mascotName ? `Mascot name hint: ${mascotName}` : ''}
${mascotDesc ? `Mascot description/personality: ${mascotDesc}` : ''}

Propose 9 diverse mascot archetypes for this client. Return ONLY the JSON array.`;

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: sys,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });

      if (!anthropicRes.ok) {
        const errTxt = await anthropicRes.text();
        console.error('  ❌ Claude archetype error:', errTxt.slice(0, 300));
        return json(res, 500, { error: `Claude error ${anthropicRes.status}: ${errTxt.slice(0, 200)}` });
      }

      const data = await anthropicRes.json();
      const text = (data.content || []).map(c => c.text || '').join('\n').trim();
      // Parse JSON array from response
      let archetypes = [];
      try {
        // Strip possible code fences
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) archetypes = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error('  ⚠️ Failed to parse Claude JSON:', parseErr.message, 'raw:', text.slice(0, 300));
      }
      if (!Array.isArray(archetypes) || archetypes.length === 0) {
        return json(res, 500, { error: 'Claude did not return a valid archetype array', raw: text.slice(0, 500) });
      }
      console.log(`  ✨ Claude suggested ${archetypes.length} archetypes for ${clientName}`);
      return json(res, 200, { archetypes: archetypes.slice(0, 9) });
    } catch (err) {
      console.error('archetype endpoint error:', err);
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // Helper: post-process image for transparent background via rembg
  //   Calls post_process.py if Python3 + rembg are available.
  //   Accepts base64 PNG data, returns cleaned base64 PNG data.
  //   Falls back to original image if Python is unavailable (e.g. Vercel).
  // ──────────────────────────────────────
  async function postProcessImage(base64Data, mimeType = 'image/png') {
    return new Promise((resolve) => {
      const inputBuf = Buffer.from(base64Data, 'base64');
      const tmpIn = path.join(require('os').tmpdir(), `pp_in_${Date.now()}.png`);
      const tmpOut = tmpIn.replace('pp_in_', 'pp_out_');
      fs.writeFileSync(tmpIn, inputBuf);

      const scriptPath = path.join(__dirname, 'post_process.py');
      execFile('python3', [scriptPath, tmpIn, '--output', tmpOut], { timeout: 30000 }, (err, stdout, stderr) => {
        try {
          if (err || !fs.existsSync(tmpOut)) {
            // Python/rembg not available — return original image unchanged
            if (err) console.log(`    ℹ️  post_process.py unavailable (${err.message.slice(0, 80)}), returning raw image`);
            resolve(base64Data);
          } else {
            const cleaned = fs.readFileSync(tmpOut);
            console.log(`    🧹 Background removed via rembg (${inputBuf.length} → ${cleaned.length} bytes)`);
            resolve(cleaned.toString('base64'));
          }
        } finally {
          // Cleanup temp files
          try { fs.unlinkSync(tmpIn); } catch {}
          try { fs.unlinkSync(tmpOut); } catch {}
        }
      });
    });
  }

  // ──────────────────────────────────────
  // API: Generate mascot images via Gemini Imagen
  // POST /api/mascot/generate  { geminiKey, clientName, industry, mascotName, personality, color1, numOptions, variations? }
  // Returns: { images: [ { id, data_url }, ... ] }
  // ──────────────────────────────────────
  if (url.pathname === '/api/mascot/generate' && req.method === 'POST') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      const {
        geminiKey,
        clientName,
        industry,
        mascotName,
        personality,
        color1,
        numOptions = 9,
        referenceImage = '',          // legacy: single data-URL string
        referenceImages = [],         // NEW: array of data-URL strings (multiple refs)
        useExistingMascot = false,    // style-transfer mode (preserve client's existing mascot identity)
        faithfulMode = false,         // 100% faithful reproduction (no Notso eyes/brows)
        refPromptOverride = '',       // user-editable override for reference-image suffix
      } = body;

      if (!geminiKey) return json(res, 400, { error: 'Missing Gemini API key' });

      // ── Parse reference images (data URLs → base64 + mime type) for vision input.
      // Support both the new array and the legacy single-image field.
      const refList = [];
      const pushIfValid = (url) => {
        if (url && typeof url === 'string' && url.startsWith('data:')) {
          const m = url.match(/^data:([^;]+);base64,(.+)$/);
          if (m) refList.push({ inlineData: { mimeType: m[1], data: m[2] } });
        }
      };
      if (Array.isArray(referenceImages)) referenceImages.forEach(pushIfValid);
      if (refList.length === 0) pushIfValid(referenceImage); // fallback to legacy field
      const refImageParts = refList;
      const refImagePart = refImageParts[0] || null; // kept for downstream code paths
      if (refImageParts.length) {
        const totalKb = refImageParts.reduce(
          (n, p) => n + Math.round(p.inlineData.data.length * 0.75 / 1024), 0
        );
        console.log(`  🖼️  ${refImageParts.length} reference image(s) provided (~${totalKb}KB total)`);
      }

      // Style transfer mode is only meaningful if we actually have at least one reference image.
      const styleTransferMode = !!(useExistingMascot && refImageParts.length);
      const faithfulTransferMode = !!(faithfulMode && refImageParts.length);
      if (styleTransferMode) {
        console.log(`  🔁 Style-transfer mode ON — preserving client's existing mascot identity.`);
      }

      const brandColor = color1 || '#0068B7';
      const brandColorName = `${brandColor} brand signature colour`;

      // ── SINGLE-SUBJECT RULE (appended below the style lock positive prompt) ──
      // Kept outside build_style_prompt so it applies to every variation regardless
      // of what the style lock produces.
      const SINGLE_SUBJECT_RULE = `

★★★ CRITICAL SINGLE-SUBJECT RULE ★★★
- Generate EXACTLY ONE (1) SINGLE character in the frame. One mascot only. Not two. Not a pair. Not a duo. Not twins. Not a group. Not a family. Not multiple versions side-by-side.
- The image must contain a SINGLE SUBJECT — one body, one head, one face.
- If you would normally draw companions, pets, sidekicks, reflections, shadows-as-characters, or "before/after" versions, DO NOT. Draw only the one mascot described.
- NEGATIVE: no twins, no duplicates, no pair, no couple, no group, no two characters, no multiple mascots, no background characters, no second character in any form.`;

      console.log(`  🎨 Generating ${numOptions} mascot options via Gemini Imagen (style lock v${STYLE_VERSION}${styleTransferMode ? ', style-transfer' : ''})...`);

      // ── ARCHETYPE POOL ──────────────────────────────────────
      // 36 diverse archetypes: animals, creatures, objects, abstract, food, tech
      // Each is phrased with "ONE single" to reinforce the single-subject rule.
      // If the client doesn't pass a custom variations array, we auto-pick 9 from here.
      const archetypePool = [
        // Animals (expanded)
        'Friendly Fox: ONE single cute anthropomorphic fox standing upright, waving one paw, warm smile. Fluffy tail curled behind. Only one fox in the frame.',
        'Curious Cat: ONE single round chibi cat sitting on its haunches, head tilted, one paw raised to cheek. Only one cat in the frame.',
        'Energetic Puppy: ONE single cheerful puppy in dynamic action pose, both arms up, tongue out happily. Only one dog in the frame.',
        'Wise Owl: ONE single plump owl with wings slightly spread, thoughtful expression, big round glasses. Only one owl in the frame.',
        'Playful Bunny: ONE single tall fluffy rabbit with hands clasped, shy gentle smile, long floppy ears. Only one rabbit in the frame.',
        'Brave Bear: ONE single chubby teddy-bear in confident hero pose, hands on hips, determined smile. Only one bear in the frame.',
        'Cheerful Panda: ONE single roly-poly panda sitting cross-legged with snack in hand, eyes closed happily. Only one panda in the frame.',
        'Sleek Penguin: ONE single small waddling penguin with flippers extended in greeting, gentle proud smile. Only one penguin in the frame.',
        'Friendly Koala: ONE single round-faced koala standing upright with arms open for a hug, sleepy happy smile. Only one koala in the frame.',
        'Playful Otter: ONE single cute otter standing on back legs holding a tiny shell or pebble, bright curious eyes. Only one otter in the frame.',
        'Gentle Elephant: ONE single chibi elephant with tiny trunk raised in greeting, big floppy ears, warm expression. Only one elephant in the frame.',
        'Cheeky Hamster: ONE single round hamster with puffy cheeks, tiny paws held together, big shiny eyes. Only one hamster in the frame.',
        // Creatures / fantasy
        'Friendly Monster: ONE single fluffy blue monster with round body, big smile, two little horns or antennae, short arms. Only one monster in the frame.',
        'Cute Dragon: ONE single small chibi dragon with tiny wings, round body, friendly smile, puff of smoke from nose. Only one dragon in the frame.',
        'Tiny Unicorn: ONE single small round unicorn with pastel mane, sparkle eyes, gentle pose. Only one unicorn in the frame.',
        'Cloud Sprite: ONE single floating cloud-shaped character with face, tiny arms, peaceful smile, soft drifty feel. Only one cloud in the frame.',
        'Slime Character: ONE single glossy round blob/slime character with cute face and tiny nubs for arms, playful bouncy pose. Only one slime in the frame.',
        'Ghost Buddy: ONE single friendly round ghost character (not scary), big eyes, arms out for a hug, floating gently. Only one ghost in the frame.',
        // Objects / non-animals
        'Water Drop: ONE single anthropomorphic water drop with face and tiny arms, cheerful smile, refreshing vibe. Only one water drop in the frame.',
        'Leaf Sprite: ONE single green leaf-shaped character with face, tiny stem arms, fresh springtime feel, gentle smile. Only one leaf in the frame.',
        'Flame Buddy: ONE single warm friendly flame character with face, tiny arms, cozy glow, cheerful not scary. Only one flame in the frame.',
        'Star Pal: ONE single five-point star character with big happy face, tiny arms, sparkle vibe. Only one star in the frame.',
        'Sun Cutie: ONE single round sun character with rays, warm smile, arms out spreading joy. Only one sun in the frame.',
        'Raindrop Helper: ONE single long raindrop with face, tiny hands, gentle caring expression, small umbrella on head. Only one raindrop in the frame.',
        'Book Buddy: ONE single open-book character with face on the pages, tiny arms for the covers, smart friendly smile. Only one book in the frame.',
        'Gear Bot: ONE single gear-shaped robot character with face in the center hole, little arms, cheerful tinkerer vibe. Only one gear in the frame.',
        'Pixel Guy: ONE single blocky pixel-art style character in 3D clay render, round body, big eyes, 8-bit charm with a modern twist. Only one pixel guy in the frame.',
        'Little Robot: ONE single small rounded robot character with antennae, glowing cute eyes, tiny stubby limbs, friendly beep-boop vibe. Only one robot in the frame.',
        'Lightbulb Idea: ONE single lightbulb character with face on the bulb, tiny arms, glowing softly, bright excited expression. Only one lightbulb in the frame.',
        // Food (useful for F&B / nutrition / wellness clients)
        'Apple Friend: ONE single round red apple character with face, leaf on top, tiny arms, juicy fresh smile. Only one apple in the frame.',
        'Avocado Pal: ONE single avocado half with pit as a round face, tiny arms, healthy smile. Only one avocado in the frame.',
        'Dumpling Buddy: ONE single plump dumpling character with pleated top, cute face, tiny arms, warm cozy smile. Only one dumpling in the frame.',
        'Donut Dude: ONE single glossy donut with sprinkles, face on the front, tiny arms waving, playful sweet vibe. Only one donut in the frame.',
        'Egg Pal: ONE single round egg character with face, tiny hands, cheerful wake-up-ready pose. Only one egg in the frame.',
        // Sports / fitness
        'Dumbbell Coach: ONE single cartoon dumbbell character with face on the bar, tiny arms flexing little muscles, encouraging coach vibe. Only one dumbbell in the frame.',
        'Water Bottle Pal: ONE single reusable water bottle character with face, tiny arms, hydration hero feel. Only one bottle in the frame.',
      ];

      // Default selection: first 9 archetypes (stable + predictable)
      // If client passes body.variations, use that directly instead.
      const defaultVariations = archetypePool.slice(0, 9).map((desc, i) =>
        `Design ${i + 1} — ${desc} Full body, brand-colored accent clothing or accessory. PNG transparent background.`
      );
      const variations = (Array.isArray(body.variations) && body.variations.length >= 1)
        ? body.variations.slice(0, 9).map((desc, i) => {
            // Normalize: if client sent plain descriptions, wrap with Design N — prefix
            const hasPrefix = /^Design\s*\d+\s*—/i.test(desc);
            return hasPrefix ? desc : `Design ${i + 1} — ${desc} ONE single character only. Full body, PNG transparent background.`;
          })
        : defaultVariations;

      console.log(`  📝 Using ${variations.length} variations (source: ${Array.isArray(body.variations) && body.variations.length ? 'client-provided' : 'default pool'})`);

      // Models to try in order (public Gemini API image generation)
      const engine = body.engine || 'auto';
      let modelsToTry;
      if (engine === 'nano-banana') {
        modelsToTry = ['gemini-2.5-flash-image'];
      } else if (engine === 'nano-banana-pro') {
        modelsToTry = ['gemini-3-pro-image-preview'];
      } else if (engine === 'nano-banana-2') {
        modelsToTry = ['gemini-3.1-flash-image-preview'];
      } else if (engine === 'imagen4') {
        modelsToTry = ['__imagen4__'];
      } else if (engine === 'imagen4-fast') {
        modelsToTry = ['__imagen4fast__'];
      } else {
        // auto: try fastest first
        modelsToTry = [
          'gemini-2.5-flash-image',
          'gemini-3.1-flash-image-preview',
          'gemini-3-pro-image-preview',
          '__imagen4fast__',
        ];
      }

      // ── CRITICAL: Imagen's :predict endpoint takes text-only prompts.
      //    Any uploaded reference image is silently dropped when that path
      //    runs. Users reported "only 1 of 9 looks like my reference" —
      //    cause was this fallback. When refs are present, drop Imagen.
      if (refImageParts.length) {
        const before = modelsToTry.length;
        modelsToTry = modelsToTry.filter(m => m !== '__imagen4__' && m !== '__imagen4fast__');
        if (!modelsToTry.length) {
          // User explicitly chose Imagen + provided refs — keep it but warn.
          modelsToTry = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview'];
          console.log(`  ⚠️  Reference images provided but engine=${engine} is text-only; forcing Gemini multimodal models instead.`);
        } else if (modelsToTry.length < before) {
          console.log(`  🧷 Reference images provided — filtered Imagen out of model list (it can't see images). Remaining: ${modelsToTry.join(', ')}`);
        }
      }

      // Custom prompt override
      const customPrompt = body.customPrompt || null;

      const images = [];
      for (let i = 0; i < Math.min(numOptions, 9); i++) {
        const variationPrompt = variations[i] || `Variation ${i + 1}, unique design.`;

        // ── Derive species from the variation text so the style lock picks the
        //    right personification tier. Heuristic, defaults to humanoid.
        const lcVar = variationPrompt.toLowerCase();
        let speciesGuess = 'human';
        if (/\b(fox|cat|dog|puppy|owl|bunny|rabbit|bear|panda|penguin|koala|otter|elephant|hamster|husky|monster|dragon|unicorn|ghost|slime)\b/.test(lcVar)) {
          speciesGuess = 'animal';
        } else if (/\b(drop|leaf|flame|star|sun|raindrop|book|gear|lightbulb|apple|avocado|dumpling|donut|egg|dumbbell|bottle|cloud)\b/.test(lcVar)) {
          speciesGuess = 'object';
        }

        // ── Character description: client context + variation text (or custom override). ──
        const charDescription = customPrompt
          ? customPrompt
          : `${variationPrompt}\nContext: client "${clientName}" (${industry || 'retail'}), name "${mascotName || 'Buddy'}", personality ${personality || 'friendly, approachable, helpful'}.`;

        // ── Route through the style lock. Level 4 would throw — we catch and skip. ──
        let locked;
        try {
          locked = buildStylePrompt({
            characterDescription: charDescription,
            brandColorName,
            tier: 'hero',
            species: speciesGuess,
            mood: 'friendly',
            styleTransfer: styleTransferMode || faithfulTransferMode,
            faithfulTransfer: faithfulTransferMode,
          });
        } catch (lockErr) {
          console.error(`  ❌ Style lock rejected variation ${i + 1}: ${lockErr.message}`);
          continue;
        }

        // ── Reference-image suffix.
        //    In style-transfer mode the STYLE_TRANSFER_MODIFIER already told the
        //    model to preserve identity, so we don't need the "adapt the style"
        //    language. In normal mode the reference is just a style anchor.
        let refPromptSuffix = '';
        if (refImagePart) {
          // If user provided a manual override, use it verbatim.
          if (refPromptOverride && typeof refPromptOverride === 'string' && refPromptOverride.trim()) {
            refPromptSuffix = '\n\n' + refPromptOverride.trim();
          } else if (faithfulTransferMode) {
            refPromptSuffix = '\n\nREFERENCE IMAGE: This is the client\'s existing mascot. ' +
              'Reproduce this character with 100% fidelity — same silhouette, same species, ' +
              'same facial features, same eyes, same eyebrows, same head accessories, ' +
              'same colour palette, same pose if possible. ' +
              'Do NOT add any new features. Do NOT change the eye style. ' +
              'Do NOT change the eyebrow style. Do NOT alter any facial features. ' +
              'Do NOT invent a new character. The output must be immediately ' +
              'recognisable as the EXACT same character from the reference.';
          } else if (styleTransferMode) {
            refPromptSuffix = '\n\nREFERENCE IMAGE: This is the client\'s existing mascot. Preserve its identity — same silhouette, species, head features, body colour identity, and face layout. Change the rendering to Notso AI style described above. Keep the character\'s original eye and eyebrow design. Do not invent a new character.';
          } else {
            refPromptSuffix = '\n\nREFERENCE IMAGE (HIGHEST PRIORITY): The attached image(s) define the REQUIRED art style for this mascot. Match ALL of these properties exactly: art style (e.g. watercolor / vector / 3D clay / flat cartoon), line weight, character proportions (head-to-body ratio), eye style, colour palette (especially the dominant hue — if the reference is blue, your mascot MUST be predominantly blue), material/texture finish, lighting, and overall vibe. Use the SAME body type and silhouette family as the reference (e.g. if the reference is a round blob-like slime creature, generate a round blob-like creature — NOT an unrelated animal). You may vary the species/accessories for each variation, but the reference\'s visual language must be preserved faithfully. Apply the single-subject rule (exactly ONE character). This reference OVERRIDES any generic style hint in the prompt above.';
          }
        }

        // ── Final prompt = style-locked positive + single-subject rule + reference hint.
        //    Negative prompt is also carried via `locked.negative` for models that accept it.
        const fullPrompt = locked.positive + SINGLE_SUBJECT_RULE + refPromptSuffix;
        const negativePrompt = locked.negative;
        let generated = false;

        for (const modelName of modelsToTry) {
          if (generated) break;

          // ── Imagen 4 (uses :predict endpoint) ──
          if (modelName === '__imagen4__' || modelName === '__imagen4fast__') {
            const imgModelName = modelName === '__imagen4fast__'
              ? 'imagen-4.0-fast-generate-001'
              : 'imagen-4.0-generate-001';
            try {
              console.log(`  🔄 Trying ${imgModelName} (predict) for option ${i + 1}...`);
              const imgRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${imgModelName}:predict?key=${geminiKey}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    instances: [{ prompt: fullPrompt }],
                    parameters: { sampleCount: 1, aspectRatio: '1:1' }
                  })
                }
              );
              if (!imgRes.ok) {
                const errBody = await imgRes.text();
                console.log(`  ⚠️ ${imgModelName} returned ${imgRes.status}: ${errBody.slice(0, 300)}`);
              } else {
                const imgData = await imgRes.json();
                const predictions = imgData.predictions || [];
                if (predictions.length > 0 && predictions[0].bytesBase64Encoded) {
                  images.push({
                    id: `mascot_${i}`,
                    data_url: `data:image/png;base64,${predictions[0].bytesBase64Encoded}`
                  });
                  console.log(`  ✅ Option ${i + 1} generated via ${imgModelName}`);
                  generated = true;
                } else {
                  console.log(`  ⚠️ ${imgModelName} returned OK but no image predictions`);
                }
              }
            } catch (genErr) {
              console.error(`  ❌ ${imgModelName} error for option ${i}:`, genErr.message);
            }
            continue;
          }

          // ── Gemini generateContent models ──
          try {
            console.log(`  🔄 Trying model ${modelName} for option ${i + 1}...`);
            const reqParts = [{ text: fullPrompt }];
            // Prepend ALL reference images (in order) so the model sees them before the prompt.
            if (refImageParts.length) reqParts.unshift(...refImageParts);
            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: reqParts }],
                  generationConfig: {
                    responseModalities: ['TEXT', 'IMAGE'],
                  }
                })
              }
            );

            if (!geminiRes.ok) {
              const errBody = await geminiRes.text();
              console.log(`  ⚠️ ${modelName} returned ${geminiRes.status}: ${errBody.slice(0, 300)}`);
              continue;
            }

            const data = await geminiRes.json();
            const parts = data?.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.inlineData) {
                images.push({
                  id: `mascot_${i}`,
                  data_url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                });
                console.log(`  ✅ Option ${i + 1} generated via ${modelName}`);
                generated = true;
                break;
              }
            }
            if (!generated) {
              console.log(`  ⚠️ ${modelName} OK but no image in parts:`, JSON.stringify(parts.map(p => Object.keys(p))).slice(0, 200));
            }
          } catch (genErr) {
            console.error(`  ❌ ${modelName} error for option ${i}:`, genErr.message);
          }
        }

        if (!generated) {
          console.error(`  ❌ All models failed for option ${i + 1}`);
        }
      }

      console.log(`  ✅ Generated ${images.length} mascot images — running background removal...`);

      // Post-process: remove background via rembg for transparent PNG
      const cleanedImages = [];
      for (const img of images) {
        try {
          const [prefix, b64] = img.data_url.split(',');
          const mime = (prefix.match(/data:([^;]+)/) || [])[1] || 'image/png';
          const cleanedB64 = await postProcessImage(b64, mime);
          cleanedImages.push({
            id: img.id,
            data_url: `data:image/png;base64,${cleanedB64}`,
          });
        } catch (ppErr) {
          console.log(`    ⚠️ Post-process failed for ${img.id}: ${ppErr.message}, using raw`);
          cleanedImages.push(img);
        }
      }
      console.log(`  🎉 ${cleanedImages.length} mascot images ready (background removal applied)`);
      return json(res, 200, { images: cleanedImages });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Save selected mascot images to temp dir (for PPTX insertion)
  // POST /api/mascot/save  { images: { cover: "data:...", option_a: "data:...", option_b: "data:..." } }
  // Returns: { paths: { cover: "/tmp/mascot-cover.png", ... } }
  // ──────────────────────────────────────
  if (url.pathname === '/api/mascot/save' && req.method === 'POST') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      const { images } = body;
      const outputDir = require('os').tmpdir();
      const paths = {};

      for (const [key, dataUrl] of Object.entries(images || {})) {
        if (!dataUrl || !dataUrl.startsWith('data:')) continue;
        const base64Data = dataUrl.split(',')[1];
        if (!base64Data) continue;
        const filePath2 = path.join(outputDir, `mascot-${key}-${Date.now()}.png`);
        fs.writeFileSync(filePath2, Buffer.from(base64Data, 'base64'));
        paths[key] = filePath2;
      }

      return json(res, 200, { paths });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // In-memory session registry for Asset Pack (sessionId -> { outDir, meta, results })
  // Used to support incremental regeneration of failed items and on-demand zip download.
  // ──────────────────────────────────────
  if (!global.__assetpackSessions) global.__assetpackSessions = new Map();
  const assetpackSessions = global.__assetpackSessions;

  // ──────────────────────────────────────
  // API: Generate Asset Pack (expressions + actions + mockups)
  // POST /api/assetpack/generate
  //   { geminiKey, clientName, mascotName, brandColor, greeting, mascotImage, clientSiteImage,
  //     sessionId? (to reuse existing outDir), onlyIds? (regenerate only these task ids),
  //     tasks? (override task list entirely) }
  // Returns: JSON { sessionId, results: [...], successCount, failCount }
  // (Use /api/assetpack/download?sessionId=xxx to get the zip.)
  // ──────────────────────────────────────
  if (url.pathname === '/api/assetpack/generate' && req.method === 'POST') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      const {
        geminiKey, clientName = 'Client', mascotName = 'Buddy',
        brandColor = '#0068B7', greeting = '',
        mascotImage = '', clientSiteImage = '',
        tasks = null,
        sessionId: incomingSessionId = null,
        onlyIds = null,
      } = body;

      if (!geminiKey) return json(res, 400, { error: 'Missing Gemini API key' });
      if (!mascotImage && !incomingSessionId) return json(res, 400, { error: 'Missing mascot image (select one first)' });

      // Parse mascot image for vision input
      const parseDataUrl = (s) => {
        if (!s || typeof s !== 'string' || !s.startsWith('data:')) return null;
        const m = s.match(/^data:([^;]+);base64,(.+)$/);
        return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null;
      };
      const mascotPart = parseDataUrl(mascotImage);
      // Only require mascotPart on first generation (no session yet).
      // Regenerate calls (with sessionId) reuse the server-side cached reference.
      if (!mascotPart && !incomingSessionId) return json(res, 400, { error: 'Invalid mascot image data URL' });
      const sitePart = parseDataUrl(clientSiteImage);

      const hasSite = !!sitePart;
      console.log(`  🎁 Asset pack for ${clientName} / ${mascotName} (website: ${hasSite ? 'yes' : 'no'})`);

      // Default task list — 18 images total
      const defaultTasks = [
        // 6 EXPRESSIONS (use mascot image as reference, transparent background)
        { id: 'expr-happy',        category: 'expressions', label: 'Happy',        transparent: true, prompt: `The SAME mascot character shown in the reference image (same face, same outfit, same art style), now showing a big bright joyful smile, eyes sparkling with happiness, both hands near the cheeks or clasped together. Full body, single character only. PNG with fully transparent background.` },
        { id: 'expr-empathetic',   category: 'expressions', label: 'Empathetic',   transparent: true, prompt: `The SAME mascot character from the reference image, now with a soft caring gentle expression, head tilted slightly, one hand placed over the heart, eyebrows slightly raised showing understanding and empathy. Full body, single character only. PNG transparent background.` },
        { id: 'expr-curious',      category: 'expressions', label: 'Curious',      transparent: true, prompt: `The SAME mascot character from the reference image, now with a curious inquisitive expression, head tilted, one finger on chin, wide interested eyes, small question-mark feeling in the air. Full body, single character only. PNG transparent background.` },
        { id: 'expr-celebrating',  category: 'expressions', label: 'Celebrating',  transparent: true, prompt: `The SAME mascot character from the reference image, now celebrating — both arms raised high in the air, mouth open in cheer, confetti-like energy around but no actual confetti blocking the character. Full body, single character only. PNG transparent background.` },
        { id: 'expr-apologetic',   category: 'expressions', label: 'Apologetic',   transparent: true, prompt: `The SAME mascot character from the reference image, now with an apologetic expression — small nervous smile, one hand rubbing the back of the head or neck, shoulders slightly hunched, eyes looking up. Full body, single character only. PNG transparent background.` },
        { id: 'expr-helpful',      category: 'expressions', label: 'Helpful',      transparent: true, prompt: `The SAME mascot character from the reference image, now in a helpful pose — gesturing forward with an open palm offering assistance, warm welcoming smile, slight forward lean. Full body, single character only. PNG transparent background.` },

        // 6 ACTIONS
        { id: 'act-waving',        category: 'actions',     label: 'Waving',       transparent: true, prompt: `The SAME mascot character from the reference image, now waving one hand in friendly hello gesture, big smile, free hand at side or on hip. Full body, single character only. PNG transparent background.` },
        { id: 'act-thumbs-up',     category: 'actions',     label: 'Thumbs Up',    transparent: true, prompt: `The SAME mascot character from the reference image, now giving a big thumbs-up gesture with one hand, confident proud smile, the other hand on hip. Full body, single character only. PNG transparent background.` },
        { id: 'act-typing',        category: 'actions',     label: 'Typing Laptop',transparent: true, prompt: `The SAME mascot character from the reference image, now sitting and typing on a cute small laptop computer balanced on lap or tiny desk, focused friendly expression. The character and the laptop are the only things in the frame. Single character only. PNG transparent background.` },
        { id: 'act-pointing',      category: 'actions',     label: 'Pointing',     transparent: true, prompt: `The SAME mascot character from the reference image, now pointing excitedly to the side (as if pointing at a slide or chart), big enthusiastic smile, other hand on waist. Full body, single character only. PNG transparent background.` },
        { id: 'act-presenting',    category: 'actions',     label: 'Presenting',   transparent: true, prompt: `The SAME mascot character from the reference image, now in a presenting pose — one arm extended to the side with open palm showcasing something, the other hand near the body, professional cheerful smile. Full body, single character only. PNG transparent background.` },
        { id: 'act-tablet',        category: 'actions',     label: 'Holding Tablet',transparent:true, prompt: `The SAME mascot character from the reference image, now holding a cute small tablet device with both hands, looking at it with interested friendly smile. The character and the tablet are the only objects. Single character only. PNG transparent background.` },

        // FESTIVE (3) — transparent PNG
        { id: 'fest-birthday',     category: 'festive',     label: 'Birthday',     transparent: true, prompt: `The SAME mascot character from the reference image, now wearing a cute little cone-shaped birthday party hat, holding a small birthday cupcake with a lit candle on top, warm joyful celebration expression. Full body, single character only. PNG transparent background.` },
        { id: 'fest-christmas',    category: 'festive',     label: 'Christmas',    transparent: true, prompt: `The SAME mascot character from the reference image, now wearing a red Santa hat with white fluffy trim, holding a small wrapped Christmas present box, cozy warm smile. Winter holiday feeling. Full body, single character only. PNG transparent background.` },
        { id: 'fest-newyear',      category: 'festive',     label: 'New Year',     transparent: true, prompt: `The SAME mascot character from the reference image, now holding up a small sign or banner that says "Happy New Year" in clear readable letters, wearing a tiny party hat, cheerful celebratory pose. Full body, single character only. PNG transparent background.` },

        // MOCKUPS (keep background)
        { id: 'mock-phone-chat',   category: 'mockups',     label: 'Phone Chat',   transparent: false, prompt: `A professional product mockup image showing a modern smartphone (like iPhone) with a rounded purple frame held against a light background. Inside the phone screen, the SAME mascot character from the reference image is shown standing behind a cute small red helpdesk counter (like a welcome kiosk). Above the mascot's head, a white speech bubble contains the text: "${(greeting || `Hi, I'm ${mascotName}! How can I help you today?`).replace(/"/g, '\\"')}". At the bottom of the phone screen a small text input bar that says "Ask a question" with a send arrow. The mascot is the ONLY character in the scene. Clean, marketing-quality product shot composition.` },
      ];

      if (hasSite) {
        defaultTasks.push({
          id: 'mock-website',
          category: 'mockups',
          label: 'Website Composite',
          transparent: false,
          needsSite: true,
          prompt: `A marketing composite image: use the second reference image (the client's website screenshot) as the website background layout on the left 70% of the frame. On the right-bottom 30%, overlay the SAME mascot character from the first reference image, positioned as if it's a chat widget popping up from the corner of the website. Above the mascot, show a clean white rounded rectangle chat bubble containing the text: "${(greeting || `Hi, I'm ${mascotName}! How can I help?`).replace(/"/g, '\\"')}". The mascot should appear sized appropriately as a chat-widget character (not filling the whole screen). Keep the website's original colors and layout visible. The mascot is the only character. Professional product-page screenshot composition.`
        });
      }

      // Resolve task list
      let finalTasks = (Array.isArray(tasks) && tasks.length) ? tasks : defaultTasks;

      // ── Session handling ──
      // If regenerating: reuse existing outDir and merge results.
      let sessionId = incomingSessionId;
      let session = sessionId ? assetpackSessions.get(sessionId) : null;
      let outDir, existingResults;

      // ── Cold-start resilience ─────────────────────────────────────
      // On Vercel serverless, `global.__assetpackSessions` (the Map) and
      // `/tmp` both evaporate between cold-started invocations. We can't
      // rely on either persisting. Strategy:
      //   1. If the client provided `sessionId` but we've lost state,
      //      silently rebuild using `mascotImage` from the body.
      //   2. Persist mascot-ref.png to {outDir}/mascot-ref.png so that
      //      warm containers (where /tmp survived) can still reuse it.
      //   3. If neither mascot-from-body nor mascot-from-disk is
      //      available, THEN fail and ask client to restart.
      // ─────────────────────────────────────────────────────────────
      const tryReadMascotFromDisk = (dir) => {
        try {
          const p = path.join(dir, 'mascot-ref.png');
          if (!fs.existsSync(p)) return null;
          const buf = fs.readFileSync(p);
          return { inlineData: { mimeType: 'image/png', data: buf.toString('base64') } };
        } catch (_) { return null; }
      };
      const tryReadSiteFromDisk = (dir) => {
        try {
          const p = path.join(dir, 'site-ref.png');
          if (!fs.existsSync(p)) return null;
          const buf = fs.readFileSync(p);
          return { inlineData: { mimeType: 'image/png', data: buf.toString('base64') } };
        } catch (_) { return null; }
      };

      if (session) {
        outDir = session.outDir;
        existingResults = session.results || [];
        console.log(`  ♻️  Reusing session ${sessionId} (${existingResults.length} existing results)`);
        if (Array.isArray(onlyIds) && onlyIds.length) {
          const pool = defaultTasks;
          finalTasks = pool.filter(t => onlyIds.includes(t.id));
          console.log(`  🎯 Regenerating only: ${finalTasks.map(t=>t.id).join(', ')}`);
        }
      } else if (sessionId) {
        // Known sessionId but we've lost state (cold start). Rebuild around
        // the same sessionId so the /tmp layout stays consistent if it's
        // there, and try to recover mascot reference from disk.
        outDir = path.join(require('os').tmpdir(), `assetpack-${sessionId}`);
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
        existingResults = [];
        session = {
          outDir,
          meta: { clientName, mascotName, brandColor, greeting },
          results: [],
          mascotPart: mascotPart || tryReadMascotFromDisk(outDir),
          sitePart: sitePart || tryReadSiteFromDisk(outDir),
          createdAt: Date.now(),
        };
        assetpackSessions.set(sessionId, session);
        console.log(`  🧊 Cold-start rebuild for ${sessionId} → ${outDir}`);
        if (Array.isArray(onlyIds) && onlyIds.length) {
          const pool = defaultTasks;
          finalTasks = pool.filter(t => onlyIds.includes(t.id));
          console.log(`  🎯 Regenerating only: ${finalTasks.map(t=>t.id).join(', ')}`);
        }
      } else {
        sessionId = `ap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        outDir = path.join(require('os').tmpdir(), `assetpack-${sessionId}`);
        fs.mkdirSync(outDir, { recursive: true });
        existingResults = [];
        session = {
          outDir,
          meta: { clientName, mascotName, brandColor, greeting },
          results: [],
          mascotPart,
          sitePart,
          createdAt: Date.now(),
        };
        assetpackSessions.set(sessionId, session);
        console.log(`  🆕 New session ${sessionId} → ${outDir}`);
      }

      // Use stored mascot/site parts if not provided on this call (pure regenerate)
      const effectiveMascotPart = mascotPart || session.mascotPart;
      const effectiveSitePart = sitePart || session.sitePart;
      if (!effectiveMascotPart) {
        return json(res, 400, {
          error: 'Missing mascot image — session has no stored mascot, please start a new Asset Pack.',
          code: 'SESSION_MASCOT_MISSING',
        });
      }

      // Persist mascot / site reference to disk so warm containers can
      // reuse them even if the in-memory Map was dropped. Best-effort.
      try {
        const mpath = path.join(outDir, 'mascot-ref.png');
        if (!fs.existsSync(mpath) && effectiveMascotPart?.inlineData?.data) {
          fs.writeFileSync(mpath, Buffer.from(effectiveMascotPart.inlineData.data, 'base64'));
        }
        if (effectiveSitePart?.inlineData?.data) {
          const spath = path.join(outDir, 'site-ref.png');
          if (!fs.existsSync(spath)) {
            fs.writeFileSync(spath, Buffer.from(effectiveSitePart.inlineData.data, 'base64'));
          }
        }
        // Update the session's cached parts so subsequent calls (warm) don't need the body.
        session.mascotPart = effectiveMascotPart;
        if (effectiveSitePart) session.sitePart = effectiveSitePart;
      } catch (e) { console.warn('  ⚠️ could not persist ref images:', e.message); }

      // Ensure per-category subdirs exist
      const categories = new Set(finalTasks.map(t => t.category));
      for (const cat of categories) fs.mkdirSync(path.join(outDir, cat), { recursive: true });

      const modelName = 'gemini-2.5-flash-image';
      const fallbackModels = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview'];
      const newResults = [];

      for (const task of finalTasks) {
        console.log(`  🎨 Generating: ${task.category}/${task.label}`);
        let saved = false;
        let lastErr = '';
        // Try up to 2 models × 2 attempts each = 4 tries per task
        for (const m of fallbackModels) {
          if (saved) break;
          for (let attempt = 1; attempt <= 2; attempt++) {
            if (saved) break;
            try {
              const reqParts = [effectiveMascotPart];
              if (task.needsSite && effectiveSitePart) reqParts.push(effectiveSitePart);
              const retryHint = attempt > 1 ? '\n\n[Retry: previous attempt did not produce an image. Please output a PNG image as the response.]' : '';
              // Extra background-colour hint — Gemini occasionally returns a
              // solid black (or cream) studio background even when asked for
              // transparent PNG. This reminder with an explicit WHITE fallback
              // makes the client-side chroma-key far more reliable.
              const bgHint = '\n\n[BACKGROUND: Output MUST be a plain pure #FFFFFF white background or fully transparent PNG. DO NOT use black, dark, gradient, scenery, studio, or coloured backgrounds. A flat pure-white background is strongly preferred if transparency is not possible.]';
              reqParts.push({ text: task.prompt + '\n\n[STRICT: single-subject only — exactly ONE mascot character in the output, no duplicates.]' + bgHint + retryHint });

              const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${geminiKey}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [{ parts: reqParts }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
                  })
                }
              );

              if (!geminiRes.ok) {
                const errBody = await geminiRes.text();
                lastErr = `HTTP ${geminiRes.status} (${m})`;
                console.log(`    ⚠️ ${task.label} ${m} try ${attempt} failed ${geminiRes.status}: ${errBody.slice(0, 160)}`);
                continue;
              }

              const data = await geminiRes.json();
              const respParts = data?.candidates?.[0]?.content?.parts || [];
              for (const part of respParts) {
                if (part.inlineData) {
                  let imageB64 = part.inlineData.data;

                  // Post-process: remove background for transparent assets
                  if (task.transparent) {
                    try {
                      imageB64 = await postProcessImage(imageB64, part.inlineData.mimeType || 'image/png');
                    } catch (ppErr) {
                      console.log(`    ⚠️ Post-process failed for ${task.label}: ${ppErr.message}, using raw`);
                    }
                  }

                  const fname = `${task.id}.png`;
                  const fpath = path.join(outDir, task.category, fname);
                  fs.writeFileSync(fpath, Buffer.from(imageB64, 'base64'));
                  // Also return as data URL so the client doesn't depend on
                  // /tmp or the in-memory Map surviving — both evaporate on
                  // Vercel cold starts. Client displays images directly
                  // from the data URL and can bundle them into a ZIP
                  // without a server round-trip.
                  const dataUrl = `data:image/png;base64,${imageB64}`;
                  newResults.push({
                    id: task.id, category: task.category, label: task.label,
                    transparent: task.transparent, ok: true,
                    file: `${task.category}/${fname}`,
                    dataUrl,
                  });
                  console.log(`    ✅ ${task.label} → ${fname} (${m} try ${attempt})`);
                  saved = true;
                  break;
                }
              }
              if (!saved) {
                lastErr = `no image in response (${m})`;
                console.log(`    ⚠️ ${task.label} ${m} try ${attempt}: no image in response`);
              }
            } catch (err) {
              lastErr = err.message;
              console.error(`    ❌ ${task.label} ${m} try ${attempt}: ${err.message}`);
            }
          }
        }
        if (!saved) {
          newResults.push({
            id: task.id, category: task.category, label: task.label,
            transparent: task.transparent, ok: false, error: lastErr || 'unknown',
          });
        }
      }

      // Merge: new results replace existing ones with same id
      const byId = new Map();
      for (const r of existingResults) byId.set(r.id, r);
      for (const r of newResults) byId.set(r.id, r);
      const mergedResults = Array.from(byId.values());

      session.results = mergedResults;
      session.meta = { clientName, mascotName, brandColor, greeting };

      // Update manifest on disk
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
        clientName, mascotName, brandColor,
        generatedAt: new Date().toISOString(),
        sessionId,
        results: mergedResults,
      }, null, 2));

      const successCount = mergedResults.filter(r => r.ok).length;
      const failCount = mergedResults.filter(r => !r.ok).length;

      return json(res, 200, {
        sessionId,
        results: mergedResults,
        successCount,
        failCount,
        downloadUrl: `/api/assetpack/download?sessionId=${encodeURIComponent(sessionId)}`,
      });
    } catch (err) {
      console.error('assetpack error:', err);
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Download the zip for a previously-generated Asset Pack session
  // GET /api/assetpack/image?sessionId=...&file=expressions/expr-happy.png
  //   Serves individual asset pack images for inline preview in the UI.
  // ──────────────────────────────────────
  if (url.pathname === '/api/assetpack/image' && req.method === 'GET') {
    try {
      const sessionId = url.searchParams.get('sessionId');
      const file = url.searchParams.get('file');
      if (!sessionId || !file) return json(res, 400, { error: 'Missing sessionId or file' });
      const session = assetpackSessions.get(sessionId);
      if (!session) return json(res, 404, { error: 'Session not found or expired' });

      // Sanitize file path to prevent directory traversal
      const safeName = file.replace(/\.\./g, '').replace(/^\//, '');
      const fpath = path.join(session.outDir, safeName);
      if (!fpath.startsWith(session.outDir)) return json(res, 403, { error: 'Invalid path' });
      if (!fs.existsSync(fpath)) return json(res, 404, { error: 'File not found' });

      const ext = path.extname(fpath).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'image/png';
      const stat = fs.statSync(fpath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(fpath).pipe(res);
      return;
    } catch (err) {
      console.error('assetpack image error:', err);
      return json(res, 500, { error: err.message });
    }
  }

  // GET /api/assetpack/download?sessionId=...
  // ──────────────────────────────────────
  if (url.pathname === '/api/assetpack/download' && req.method === 'GET') {
    try {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return json(res, 400, { error: 'Missing sessionId' });
      const session = assetpackSessions.get(sessionId);
      if (!session) return json(res, 404, { error: 'Session not found or expired' });

      const zipName = `${(session.meta.clientName || 'client').replace(/[^\w\-]/g, '_')}-assetpack-${Date.now()}.zip`;
      const zipPath = path.join(require('os').tmpdir(), zipName);

      await new Promise((resolve, reject) => {
        const pyScript = path.join(__dirname, 'zip_assetpack.py');
        execFile('python3', [pyScript, session.outDir, zipPath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) { console.error('zip_assetpack.py error:', stderr || err.message); reject(err); }
          else { console.log('  📦 Zip created:', zipName); resolve(); }
        });
      });

      const stat = fs.statSync(zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"`,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
      });
      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(zipPath); } catch {}
      });
      return;
    } catch (err) {
      console.error('assetpack download error:', err);
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Generate PPTX or PDF (server-side)
  // ──────────────────────────────────────
  // POST /api/preview  — returns raw HTML for Preview & Edit mode
  // ──────────────────────────────────────
  if (url.pathname === '/api/preview' && req.method === 'POST') {
    try {
      const body = await collectBody(req);
      const data = JSON.parse(body.toString());
      const outputDir = require('os').tmpdir();
      const proposalData = { ...data.proposal };
      if (data.mascotImages) proposalData._mascot_images = data.mascotImages;
      const payload = JSON.stringify({ format: 'html', proposal: proposalData, client: data.client, output_dir: outputDir, selected_slides: data.selectedSlides || null });

      const generatorScript = path.join(__dirname, 'generate_html.js');
      return new Promise((resolve) => {
        const proc = execFile('node', [generatorScript], { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
          if (err) {
            json(res, 500, { error: 'Preview generation failed: ' + (stderr || err.message) });
            return resolve();
          }
          try {
            const result = JSON.parse(stdout.trim());
            if (!result.success) { json(res, 500, { error: result.error || 'Unknown error' }); return resolve(); }
            // Return the HTML directly
            json(res, 200, { success: true, html: result.html || '' });
            // Clean up temp file
            try { if (result.path) fs.unlinkSync(result.path); } catch {}
            resolve();
          } catch (parseErr) {
            json(res, 500, { error: 'Invalid response from generator' });
            resolve();
          }
        });
        proc.stdin.write(payload);
        proc.stdin.end();
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // POST /api/generate  { format: "pptx"|"pdf", proposal: {...}, client: {...} }
  //   PDF → node generate_html.js (HTML template → Puppeteer → PDF)
  //   PPTX → python3 generate.py (python-pptx, legacy)
  // ──────────────────────────────────────
  if (url.pathname === '/api/generate' && req.method === 'POST') {
    try {
      const body = await collectBody(req);
      const data = JSON.parse(body.toString());
      const fmt = data.format || 'pptx';
      const isVercel = !!process.env.VERCEL;

      // Merge mascot image paths into proposal if provided.
      const proposalData = { ...data.proposal };
      if (data.mascotImages) proposalData._mascot_images = data.mascotImages;

      // PDF path: call generate_html.js in-process. Works both locally and on
      // Vercel serverless (no subprocess to spawn, no CLI bundling surprises).
      if (fmt === 'pdf') {
        try {
          const { buildProposalHtml, generatePDFBuffer } = require('./generate_html');
          const html = buildProposalHtml({
            proposal: proposalData,
            client: data.client,
            selected_slides: data.selectedSlides || null,
          });
          const pdfBuf = await generatePDFBuffer(html);
          const safeName = (data.client?.name || 'draft').replace(/[^\w\-]/g, '-').replace(/-+/g, '-');
          const fileName = `notso-proposal-${safeName}.pdf`;
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
            'Content-Length': pdfBuf.length,
            'Access-Control-Allow-Origin': '*',
          });
          return res.end(pdfBuf);
        } catch (err) {
          console.error('PDF generation error:', err);
          return json(res, 500, { error: 'PDF generation failed: ' + (err.message || err) });
        }
      }

      // PPTX path: python-pptx. Not available on Vercel serverless (no python3
      // runtime bundled). Fail fast with a clear message.
      if (fmt === 'pptx' && isVercel) {
        return json(res, 501, {
          error: 'PPTX export is not available on the deployed site yet. Please use the PDF export, or run the proposal generator locally to get a .pptx.',
        });
      }

      // PPTX path (local only): keep the existing python3 subprocess.
      const outputDir = require('os').tmpdir();
      const payload = JSON.stringify({ format: fmt, proposal: proposalData, client: data.client, output_dir: outputDir, selected_slides: data.selectedSlides || null });
      const generatorCmd = 'python3';
      const generatorScript = path.join(__dirname, 'generate.py');

      return new Promise((resolve) => {
        const proc = execFile(generatorCmd, [generatorScript], { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
          if (err) {
            console.error(`${path.basename(generatorScript)} error:`, stderr || err.message);
            json(res, 500, { error: 'Generation failed: ' + (stderr || err.message) });
            return resolve();
          }
          try {
            const result = JSON.parse(stdout.trim());
            if (!result.success) {
              json(res, 500, { error: result.error || 'Unknown error' });
              return resolve();
            }
            const filePath2 = result.path;
            const fileName = result.filename;
            const stat = fs.statSync(filePath2);
            const ext = path.extname(fileName).toLowerCase();
            res.writeHead(200, {
              'Content-Type': MIME[ext] || 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
              'Content-Length': stat.size,
              'Access-Control-Allow-Origin': '*',
            });
            const stream = fs.createReadStream(filePath2);
            stream.pipe(res);
            stream.on('end', () => { try { fs.unlinkSync(filePath2); } catch {} resolve(); });
          } catch (parseErr) {
            console.error(`${path.basename(generatorScript)} parse error:`, stdout, parseErr);
            json(res, 500, { error: 'Invalid response from generator' });
            resolve();
          }
        });
        proc.stdin.write(payload);
        proc.stdin.end();
      });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // API: Build slides mapping JSON (for debugging / inspection).
  // POST /api/slides/mapping  { proposal, client }
  // ──────────────────────────────────────
  if (url.pathname === '/api/slides/mapping' && req.method === 'POST') {
    try {
      const body = JSON.parse((await collectBody(req)).toString());
      const { proposal, client: clientData } = body;
      if (!proposal || !clientData) {
        return json(res, 400, { error: 'Missing proposal or client data' });
      }
      const mapping = buildSlidesMapping(proposal, clientData);
      return json(res, 200, { mapping });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ──────────────────────────────────────
  // STATIC FILES
  // ──────────────────────────────────────
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
};

// Export the handler so Vercel's @vercel/node runtime can invoke it as a
// serverless function. See vercel.json → routes "(.*) → /server.js".
module.exports = handler;

// Only start a listening HTTP server when this file is run directly with
// `node server.js`. When imported by Vercel the handler is used in-process
// and no port is bound.
if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  ✅  notso.ai Proposal Generator is running!`);
    console.log(`  📎  Open http://127.0.0.1:${PORT}\n`);
    const gOK = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
    console.log(`  Google Slides OAuth: ${gOK ? '✅ configured' : '⚠️  not configured (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars to enable /api/gslides/export)'}`);
    if (gOK) console.log(`  Redirect URI:        ${GOOGLE_REDIRECT_URI}`);
    console.log('');
  });
}
