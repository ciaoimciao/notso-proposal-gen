# Fixtures — test presets for the proposal generator

This folder contains ready-to-load example clients. When the app is opened with
`?preset=save-the-children` (or any preset id), the form on Step 1 is filled in
automatically. The goal: stop retyping the same thing over and over while
testing, and make it easy to reproduce the same generated proposal.

## How to use

1. Start the app locally (`node server.js`) or open the deployed URL.
2. Append `?preset=<id>` to the URL. Examples:
   - `http://localhost:3000/?preset=save-the-children`
   - `http://localhost:3000/?preset=wwf`
   - `http://localhost:3000/?preset=squla`
   - `http://localhost:3000/?preset=yazio`
   - `http://localhost:3000/?preset=bellewaerde`
3. The form on Step 1 fills in; click **Generate Proposal** to continue.

You can still edit any field after loading — presets are just a starting point.

## Folder layout

```
fixtures/
├── README.md                    ← this file (committed)
├── fixture.example.json         ← schema template (committed)
├── demo/                        ← public-info demo presets (committed)
│   ├── 01-save-the-children.json
│   ├── 02-wwf.json
│   ├── 03-squla.json
│   ├── 04-yazio.json
│   └── 05-bellewaerde.json
└── *.json                       ← your private / real-client fixtures
                                    (automatically gitignored — see below)
```

### Demo fixtures (committed)

- `demo/01-save-the-children.json` — NGO, Digital Fundraiser
- `demo/02-wwf.json` — Conservation NGO, Digital Fundraiser (Panda)
- `demo/03-squla.json` — K-12 EdTech, Ultimate Study Buddy (Q the blue alien)
- `demo/04-yazio.json` — Nutrition app, Personal Nutrition Coach (blue monster)
- `demo/05-bellewaerde.json` — Theme park, Digital Park Guide (Lion)

Each fixture is a plain JSON file whose keys match the `id=` of the form
inputs on Step 1, so the preset loader is literally a for-loop.

## Adding your own preset

1. Copy `fixture.example.json` to a new file at the **top level** of this
   folder, e.g. `fixtures/06-acme-corp.json`.
2. Fill in the fields (see schema below).
3. Set `_meta.preset_id` to the slug you want to type after `?preset=`.
4. Reload the page — it will show up in the list.

Anything you put directly under `fixtures/` (not under `fixtures/demo/`) is
automatically gitignored, so real client briefs stay local.

## Schema

| Key           | Required | Notes                                                                    |
|---------------|----------|--------------------------------------------------------------------------|
| `_meta.title` | no       | Label shown in UI (falls back to `clientName`).                          |
| `_meta.preset_id` | yes  | URL slug for `?preset=`. Must be unique across fixtures.                 |
| `_meta.note`  | no       | Freeform note for teammates. Ignored by the app.                         |
| `clientName`  | yes      | Company / organisation name.                                             |
| `industry`    | yes      | One short phrase, e.g. "Retail / FMCG".                                  |
| `useCase`     | yes      | One of: `customer_support`, `hr_onboarding`, `sales_conversion`, `product_experience`, `events_kiosk`, `compliance`. |
| `clientDesc`  | yes      | 1-3 sentences describing the business + what we want the mascot to do.   |
| `color1hex`   | yes      | Primary brand colour (`#RRGGBB`).                                        |
| `color2hex`   | no       | Accent 1.                                                                |
| `color3hex`   | no       | Accent 2.                                                                |
| `color4hex`   | no       | Accent 3.                                                                |
| `mascotName`  | no       | Suggested name, e.g. "Q", "Hope", "Koning Leeuw".                        |
| `outputLang`  | yes      | One of: `en`, `zh-TW`, `ja`, `nl`, `ko`, `de`, `fr`, `es`.               |

Any key the app doesn't know about is ignored — safe to add your own notes.

## ⚠️ Customer-data policy

- **Real client fixtures should NEVER be committed.** `.gitignore` protects
  any `*.json` placed directly under `fixtures/` — only `fixtures/demo/*.json`,
  `fixtures/fixture.example.json`, and this README are tracked.
- The five fixtures under `demo/` are **based on publicly available info
  about well-known brands** (NGOs, apps, a theme park). They're for
  demo/testing purposes only and do not represent active client engagements.
- If you want to test with a real client's colours / brief, save it as a new
  JSON file at the top level of this folder (e.g. `fixtures/acme.json`) —
  it won't be pushed to GitHub.
