# Vimeo → Notion 自動同步系統 建置紀錄

## 系統架構

```
Vimeo 錄影完成
    └── Webhook → Vercel Function (api/webhook.ts)
            ├── 驗簽（HMAC-SHA256）
            ├── 查詢 Notion Meeting Notes 資料庫
            ├── 配對最近的未連結頁面
            ├── 寫入 Vimeo 錄影連結
            └── Slack DM 通知（失敗 / 歧義 / 衝突）

Claude Code
    └── Vimeo MCP Server (src/index.ts)
            ├── vimeo_list_videos
            ├── vimeo_search_by_date
            ├── vimeo_search_by_title
            └── vimeo_get_video
```

## 元件狀態

| 元件 | 狀態 |
|------|------|
| Vimeo MCP Server | ✅ 供 Claude Code 手動操作 |
| Vercel Webhook | ✅ 自動接收 Vimeo 轉碼完成事件 |
| HMAC-SHA256 驗簽 | ✅ 防止偽造請求 |
| Vimeo token 最小權限 | ✅ 只有 read scope |
| Notion date 欄位正確篩選 | ✅ |
| 配對信心度回報（diff_min / ambiguous） | ✅ |
| 錯誤連結衝突偵測（possible_conflict） | ✅ |
| Slack DM 通知 | ✅ 失敗、歧義、衝突三種情況 |
| GitHub repo | ✅ github.com/drhhtang-pixel/vimeo-mcp |
| Vercel production | ✅ vimeo-mcp.vercel.app，已連結 GitHub |

## 重要設定

### Vercel 環境變數（production）

| 變數 | 說明 |
|------|------|
| `VIMEO_ACCESS_TOKEN` | Vimeo Personal Access Token（public + private scope 只讀） |
| `VIMEO_WEBHOOK_SECRET` | Vimeo Webhook 簽名密鑰 |
| `NOTION_TOKEN` | Notion Integration Token |
| `NOTION_DB_ID` | Meeting Notes 資料庫 ID（從 Notion 資料庫 URL 取得） |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook（發送 DM 通知） |

### Webhook 端點

```
POST https://<your-vercel-domain>/api/webhook
Header: X-Vimeo-Signature: <HMAC-SHA256>
```

### Vimeo Webhook 設定位置

Vimeo Developer Portal → 你的 App → Webhooks

觸發事件：`video-transcode-fully-playable`

## 配對邏輯

1. 從影片標題解析錄製時間（格式：`2026-05-28 01:13:18` UTC）
2. 換算台北時間日期（UTC+8）
3. 查詢 Notion：`Date` 欄位 = 該日期 且 `Vimeo 錄影連結` 為空
4. 計算各頁面 `created_time` 與影片開始時間的差距（分鐘）
5. 差距在 30 分鐘以內 → 配對；否則回傳 `matched: false`

### 通知條件

| 情況 | Slack 通知 |
|------|-----------|
| 找不到對應 Notion 頁面 | ⚠️ 警告，需手動處理 |
| 多個候選頁面（ambiguous） | ⚠️ 警告，可能配錯 |
| 已連結頁面時間更近（possible_conflict） | ⚠️ 警告，可能有錯誤連結 |

## 限制與已知問題

- 配對使用 Notion 頁面的 `created_time`（建立時間）作為會議時間代理值；若頁面是會後建立，時間比對精度會下降
- 錯誤連結不會自動修正，只會發出警告（`possible_conflict`），需手動介入
- Vimeo 標題若不符合 `YYYY-MM-DD HH:MM:SS` 格式，以 `created_time` 作為 fallback

## 部署流程

推送到 GitHub `main` branch → Vercel 自動部署到 production

手動部署：
```bash
vercel --prod
```

## 維運教訓

### 憑證輪換順序

**錯誤做法**：先撤銷舊憑證 → 再設新憑證（中間有空窗期，系統完全失效）

**正確順序**：
1. 產生新憑證
2. 立刻在本機測試新憑證是否有效（`curl` 直接打 API）
3. 將新憑證設進 Vercel，確認部署正常、webhook 回 200
4. 確認無誤後，才撤銷舊憑證

### 設定 Vercel 環境變數

**不要**用 Claude Code 的 `!` prefix 設定含長字串的 env var——指令換行會導致 `--value` 被截斷，造成 `rm` 成功但 `add` 失敗，留下空白變數。

**使用 Terminal.app**，搭配 `printf` pipe：
```bash
printf '你的token或secret' | vercel env add VARIABLE_NAME production --yes
```

### Vimeo Personal Access Token

產生後只顯示一次，無法事後查詢。產生後立刻：
1. 複製完整字串
2. 在本機驗證有效：`curl -s https://api.vimeo.com/me -H "Authorization: Bearer <token>"`
3. 確認回傳帳號資訊後再存入 Vercel
