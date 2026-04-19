# Phase 1 設計：`?preset=` 預設客戶 + 測試 fixtures

這份文件用白話解釋 Phase 1 要做什麼、為什麼、以及做完之後你的日常會怎麼變。
沒有程式碼細節，看完就能判斷我提的做法合不合你的直覺。

---

## 你現在的痛點

每次你要測試系統，都要重頭手動做這些事：

1. 打開 `http://127.0.0.1:8080`
2. 填「客戶名稱」、「產業」、「主要用途」、「描述」（描述要寫一大段）
3. 調 4 格品牌色
4. 可能還要再上傳參考圖、網站截圖
5. 貼 Claude API key（這個最煩，每次都要翻記事本）
6. 按 Generate，等 Claude 回來
7. 看結果、匯出、對照、發現問題
8. 改 code，**回到第 1 步，整套再填一次**

改 5 次 code 就是重填 5 次表單。而且每次填的內容如果不一樣，就沒辦法比較「這次的問題是我改壞了，還是 Claude 這次心情不好」。

---

## 要做的事一共三塊

```
Phase 1 = 預設客戶（preset）+ 後端冒煙測試 + Agent 報告
           ────────────┬───────      ──────────┬────────     ──────┬─────
                      你手動測試時用      每次改完 code 跑        你派 agent 幫你跑
```

每一塊都獨立有價值，逐步加上去就好。

---

## 第一塊：`?preset=` — 一鍵填好整份表單

### 概念

在網址後面加一個參數，例如：

```
http://127.0.0.1:8080/?preset=jumbo
```

網頁一打開，**整份表單就自動填好**——客戶名、產業、描述、4 格顏色、API key，全部都是預先設定好的。你直接按 Generate 就能跑。

不想用 preset 就正常打開 `http://127.0.0.1:8080/`，跟現在一模一樣。

### 幕後怎麼運作（一句話）

專案裡會多出一個叫 `fixtures/` 的資料夾。裡面每個檔案就是「一個預設客戶」：

```
notso-proposal-gen/
├── fixtures/
│   ├── jumbo.json          ← 荷蘭大型超市 · HR onboarding
│   ├── finsport.json       ← 金融體育俱樂部 · 客服
│   ├── acme.json           ← 通用測試假資料
│   ├── lawson-jp.json      ← 日文測試
│   └── README.md           ← 寫明每個 fixture 存在的理由
```

每個 `.json` 檔長這樣（一個範例）：

```json
{
  "name": "Jumbo",
  "industry": "Retail · Supermarket",
  "useCase": "hr_onboarding",
  "description": "Jumbo 是荷蘭最大的連鎖超市之一，擁有 700+ 門市...",
  "colors": ["#FFD700", "#E30E27", "#000000", "#FFFFFF"],
  "mascotName": "Liza",
  "lang": "en"
}
```

網頁一開啟時會做這樣一件事：看網址有沒有 `?preset=xxx`，有的話就去抓對應的 json，把裡面的值寫進表單欄位。就這樣，沒有魔法。

### API key 怎麼辦？

Key 是敏感資訊，**絕對不能寫進 `fixtures/` 的 json 裡**（因為你會把 fixtures 送上 GitHub）。

解法：在你本機家目錄放一個 `.secrets.json`（不在 repo 裡，永不 commit），內容只有：

```json
{
  "claudeKey": "sk-ant-...",
  "geminiKey": "AIza..."
}
```

網頁載入時，伺服器從這個檔案讀 key 送到前端。你從頭到尾不用再貼 key。

> 如果你不喜歡這種做法，第二個選擇是讓網頁「第一次貼的 key 自動存進瀏覽器
> 的 localStorage」，以後就記住——這個方案無痛但 key 會存在你的瀏覽器，
> 共用電腦時要注意。你自己選。

### 做完之後你的日常

```
改 code → 瀏覽器按 Cmd+R → 按 Generate  ← 一次這麼簡單
```

不用再打字、不用再貼 key。

---

## 第二塊：後端冒煙測試 — 不用開瀏覽器也能測

### 概念

有時候你改的是**後端**（例如 Claude 的 prompt、PPTX 渲染邏輯、顏色計算）。
開瀏覽器點半天才發現「喔這頁炸了」太慢。所以再加一個**後端直打**的腳本：

```bash
node tests/smoke.js
```

這個腳本會做的事：

1. 讀 `fixtures/` 裡每一個 json
2. 直接 `POST /api/generate`（不透過瀏覽器）
3. 拿到 PDF、PPTX 檔案
4. 用程式檢查基本健康狀況：
   - 檔案能不能正常打開？
   - PDF 是不是 18 頁（或你勾選的頁數）？
   - 檔案大小有沒有在合理範圍？
   - PDF 文字裡有沒有出現 `undefined`、`null`、`[object Object]` 這種炸掉的痕跡？
   - PPTX 的顏色主題有沒有正確套進去？
5. 印出報告，像這樣：

```
✔ jumbo      PDF 18pages  2.3MB   OK
✔ jumbo      PPTX 18slides 1.8MB   OK
✘ finsport   PDF 17pages  2.1MB   FAIL: missing s10 (Chatflow)
✔ finsport   PPTX 18slides 1.9MB   OK
✔ acme       PDF 18pages  2.4MB   OK
...

Summary: 7 passed, 1 failed (30 seconds)
```

### 為什麼這個很重要

- **30 秒跑完整套**，比你手動點 4 個 client × 2 個格式快 20 倍
- 你可以把它當成「改完 code 的自動檢查」：跑一下，全綠了才繼續改下一個
- 以後上 CI（GitHub Actions）時，這個腳本就是核心測試

### 不能測什麼

這個腳本**不看視覺**——它只檢查「檔案結構沒壞、該有的頁數都在、沒出現錯誤字串」。
真正的版面走樣、顏色怪、圖片沒對齊，它看不出來。那是第三塊的工作。

---

## 第三塊：Agent 幫你跑視覺測試 + 匯總報告

### 概念

你想看視覺有沒有跑掉，以前只能自己開瀏覽器點。現在可以叫我（或我派出的 agent）幫你做。

流程：

```
你說：「幫我跑一輪 regression」
   ↓
我同時開 3 個 agent，每個 agent 拿一個 fixture：
   Agent A: preset=jumbo    → 端到端跑完，截圖每一步
   Agent B: preset=finsport → 端到端跑完，截圖每一步
   Agent C: preset=acme     → 端到端跑完，截圖每一步
   ↓
每個 agent 輸出一份小報告（含截圖）
   ↓
我把三份整合成一份總報告給你
```

### Agent 實際會做的事

以 Agent A 為例：

1. 開 Chrome，打開 `http://127.0.0.1:8080/?preset=jumbo`
2. 截圖「Step 1 — 表單填好的樣子」
3. 點 Generate，等 Claude 回應
4. 截圖「Step 2 — Loading 畫面」
5. 如果走到 mascot step，截圖 + 按 Skip
6. 截圖「Step 3 — 所有 18 張投影片的預覽」
7. 點 Export PDF，下載
8. 打開 PDF，截圖每一頁
9. 把「瀏覽器預覽 vs PDF 實際輸出」並排對照
10. 回報：哪幾頁的預覽跟 PDF 不一樣、哪幾頁文字跑版、哪幾頁顏色怪

### 報告長怎樣

我會給你一份這樣的 markdown，你掃 30 秒就知道哪裡要修：

```
# Regression Report — 2026-04-19 22:30

## Summary
- 3 clients tested: Jumbo, FinSport, Acme
- 54 slides rendered (3 × 18)
- 6 issues found, see details below

## Jumbo
✔ Step 1 form populated correctly
✔ Generation succeeded in 45s
⚠ s10 (Chatflow) — dark theme background leaks into footer
✘ s15 (Pricing) — middle tier card overflows right edge by ~40px

[Screenshots: step1.png, step3-preview.png, s10-pdf.png, s15-pdf.png]

## FinSport
... etc
```

### 你要做的準備

給我一個能用的 Claude API key（走 `.secrets.json` 那套的話，我直接讀到）。
其他都我處理。

---

## 實作順序建議

我建議照這個順序做，每一步做完都能獨立帶來好處：

| 順序 | 要做什麼 | 完成後的好處 | 大概工時 |
|---|---|---|---|
| ① | `?preset=` + 3 個基本 fixtures | 你手動測試不用再填表 | ~1 小時 |
| ② | `.secrets.json` 自動注入 key | 也不用再貼 key | ~30 分鐘 |
| ③ | `tests/smoke.js` 後端健康檢查 | 改完 code 可一鍵驗證 | ~1-2 小時 |
| ④ | Agent 視覺測試流程定下來 | 要 regression 時叫我跑 | 設計好就 0 成本 |

全部加起來估一個下午能做完。

---

## 你要先確認的幾件事

1. **fixtures 內容**：你希望預設哪幾個客戶？我腦中是 Jumbo（既有案例）、
   FinSport（既有案例）、一個通用假客戶（Acme）、或許加一個日文測試
   （LAWSON）。你有其他優先想測的組合嗎？
2. **API key 管理**：想用 `.secrets.json` 還是瀏覽器 localStorage 自動記住？
3. **是否納入 Puppeteer 本機測試**：smoke 腳本可以不只呼叫 API，也可以順便
   用 Puppeteer 開 headless 瀏覽器截圖——這樣就連視覺差異都能偵測。但工時
   會從 1-2 小時膨脹到半天。要做嗎？
4. **fixtures 放在 repo 還是 gitignore**：如果 fixtures 裡有客戶真名、真實
   描述，我會建議第一批先用公開資訊寫 Jumbo / FinSport（case study 本來就公開），
   其餘用假名 Acme。這樣 fixtures 可以 commit 進去沒壓力。

你回答這幾個問題，我就可以進到實作了。
