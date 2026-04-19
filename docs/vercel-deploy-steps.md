# 部署到 Vercel：一次就到位的 SOP

這份文件針對「今天上線」寫的，目標是把 `notso-proposal-gen` 部署到 Vercel，
內部業務 3-10 人可用，網址最後會是 **https://proposal.notso.ai**。

讀的人不需要工程背景，跟著步驟做就好。每一步只會問你「貼什麼」或「點哪裡」。

---

## 事前準備（約 5 分鐘）

你需要三個帳號。全部都是免費方案就夠：

1. **GitHub 帳號** — 放程式碼。你應該已經有。
2. **Vercel 帳號** — 部署平台。用 GitHub 登入就行（https://vercel.com/signup）。
3. **DNS 後台** — 就是 `notso.ai` 這個網域買在哪個供應商（Gandi、Cloudflare、Namecheap…）。你需要登得進去、能改 CNAME 紀錄。

如果三個都齊，就可以開始。

---

## Step 1. 把程式碼 push 到 GitHub

在終端機打（或者用 GitHub Desktop 之類的 GUI）：

```bash
cd /path/to/notso-proposal-gen
git add .
git status           # 確認沒有多餘的檔案（.env、.secrets.json 應該看不到）
git commit -m "prep for Vercel deploy"
git push
```

> ⚠️  **雙重確認**：執行 `git status` 的時候，`.env`、`.secrets.json`、
> `fixtures/*.json`（除了 `fixtures/demo/*.json` 和 `fixtures/fixture.example.json`）
> 都不應該出現在待 commit 的清單。如果有出現，**先停下來告訴 Claude**，那代表
> `.gitignore` 沒吃到。

---

## Step 2. 在 Vercel 匯入 repo

1. 登入 https://vercel.com/
2. 點右上角 **Add New → Project**
3. 找到 `notso-proposal-gen` repo，點 **Import**
4. 出現 Configure Project 畫面時：
   - **Framework Preset**：Other（Vercel 應該會自動偵測）
   - **Root Directory**：保持預設（repo 根目錄）
   - **Build Command / Output Directory / Install Command**：**全部不要動**。
     我們的 `vercel.json` 已經寫好了，手動填會蓋掉。
5. **先不要按 Deploy**。往下捲到 **Environment Variables** 區塊。

---

## Step 3. 設定環境變數（Environment Variables）

在同一個畫面貼入下面這些（`Add` 按鈕一個一個加）：

| Name                   | Value                                | Environment |
|------------------------|--------------------------------------|-------------|
| `GOOGLE_CLIENT_ID`     | 你 Google Cloud 的 OAuth Client ID   | Production, Preview, Development |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret           | Production, Preview, Development |
| `GOOGLE_REDIRECT_URI`  | `https://proposal.notso.ai`          | Production, Preview, Development |

> 💡 這三個變數是給 Google Slides 匯出用的。如果暫時不需要 Slides 匯出（只
> 用 PDF），可以**跳過這一步**，系統會直接關掉 Slides 按鈕。但之後要補也
> 可以，隨時回來 Project Settings → Environment Variables 補就行。

**注意事項：**
- `CLAUDE_API_KEY` 和 `GEMINI_API_KEY`**不要**設在 Vercel 上。每個內部使用
  者會在前端自己貼 key，這樣我們不會被集體刷 API 費用。
- 三個 scope（Production / Preview / Development）都勾，免得後續 preview
  部署壞掉。

---

## Step 4. 按 Deploy

- 按藍色 **Deploy** 按鈕。
- Vercel 會跑 build（大概 1-2 分鐘，因為要下載 Chromium）。
- 看到 Congratulations 之後，Vercel 會給你一個預設網址，長得像：
  `https://notso-proposal-gen-xxxx-vercel.app`。
- 點進去。**Step 1 的表單應該能看見，也可以按「🧪 Test preset」按鈕載入
  Save the Children / WWF / Squla / Yazio / Bellewaerde 五個範例。**
- 如果有問題，**不要慌**：回 Vercel → Project → Deployments → 點最新那個 →
  看 Logs。常見錯誤在最下面的 `疑難排解` 章節。

---

## Step 5. 換成自己的網址（proposal.notso.ai）

做完上面有預設網址了，但要給內部業務用還是要換成 `proposal.notso.ai`。
這裡會分兩邊做：Vercel 告訴它「我要這個網址」，DNS 後台告訴網域「這個
subdomain 指到 Vercel」。

### 5a. Vercel 這邊

1. 進入 Project → **Settings → Domains**
2. 在輸入框打 `proposal.notso.ai`，按 **Add**
3. Vercel 會跳出一段說明，告訴你 DNS 該怎麼設。通常會要求：
   ```
   Type: CNAME
   Name: proposal
   Value: cname.vercel-dns.com
   ```
   （如果它跟你要的是另一組，以畫面顯示的為準。）

### 5b. DNS 後台那邊

進 `notso.ai` 網域的 DNS 管理頁面，新增一筆紀錄：

| Type  | Host (Name) | Value                   | TTL  |
|-------|-------------|-------------------------|------|
| CNAME | proposal    | cname.vercel-dns.com.   | 自動或 300 |

儲存。**DNS 生效通常 1 分鐘 ~ 數小時**（第一次大多 5 分鐘內就好）。

> ⚠️  如果 `notso.ai` 是用 Cloudflare，CNAME 那欄的雲朵 icon（Proxied）
> 要關掉，改成灰色（DNS only）。不然 Vercel 發 HTTPS 憑證會失敗。

### 5c. 驗證

回到 Vercel Settings → Domains，看 `proposal.notso.ai` 那筆。

- 綠色勾勾 = 成功，`https://proposal.notso.ai` 可以開了。
- 橘色 / 紅色 = 還在等 DNS 傳播，或者 CNAME 設錯。等 5 分鐘再重整；還
  沒好就去 https://dnschecker.org/ 貼 `proposal.notso.ai` 看全球 DNS 是不
  是都更新了。

完成之後，**把網址傳給內部業務**就可以用了。

---

## 內部業務第一次開啟要做什麼

他們會需要一把 Claude API key。給他們一個簡短指南：

1. 去 https://console.anthropic.com/settings/keys
2. Create Key → 複製
3. 打開 `https://proposal.notso.ai`
4. 用 preset 填表（或自己輸入）
5. 往下捲到 **API Configuration**，貼上 Claude key
6. 按 Generate。金鑰會存在瀏覽器 localStorage，下次開就不用再貼。

Gemini key（吉祥物生成用）是選填。沒填就會在 Step 2.5 有提醒，可以按 Skip
跳過，只出 PDF 不含吉祥物。

---

## 今天先不能用、之後再加的功能

部署當下，這些功能**在 Vercel 上會看不到或按了會跳錯**，是故意的：

- **📊 Export PPTX**：按鈕會自動隱藏。PPTX 靠 `python-pptx`（Python），Vercel
  的 Node 函式環境沒辦法跑。要出 PPTX 就在本機跑 `node server.js` 再按。
- **📊 Export to Google Slides**：按鈕會自動隱藏。之後設好 OAuth（Step 3
  的三個環境變數）再打開。
- **🎁 Mascot Asset Pack**：按鈕會自動隱藏。這是本機用 Canva / Gemini 大
  批生成吉祥物包的功能，通常只有設計師在內部用，業務用不到。

PDF 匯出（內部業務最常用的）**在 Vercel 上就能用**，不用擔心。

---

## 疑難排解

### 部署失敗：npm install error

多半是 `package-lock.json` 有問題或版本衝突。在本機先執行：

```bash
rm -rf node_modules package-lock.json
npm install
git add package-lock.json
git commit -m "regenerate lockfile"
git push
```

### 部署成功，但打開網址 500 Internal Server Error

進 Vercel → Project → Deployments → 點最新那個 → **Runtime Logs**。
常見原因：
- Chromium 啟動失敗 → 通常是 memory 不夠。`vercel.json` 已經設了 1024MB；
  如果還是跑不起來，改成 2048。
- 找不到 fixture → 檢查 `vercel.json` 的 `includeFiles: "fixtures/**"` 有沒
  有在。

### 按 Generate 按鈕跳「API Error: 401」

Claude key 不對，或是過期。到 console.anthropic.com 產一把新的再貼。

### PDF 下載按下去沒反應

打開瀏覽器 DevTools → Network。看 `/api/generate` 的 response：
- 500 → 後端錯誤，去看 Vercel Logs。
- 504 Gateway Timeout → PDF 生成超過 60 秒。多半是 slide 太多或客戶名稱
  含特殊字元導致 Puppeteer 卡住。先把 slide 刪掉幾張再試。

### Custom domain 一直是 orange dot，不綠

大概率是 Cloudflare 的 Proxy 沒關（要改成 DNS only）。或者 CNAME target
打錯字。Cloudflare 解法見 5b 的 ⚠️ 警告。

---

## 之後要改什麼、怎麼改

程式碼都在 GitHub 上。改完 push，Vercel 會**自動**重新部署（不用再手動
按 Deploy）。每次 push 到 `main` branch 就生一版 production，push 到其他
branch 會生一版 preview。

如果想在合併前先看看效果：

```bash
git checkout -b fix/pdf-font
# 改 code
git push -u origin fix/pdf-font
```

Vercel 會給你一個 preview URL，像 `notso-proposal-gen-git-fix-pdf-font-xxx.vercel.app`，
可以先內部看過再合併。
