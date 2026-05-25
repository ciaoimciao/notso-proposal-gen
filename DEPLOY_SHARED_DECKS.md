# 分享連結部署指南 — Vercel + Blob Storage

## 這是什麼

`shareDeck()` 把整份 proposal（client + proposal + mascotPaths + transforms + 編輯後的 HTML）存到伺服器，回傳 `/p/<id>` 短網址。任何人打開該連結就會看到 **同一份 HTML 排版**（不轉檔，不會跑版）；連結加 `/edit` 變編輯模式，每次儲存產生一個新版本（舊版保留為歷史）。

```
POST /api/deck                    →  { id, version, url }
GET  /api/deck/:id                →  { id, version, ts, data }   # 取最新版
GET  /api/deck/:id/versions       →  { id, versions:[{version,ts}] }
PUT  /api/deck/:id                →  { id, version }              # 寫新版本
GET  /p/:id                       →  index.html（檢視模式）
GET  /p/:id/edit                  →  index.html（編輯模式）
```

儲存後端在 `deck-store.js` 自動切換：

| 環境 | 條件 | 後端 |
|---|---|---|
| 本機 / 自建主機 | 預設 | 檔案系統，寫到 `./.deck-store/<id>/v<N>.json` |
| Vercel | `process.env.VERCEL` 存在 | `@vercel/blob`，需要 `BLOB_READ_WRITE_TOKEN` |

---

## 部署到 Vercel 的步驟

### 1. 確認 `@vercel/blob` 已在 dependencies

```bash
grep '@vercel/blob' package.json
# 應該看到 "@vercel/blob": "^2.x"
```

> 已安裝。`vercel.json` 的 `@vercel/node` builder 會自動帶進 node_modules，不用手動加進 includeFiles。

### 2. 在 Vercel Dashboard 開一個 Blob Store

1. 進專案 → **Storage** → **Create Database**
2. 選 **Blob**，取個名字（例如 `notso-decks`）
3. 連結到當前專案（**Connect Project**）
4. Vercel 會自動把 `BLOB_READ_WRITE_TOKEN` 環境變數寫進專案（Production / Preview / Development 三個環境都會有）

### 3. 確認環境變數

```bash
vercel env ls
# 應該看到：
# BLOB_READ_WRITE_TOKEN  Production, Preview, Development
```

如果只想在 Preview / Production 啟用，可以在 Dashboard 個別取消勾選。

### 4. 部署

```bash
vercel --prod
```

部署完打開分享流程驗證：

1. 在線上生成一份 proposal
2. 按「🔗 分享連結」→ 拿到 `https://你的網域/p/<id>`
3. 用無痕分頁打開該連結 → 應該看到一模一樣的 HTML 排版
4. 開啟 `/p/<id>/edit` → 改一些字 → 按「儲存」 → button 顯示 `✓ 已存 v2`
5. 再次打開 `/p/<id>` → 看到 v2 的內容

---

## 本機測試（已通過）

```bash
node server.js                         # 啟動本機 server (port 8080)

# 建立一份 deck
curl -X POST http://127.0.0.1:8080/api/deck \
  -H "Content-Type: application/json" \
  -d '{"proposal":{"client_name":"Test"}, "client":{"name":"Test"}, "mascotPaths":{}}'
# → { "id": "abc123...", "version": 1, "url": "http://127.0.0.1:8080/p/abc123..." }

# 列版本
curl http://127.0.0.1:8080/api/deck/abc123.../versions
# → { "id":"abc123...", "versions":[{"version":1,"ts":...}] }

# 寫新版
curl -X PUT http://127.0.0.1:8080/api/deck/abc123... \
  -H "Content-Type: application/json" \
  -d '{"proposal":{...修改後內容}, ...}'
# → { "id":"abc123...", "version": 2 }

# 取最新
curl http://127.0.0.1:8080/api/deck/abc123...
# → version: 2, data: {...}
```

或在瀏覽器打 `http://127.0.0.1:8080`、Step 3 按「🔗 分享連結」走完整 UI。

本機資料寫到 `.deck-store/<id>/`，**已在 `.gitignore`**，不會被 commit。

---

## 「為什麼不轉成 PPTX / Google Slides」

PPTX / Slides 轉檔意味著每次都得把 HTML 重新映射到另一套格式：字型、定位、漸層、SVG、自訂字距全部會跑版。HTML-only 的分享連結把 **同一份排版** 直接送到觀眾的瀏覽器，所見即所得；要再編就再開連結，伺服器存版本就是歷史紀錄。

---

## Blob 後端的特性

- **不是 KV / DB**：每筆 deck 是一個 JSON Blob 物件，路徑 `decks/<id>/v<N>.json` + `decks/<id>/latest.json`。
- **public access**：建立時用 `access: 'public'`，URL 是 unguessable hash + 短 ID。要鎖權限要改成 `private` + signed URL，本檔暫不處理。
- **`allowOverwrite: true` 用在 `latest.json`**：每次寫新版會覆蓋這顆 Blob，舊版 `v<N>.json` 永遠保留。
- **不會自動清理**：歷史版本永久留存。要設保留期可在 Vercel Blob Dashboard 設 lifecycle，或寫一個 cron job 跑 `list({prefix})` + `del()`。
