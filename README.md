# YOLO SiteOps

YOLO SiteOps 是一個 local-first 的 WordPress 營運工作台：先讀取證據、提出單篇內容建議，再由人工逐篇批准、寫回與必要時回滾。它保留任務事件、提案 hash、備份與 writer receipt，讓每次操作可以被檢查。

## 目前狀態

這是尚未完成 release 的開源專案。demo 流程可在本機執行；目前已驗證的真實 Codex CLI 為 `0.163.0`。一次 real Codex adversarial synthetic article smoke 已通過，Skill reflection、3 次 replay、activate 與 baseline restore 的 lifecycle smoke 也已通過；兩者都沒有讀取或寫入 production。這些證據不等於完整 live E2E、production readiness、排名、流量、CTR、GEO 或 ROI 成果。

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

`npm run test:e2e` 需要本機已可用的 Playwright Chromium；CI-equivalent Chromium journey 目前仍待重新驗證。上述檢查不會取得 production credentials，也不會部署、發布或變更外部網站。此 repository 不自動部署、不自動發布。
