# YOLO SiteOps

YOLO SiteOps 是一個 local-first 的 WordPress 營運工作台：先讀取證據、提出單篇內容建議，再由人工逐篇批准、寫回與必要時回滾。它保留任務事件、提案 hash、備份與 writer receipt，讓每次操作可以被檢查。

## 目前狀態

v0.1.3 補齊 WordPress 移除段落標記並增加空白行的精確格式核對，將使用者看見的規則、實際內容指紋、接受紀錄與不可變收據完整綁定。通過239項測試、兩個瀏覽器流程及獨立驗證；一篇已寫入文章在另行接受實際格式後完成無再次寫入的驗收，其餘兩篇仍待審。v0.1.2 的受限分析與每週 Skill 管線保持不變，第一輪排程真實 Skill 仍待未來閘門。已驗證的 Codex CLI 為 `0.163.0`。

驗證範圍與限制見 [`docs/validation.md`](docs/validation.md)。這些結果證明已記錄的 MVP 操作流程；排名、流量、CTR、GEO 與 ROI 仍須後續量測。

自動營運的資料同步、提案、唯讀狀態檢視與受限 Skill 候選／回放操作見 [`docs/pipeline.md`](docs/pipeline.md)。文章寫入仍須逐篇批准，Skill 候選通過回放後也不會自動啟用。

## 需求

- Node.js `22.13+` 或 `24+`
- npm（使用已提交的 `package-lock.json`）
- live 模式另需已登入的 Codex CLI、WordPress application password，以及 GSC/GA4 service account

## 本機快速開始

```bash
npm ci
npm run demo
```

伺服器只綁定 localhost，終端機會顯示一次性 bootstrap URL。demo 使用 synthetic WordPress、GSC 與 GA4 資料；它驗證 UI、API、SQLite、SSE、人工批准與 demo writer 流程，不等於 live E2E，也不代表任何真實網站資料。demo 的 read-only sandbox 是應用層限制，不是作業系統的 secret boundary。

排程預設關閉；若開啟，必須讓本機程序持續常駐。它不會自行部署或發布。

若要驗證真實 Codex CLI，先確認本機 CLI 已登入，再執行使用 local fake snapshot 的 smoke。它不需要 production credentials，也不會提出真實外部資料請求：

```bash
npm run smoke:codex
```

smoke 會在 `work/` 寫入經過 redact 的 evidence JSON。`SITEOPS_CODEX_COMMAND` 可選擇 server 環境中的絕對 CLI 路徑；它不覆寫模型或登入狀態。

WordPress writer 的整合檢查使用 disposable local Docker fixture：

```bash
npm run test:wordpress
```

fixture 使用 synthetic article、臨時資料庫與本機 Docker context，不使用 production credentials，也不會連到 production WordPress。若 fixture 尚未通過全部階段，應保留失敗 evidence，不把它當成 live E2E。

## Live 設定

不要把私有設定、service-account JSON、application password、SQLite data 或 `.env` 放進 repo。請把設定 JSON 放在 repo 外，並以環境變數指定：

```bash
SITEOPS_MODE=live \
SITEOPS_CONFIG_PATH=/private/path/siteops-config.json \
SITEOPS_AGENT=codex \
npm start
```

設定欄位與唯讀 scopes 見 [`config.example.json`](config.example.json) 與 [`docs/configuration.md`](docs/configuration.md)。WordPress 必須是固定 HTTPS origin；GSC 使用 `webmasters.readonly`，GA4 使用 `analytics.readonly`。WordPress 寫回使用 application password。

首次安裝先執行 `npm ci` 與 `npm run build`，再使用上面的 live 啟動指令。連線設定留在伺服器端，瀏覽器只使用本機工作台的登入工作階段。

Codex 使用本機已安裝且已登入的 CLI，採其預設模型；SiteOps 不提供 model override，也不應以設定檔覆寫。live 模式強制 `SITEOPS_AGENT=codex`。

## 安全與營運界線

- 每次 live sync 都先讀取 `context=edit` 的 WordPress 狀態；寫回前檢查 base hash、取得備份、使用 writer lock，並以 authenticated/public read-back 驗證。
- Unknown write outcome、read-back mismatch、drift 或 rollback 不確定時會停在 `review_required`，不可重送猜測。
- 人工逐篇批准；人工決定是否回滾。SiteOps 不自動發布文章。
- 28 日觀察期是之後的量測設計，不能在變更前預先宣稱成果。

完整架構、狀態機、API 與限制見 [`docs/architecture.md`](docs/architecture.md)；貢獻與漏洞回報見 [`CONTRIBUTING.md`](CONTRIBUTING.md) 和 [`SECURITY.md`](SECURITY.md)。

## 驗證

```bash
npm run check
npm run test:e2e
npm run smoke:codex
npm run test:wordpress
```

`npm run test:e2e` 本機預設使用 Chrome，CI 使用 Playwright Chromium，執行環境需已安裝對應瀏覽器。v0.1.3 的兩個本機瀏覽器流程已通過；GitHub CI 會以 Chromium 執行相同測試。上述檢查不會取得 production credentials，也不會部署、發布或變更外部網站。此 repository 不自動部署、不自動發布。
