# Deploy notso-proposal-gen to Vercel (with GitHub integration)

This guide walks through putting the project on <https://vercel.com/> so the
team can open it as a real URL instead of running `node server.js` locally.

## 0 · Prerequisites

- A GitHub account.
- A Vercel account (free tier is fine — sign in with GitHub).
- A Google Cloud OAuth client (see `GOOGLE_SLIDES_SETUP.md`).
- Optionally a Claude API key and a Gemini API key to bake into the site, or
  you can keep letting users paste their own on Step 1.

## 1 · Push the repo to GitHub

From inside the project folder:

```bash
# one-time: initialise & commit
git init
git add .
git commit -m "notso-proposal-gen: initial import (Google Slides export)"

# create an empty repo on GitHub (via the web UI or `gh repo create`)
# then push:
git remote add origin https://github.com/<your-user>/notso-proposal-gen.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `.env`, `node_modules/`, the archived
`.canva-jobs.archive/`, and generated outputs — so nothing secret ships.

## 2 · Import the repo into Vercel

1. Go to <https://vercel.com/new>.
2. Click **Import Git Repository** and pick the GitHub repo you just pushed.
3. On the "Configure Project" screen:
   - **Framework Preset:** Other
   - **Build Command:** leave blank (our `vercel.json` takes over)
   - **Output Directory:** leave blank
   - **Install Command:** `npm install` (default)
4. Under **Environment Variables** add at least:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` — the full production URL, e.g.
     `https://notso-proposal-gen.vercel.app`
5. Click **Deploy**.

Vercel reads `vercel.json` and routes every request through `server.js`,
which already exports a handler for Vercel's `@vercel/node` runtime.

## 3 · Add the production URL back to Google

Once Vercel gives you a URL like `https://notso-proposal-gen.vercel.app`:

1. Open the Google Cloud OAuth client (Credentials → your OAuth 2.0 Client
   ID) and add the Vercel URL under **Authorized redirect URIs**.
2. Update the `GOOGLE_REDIRECT_URI` env var in Vercel to match exactly.
3. Redeploy (Vercel → Deployments → "Redeploy latest").

## 4 · Ongoing workflow

- Every `git push` to `main` triggers an automatic redeploy.
- Pull Requests get preview URLs automatically.
- Secrets stay in Vercel's env-var store, not in git.

---

## ⚠ Known caveats on Vercel

The project was originally a long-running local Node.js server. A few parts
rely on things serverless functions don't have. They still work locally
(`node server.js`) but need attention before they'll behave on Vercel:

| Concern | What breaks | Fix |
|---|---|---|
| `execFile('python3', ['generate.py'])` in `/api/generate` | Vercel's `@vercel/node` runtime doesn't ship Python 3. | Option A — add a Python serverless function: create `api/generate.py` that imports `generate.py` and reads JSON on stdin; Vercel will detect it as a Python runtime. Option B — host the PPTX generator on Render / Railway / Fly.io and have `server.js` proxy to it. |
| `/api/assetpack/*` uses in-memory `global.__assetpackSessions` + `os.tmpdir()` | Each serverless invocation is a fresh container, so the session map evaporates and `/tmp` from the create-call isn't there for the finalise-call. | Store the asset-pack session in Vercel KV or an S3 bucket keyed by the `sessionId`. |
| `fs.writeFileSync('.canva-jobs/…')` | The function filesystem is read-only except for `/tmp`, and `/tmp` does not persist across invocations. | Already removed — we deleted the Canva template-save endpoint in this refactor. |
| Request body `> 4.5 MB` | Vercel's serverless request limit. The Google Slides export sends the `.pptx` bytes as base64; for big decks this can exceed the limit. | Switch the export path to: (1) generate PPTX via a background function or external worker, (2) upload directly from the worker to Google Drive without round-tripping through the browser. |
| OAuth redirect URI | Vercel preview deployments each get their own URL (`project-git-<branch>-<team>.vercel.app`) which is **not** in Google's allow-list by default. | Either only use the stable production URL, or add each preview URL to the Google OAuth client (tedious), or switch to a catch-all custom domain. |

## A pragmatic plan if you want to ship fast

1. Leave the Node routes on Vercel (`/api/mascot/*`, `/api/gslides/*`,
   static files, `/api/slides/mapping`).
2. Move `/api/generate` and `/api/assetpack/*` to a tiny companion service
   on Railway / Render (both have free tiers and support Python +
   long-running workers) and point `server.js` at it with `fetch`.
3. Or — if you'd rather stay 100% on Vercel — port `generate.py` to a
   Python serverless function under `api/generate.py`. python-pptx is pip
   installable so Vercel's Python runtime handles it, but you'll want to
   verify the cold-start time (adding Pillow/python-pptx/reportlab pushes
   the bundle to ~70 MB, still under Vercel's 250 MB limit).

Either way, the Google Slides button itself has no Python dependency — it
only needs the generated PPTX bytes, so that feature works on Vercel as soon
as `/api/generate` can produce a PPTX.
