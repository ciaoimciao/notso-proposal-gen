# notso-proposal-gen — Architecture

A single-page app that builds a full 18-slide AI-product proposal (PDF / PPTX / Google Slides) from a short Step-1 form. Claude drafts the copy, Gemini generates the mascot, Puppeteer renders the PDF. Deployed on Vercel.

> **Audience:** future-you, a teammate, or a pair-programmer. Start here before changing anything non-trivial.

---

## 1. The 3-step user flow

```
STEP 1 ─────────────  STEP 2 ────────────────  STEP 3 ───────────────────
Client Info           Generating               Preview & Export
                                                
• Client name         • Claude drafts copy     • Unified editor
• Industry            • Gemini draws mascot      (left: slide tree
• Website URL         • post-processing:         middle: slide stage
  └─ Brandfetch         chroma-key, resize       right: sidebar with
     auto-pulls        • 9 backup mascots          palette + styles)
     brand colors                                
• Use case            ────> writes to:         • Pick design style
• Description           proposal.json          • Pick palette (live)
• Mascot refs           savedMascotPaths        • Adjust Main color
• Design style                                  • Edit text / mascot
                                                • Export PDF / PPTX /
                                                  Google Slides
```

Data moves through three state containers:

- `client` — Step-1 form output (name, colors, useCase, designStyle, …)
- `proposal` — Claude-authored slide content (s1..s18 structured objects)
- `savedMascotPaths` — base64 images per slide slot, indexed by key
- `_assetPackSession` — expression / pose variants generated for mascot

Together they're everything `buildProposalHtml()` needs to render the deck.

---

## 2. Components

```
                         ┌────────────────────────────────────────────┐
                         │  index.html (single-page app, vanilla JS)  │
                         │  ── Step 1 / 2 / 3 views                   │
                         │  ── palette picker, unified editor         │
                         │  ── i18n (EN / ZH-TW / JA)                 │
                         │  ── localStorage auto-save                 │
                         └──────────────────┬─────────────────────────┘
                                            │  HTTP
                         ┌──────────────────▼─────────────────────────┐
                         │  server.js (Node http, ~2.6K LOC)          │
                         │  Routes all /api/* (see §3)                │
                         └──────┬────────────┬───────────┬────────────┘
                                │            │           │
                     ┌──────────▼──┐   ┌─────▼─────┐  ┌──▼────────────┐
                     │  Anthropic  │   │   Gemini  │  │  Brandfetch   │
                     │   Claude    │   │  (images) │  │   (colors)    │
                     └─────────────┘   └───────────┘  └───────────────┘

  PDF export path:                 PPTX export path (local only):
  ─────────────────                ────────────────────────────────
  server.js                        server.js
    → generate_html.js               → python3 generate.py
      → buildProposalHtml              → python-pptx builds .pptx
      → Puppeteer renders PDF        → post_process.py
      → (on Vercel: @sparticuz/        (fixes fonts, chroma-keys
        chromium-min)                   mascots, resizes, etc.)
```

### Key files

| File | Role | Size |
|---|---|---|
| `index.html` | Whole SPA — HTML + CSS + all JS inline | ~360 KB |
| `server.js` | HTTP router + all API handlers | ~97 KB |
| `generate_html.js` | Slide renderer: `buildProposalHtml()` + Puppeteer bridge | ~98 KB |
| `generate.py` | PPTX builder (python-pptx) — local-only path | ~120 KB |
| `post_process.py` | Post-export mascot cleanup (chroma-key, resize) | ~10 KB |
| `notso_style_prompt.js` | **Style lock** — all mascot prompts route through this | ~19 KB |
| `notso_style_lock.md` | Canonical brand-style rules enforced at prompt layer | — |
| `fixtures/demo/*.json` | 5 realistic Step-1 presets (Save the Children, WWF, …) | — |

### Hard rule: the style lock

Every call to Gemini for a mascot image **must** go through `notso_style_prompt.js`. Do not build mascot prompts anywhere else — the style lock is what keeps mascots on-brand across features. See header comments in `server.js` and the lock file for the contract.

---

## 3. API endpoints (`/api/*`)

All routes live in `server.js` and are dispatched by path. Vercel routes every request to `server.js` via `vercel.json`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/config` | GET | Frontend fetches API-key availability + fixtures at boot |
| `/api/brandfetch?domain=x.com` | GET | Server-side Brandfetch proxy → returns up to 4 brand hex colors |
| `/api/preview` | POST | Render 1 slide's HTML (used by unified editor for live preview) |
| `/api/generate` | POST | **Main export.** Returns PDF (Puppeteer) or PPTX (python-pptx) |
| `/api/mascot/archetypes` | POST | Claude generates 3 mascot archetypes for user to pick from |
| `/api/mascot/generate` | POST | Gemini renders mascot images based on picked archetype |
| `/api/mascot/save` | POST | Persists chosen mascot to `client` + local cache |
| `/api/assetpack/generate` | POST | Expression/pose asset pack (9 variants per mascot) |
| `/api/assetpack/sessions` | GET | List asset-pack sessions |
| `/api/assetpack/push-image` | POST | Push user-uploaded image into the asset pack pipeline |
| `/api/assetpack/image` | GET | Serve a single asset-pack image by ID |
| `/api/assetpack/download` | GET | Zip & download a whole asset pack |
| `/api/gslides/config` | GET | Frontend checks whether Google Slides export is configured |
| `/api/gslides/token` | POST | Exchange OAuth code → access token |
| `/api/gslides/refresh` | POST | Refresh access token |
| `/api/gslides/export` | POST | Upload .pptx to Drive, convert to Google Slides |
| `/api/slides/mapping` | POST | Return slide-id → title map (for the editor tree) |

---

## 4. Environment variables

All keys live in Vercel → Settings → Environment Variables (prod) or `.env` / `.secrets.json` (local).

| Name | Used by | Required? |
|---|---|---|
| `CLAUDE_API_KEY` | Proposal copy generation | ✅ Yes |
| `GEMINI_API_KEY` | Mascot image generation + asset pack | ✅ Yes |
| `BRANDFETCH_API_KEY` (or `BRANDFETCH_KEY`) | Step 1 auto-fill colors | Optional — falls back gracefully |
| `GOOGLE_CLIENT_ID` | Google Slides export | Optional |
| `GOOGLE_CLIENT_SECRET` | Google Slides export | Optional |
| `GOOGLE_REDIRECT_URI` | Google Slides OAuth callback | Optional (defaults to `http://127.0.0.1:8080`) |
| `VERCEL` | Auto-set by Vercel — used to branch code paths (e.g. skip python) | — |
| `AWS_EXECUTION_ENV` | Set to force `@sparticuz/chromium-min` to extract AL2023 libs on Vercel | Set in `vercel.json` |

> **Never commit secrets.** `.env` is gitignored. `.env.example` and `.secrets.example.json` hold placeholders for teammates to copy.

---

## 5. Build & deploy

### Local dev

```bash
npm install
cp .env.example .env          # fill in keys
node server.js                # open http://127.0.0.1:8080
```

### Tests

```bash
npm test                      # smoke test — ~1s, checks happy path
```

Runs:

1. `node --check server.js` — syntax
2. Module exports on `generate_html.js`
3. Full HTML generation from `fixtures/demo/01-save-the-children.json`
4. Palette customization flows to CSS vars
5. No baked legacy brand colors leaked

**Always `npm test` before pushing.** If it's red, fix first.

### Deploy

- Push to `main` → Vercel auto-deploys to production
- `vercel.json` routes `/(.*) → /server.js` (single serverless function)
- `vercel.json` `includeFiles` list is what gets bundled — **update it if you add new top-level files that server.js requires**
- Deployment Protection is ON → Vercel Authentication is required for preview URLs; production URL (`notso-proposal-gen.vercel.app`) is public

### Rollback

Vercel → Deployments → pick an old "Ready" deploy → ⋯ → **Promote to Production**. One click, no deploy needed.

---

## 6. Palette system (v2)

User-visible colors flow through four layers:

```
Brandfetch (or user input)
        │
        ▼
  client._mainColor         ← SEED. Stays fixed when swapping palettes.
        │
        ▼
  _suggestedPalettes(seed)  ← Computes 15 candidates:
        │                     • 1 FIXED  (notso.ai canon, ignores seed)
        │                     • 11 MOOD  (per-mood S/L profile applied to seed)
        │                     • 3 ALGO   (mono / analog / triad from seed)
        ▼
  User clicks one
        │
        ▼
  _unifiedApplyPalette(p)   ← Writes client.color1..5 and emits a <style>
                              override with --brand-c1..5 + tint/wash/glow.
                              Does NOT touch _mainColor.
```

**Contract:** every slide MUST read colors via `var(--brand-c1)` etc., never via raw hex. The smoke test enforces this by asserting zero baked-color strings leak into output.

---

## 7. Backlog / known debt

- `index.html` is one 360 KB file — no module boundaries yet (backlog: split into `/public/js/*.js`)
- `server.js` is one 97 KB file — API routes should be split into `/api/*.js` modules
- Two parallel export pipelines: `generate_html.js` (PDF) + `generate.py` (PPTX). Backlog #25 is to rewrite PPTX as HTML → PPTX so there's one pipeline, not two
- No request logging / structured error tracking — only `console.error`
- Palette definitions live in `index.html` as JS code; moving them to `data/palettes.json` would let non-engineers edit

See the task list (`#25`, `#63`, `#64`, etc.) for tracked follow-ups.

---

## 8. When something breaks

| Symptom | Likely cause | Where to look |
|---|---|---|
| `PDF generation failed` on Vercel | Chromium extraction broken | `vercel.json` → `AWS_EXECUTION_ENV`, `@sparticuz/chromium-min` version |
| Brandfetch returns 503 "not configured" | Env var missing or wrong scope | Vercel → Env Vars → confirm `BRANDFETCH_API_KEY` set for Production |
| Palette click doesn't recolor slide | Slide has baked hex instead of CSS var | Run `npm test` — check ⑤ catches the leak; else grep for raw hex in the offending slide renderer |
| Mascot doesn't look on-brand | Someone bypassed the style lock | Ensure the call goes through `buildStylePrompt()` from `notso_style_prompt.js` |
| `Cannot read properties of undefined (_selected_slides)` | `buildProposalHtml` called with wrong arg shape | Must pass `{ proposal, client, selected_slides }`, not positional args |
| Smoke test red | Read the ✗ output — each line says which check and why | `npm test` |

---

*Last updated: 2026-04*
