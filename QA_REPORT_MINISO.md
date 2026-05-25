# QA Report — Miniso 端到端測試（第一次提報，8 張）

**測試日期**：2026-05-25
**測試環境**：本機（macOS，node server.js on 127.0.0.1:8080）
**測試者**：Claude（以 QA 身份操作）
**測試輸出**：`~/Downloads/notso-miniso-first-pitch.pdf` (4.77 MB, 8 slides)

## 測試流程實際耗時

| 步驟 | 時間 | 備註 |
|---|---|---|
| Step 1 表單填寫 | < 5s | 填入名創優品資料、品牌色 #E60012 |
| 點 Generate Proposal → Claude 完成 | **~140s** | 比預期的 30-60s 慢 2-4 倍 |
| 9 個 mascot 生成（Gemini） | **~80s** | 平行 batch，OK |
| 指派 A/B/C + Confirm | < 10s | |
| 切到 第一次提報 preset | < 1s | 8 張按序顯示 ✓ |
| PDF 生成（Puppeteer） | **~5s** | server-side render，超快 |
| **總計** | **~4 分鐘** | |

---

## 🔴 Critical Issues（會擋住流程）

### #C1 — Puppeteer Chrome 沒預先安裝，第一次 PDF 匯出必爆
**現象**：本機剛 `npm install` 完跑 server 後，第一次按 Download PDF 會回：
```
HTTP 500: Could not find Chrome (ver. 131.0.6778.204).
This can occur if you did not perform an installation before running
the script (e.g. `npx puppeteer browsers install chrome`)
```
**修法建議**：
- 在 `package.json` 加 `"postinstall": "npx puppeteer browsers install chrome"`
- 或在 `server.js` 啟動時偵測缺失並自動安裝
- 或在 README 明寫「首次安裝後請跑 `npx puppeteer browsers install chrome`」

### #C2 — Claude 生成等待時間沒有 progress
**現象**：按 Generate Proposal 後，按鈕變 `⏳ Generating...` 並停 90-140 秒，這段時間使用者完全不知道：
- 還剩多久
- 是否還活著（連線斷？API 爆？）
- 系統在做什麼（呼叫 Claude？解析？rendering？）

**修法建議**：跟我剛做的 PDF progress overlay 同個風格，加 Claude 階段提示
- "正在發送資料給 Claude…"
- "Claude 正在思考（~60 秒）…"
- "解析回應…"
- "渲染預覽…"

### #C3 — Gemini 免費額度太脆弱
**現象**：先前一輪測試後 Gemini 直接 429 鎖死，要等到隔天才能繼續。
**修法建議**：
- Gemini 429 時自動 fallback 到 OpenAI（如有 key）
- 或加「Gemini 配額不足，請上傳已有 mascot」的明確逃生通道
- 或建議用戶升級到付費 tier（顯示 https://aistudio.google.com/billing）

---

## 🟡 UX Issues（能跑但卡卡）

### #U1 — Step 1 欄位太多，不知道哪些必填
**現象**：13+ 個輸入欄位（client name、industry、website、use case、desc、output lang、Claude key、Gemini key、mascot name、4 個 color、pitch brief、design style…）
**修法建議**：
- 標星號區分必填 vs 選填
- 把選填的欄位收進 `<details>` 摺疊
- 或把欄位分成「最少需要這 5 個」「進階」兩段

### #U2 — Mascot 生成完沒有「上一步」可以重生
**現象**：9 個 mascot 出來不滿意，只能按 "🔄 Regenerate" 整批重生（再花 80 秒），不能「保留 3 個喜歡的、只重生 6 個」
**修法建議**：每個 mascot 卡片加「⟳」按鈕重生「這一個」

### #U3 — Confirm Mascots 後不會自動跳到 Step 3
**現象**：按了 Confirm 之後，使用者要自己點頂部 step bar 的「3 Preview & Export」才會看到 Step 3 內容
**修法建議**：confirmMascots() 成功後自動 `setStep(3)`

### #U4 — 痛點/Core Features 等 AI 內容沒有 "regenerate this slide" 按鈕
**現象**：Claude 寫的 s3 痛點不夠精準，但只能整份重生（重跑 140 秒）；或用 ✨ AI edit 一個個編
**修法建議**：每個 slide-card 加「🔁 重生這張」單張重生

### #U5 — Mascot 之間沒有 consistency
**現象**：9 個 mascot 都是不同人（不同臉、不同髮型、不同衣服），不是「同一個角色的 9 種變體」
**修法建議**：在 prompt 強化「all 9 must be the SAME character with different poses」，目前的 STYLE_PREFIX 沒講這個

---

## 🟢 Polish Issues（建議改但不急）

### #P1 — Step bar 點擊不能跳轉
**現象**：頂部「1 Client Info / 2 Generating / 3 Preview & Export」是純顯示，點不會跳
**建議**：允許向前跳（已完成步驟）

### #P2 — PDF 命名不夠精準
**現況**：`notso-proposal-名創優品MINISO.pdf` — 中文+空格被處理掉，但沒帶日期、沒分 first/second pitch
**建議**：`notso-{client}-{preset}-{YYYY-MM-DD}.pdf` 例如 `notso-miniso-first-pitch-2026-05-25.pdf`

### #P3 — Backup Mascots 邊欄資訊密度太高
**現象**：右側 sidebar 9 個 mascot 縮圖排成 3×3，每個都有 "Place on slide" 按鈕，scroll 區域很短，找特定的很費勁
**建議**：加上「搜尋這個 mascot 的 expression」過濾

### #P4 — Slide picker 不顯示 mascot
**現象**：Step 3 上方 15 張小卡片（slide preview）裡面的 mascot 槽都是灰色 placeholder
**建議**：把已指派的 mascot 縮圖也畫進去

### #P5 — 沒有「儲存草稿」按鈕
**現況**：localStorage 自動 snapshot，但用戶無法主動下載草稿給其他人接手
**建議**：在 Step 3 加「下載 JSON 草稿」+「載入 JSON 草稿」

---

## 內容品質檢討（Pain Points 為例）

**Claude 為 Miniso 寫的痛點**（從這次測試）：
- 5000+ SKU 選擇困難
- 線上電商缺陪伴感
- IP 聯名上市諮詢爆增

**問題**：
1. 三個痛點獨立，沒有 1 → 2 → 3 因果鋪陳
2. 沒寫客戶「現在怎麼應對」+「為什麼不夠」
3. 痛點數量固定為 3（不論輸入什麼）

**建議**：把 prompt 改成（請看上一輪我給的 Miniso 改良範例）：
- 動態 2-5 個痛點
- 每個帶「現有應對 + 為什麼不夠」
- 痛點間有邏輯接續

---

## 已完成的 3 個 fix

| # | 問題 | 修法 | 檔案 |
|---|---|---|---|
| #8 | PDF 下載沒有 progress | 加 `_showExportProgress / _updateExportProgress / _hideExportProgress`，串到 PDF + PPTX 出口 | `index.html` |
| #9 | Refresh 按鈕誤觸吃掉編輯 | confirm() 加 i18n + 明確列出會失去什麼（文字編輯）vs 保留什麼（mascot 位置） | `index.html` |
| #10 | Preset 按鈕沒有縮圖預覽 | 兩顆按鈕加 `title=` tooltip，列出每個 preset 包含哪些 slide | `index.html` |

---

## 下一輪建議優先順序

1. **🔴 #C1 Puppeteer 預裝** — 一行 postinstall 解決，影響每個新開發者
2. **🔴 #C2 Claude generation progress** — 用戶最容易誤以為當機
3. **🟡 #U2 單張 mascot 重生** — 影響使用體驗最直接
4. **🟡 #U5 9 個 mascot 一致性** — 影響輸出品質
5. **🟡 Pain points 內容結構**（你上輪問的）— 用 Miniso 改良範例的 prompt

---

## 測試輸出附件

- ✅ PDF: `~/Downloads/notso-miniso-first-pitch.pdf` (4.77 MB)
- ✅ 也存在 `notso-proposal-gen/assets/_qa_out/miniso-first-pitch.pdf`（可透過 http://127.0.0.1:8080/assets/_qa_out/miniso-first-pitch.pdf 取得）

8 張內容（Claude 生成）：
1. Cover — "嗨！我是 YoYo，今天想逛什麼？"
2. Mascot Design — YoYo 角色設定
3. Core Features — 24/7 選品 / IP 推薦 / 新品 Q&A
4. Mascot Selection — 3 個性別/個性變體
5. Personality & Empathy — 同理心情境
6. Chat Mock-up — 完整對話範例
7. Promo Materials — 門市海報 / 社群素材
8. Thank You — 結尾 CTA + hello@notso.ai
