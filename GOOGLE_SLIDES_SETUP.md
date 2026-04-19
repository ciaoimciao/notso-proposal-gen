# Google Slides export — setup

The "📊 Export to Google Slides" button uploads the generated `.pptx` to your
Google Drive and asks Drive to convert it into an editable Google Slides deck.

To make the button work, you (once) need to:

## 1 · Create an OAuth 2.0 Client ID in Google Cloud

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. Go to **APIs & Services → Library** and enable both:
   - Google Slides API
   - Google Drive API
3. Go to **APIs & Services → OAuth consent screen**, pick "External", fill in
   the required fields (app name, support email). In "Scopes" add
   `.../auth/drive.file` and `.../auth/presentations`. Add yourself as a
   Test user (you can publish later).
4. Go to **APIs & Services → Credentials** → **Create Credentials → OAuth
   client ID** → **Web application**. Name it e.g. "notso proposal gen".
5. Under **Authorized redirect URIs** add:
   - `http://127.0.0.1:8080` — for local dev
   - `https://<your-project>.vercel.app` — once you deploy to Vercel
6. Click **Create**. Copy the **Client ID** and **Client secret** that Google
   shows you.

## 2 · Provide those values to the server

### Local dev

Create a `.env` file next to `server.js` (copy from `.env.example`):

```
GOOGLE_CLIENT_ID=123…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-…
GOOGLE_REDIRECT_URI=http://127.0.0.1:8080
```

Then start the server with `node --env-file=.env server.js` (Node 20+), or
prefix the command like `GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node
server.js`.

### Vercel

In the Vercel dashboard go to your project → **Settings → Environment
Variables** and add the same three variables. Set `GOOGLE_REDIRECT_URI` to
`https://<your-project>.vercel.app`. Redeploy.

## 3 · Use it

1. Finish a proposal (Step 3 — Preview).
2. Click **📊 Export to Google Slides**.
3. First time only: a Google sign-in page opens; grant the two scopes
   (see-and-manage the files this app creates; edit presentations).
4. The server builds a `.pptx`, uploads it to your Drive, and Drive
   auto-converts it. You get back a link like
   `https://docs.google.com/presentation/d/<fileId>/edit`.

Only files this app created are visible to the server (that is what the
`drive.file` scope guarantees) — your other Drive documents remain private.
