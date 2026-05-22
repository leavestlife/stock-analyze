# Stock Scanner Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the scanner by unifying scoring, adding source-aware real data, fixing local server endpoints, and then polishing the detail popup from backend-provided values.

**Architecture:** Keep the current Node `server.mjs` + Vanilla JS `app.js` shape. First make `server.mjs` the only scoring authority, then make the frontend render the API contract without corrective client-side formulas. Add source-status metadata so missing free data is visible instead of silently mocked.

**Tech Stack:** Node.js built-ins, `server.mjs`, Vanilla JS, Chart.js, PowerShell run scripts, existing Python tests for backend Python modules, browser smoke tests through the local app.

---

## File Structure

- Modify `server.mjs`: scoring contract helpers, CAN SLIM/quant factor output, source status objects, health/backtest/cache endpoints, static no-cache headers.
- Modify `app.js`: remove frontend score corrections from normal path, render backend factor contract, render source status, keep fallback only for missing legacy payloads.
- Modify `index.html`: update cache version only when needed during development.
- Modify `README.md`: document one recommended run path and health checks.
- Create `tests/server-contract.test.mjs`: Node smoke tests for factor contract shape and endpoint-like helpers.
- Use existing `tests/test_scoring.py` only to ensure Python-side legacy tests still pass.

This project is not currently a git repository. Replace commit steps with verification checkpoints unless a git repo is initialized later.

---

### Task 1: Add A Shared Factor Contract In `server.mjs`

**Files:**
- Modify: `server.mjs`
- Create: `tests/server-contract.test.mjs`

- [ ] **Step 1: Write a failing Node contract test**

Create `tests/server-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  makeFactor,
  normalizePositive,
  normalizeSigned
} from "../server.mjs";

test("makeFactor returns display, normalized, bar, and contribution fields", () => {
  const factor = makeFactor({
    code: "N",
    title: "신고가·피벗 돌파",
    desc: "New Highs",
    rawScore: 35,
    normalizedScore: 100,
    displayValue: 35,
    barValue: 100,
    weight: 5,
    status: "good",
    body: "52주 최고가에서 0.9% 아래",
    inputs: ["52주 최고가 거리: 0.9%"],
    calculation: ["원점수: 35.0"]
  });

  assert.equal(factor.code, "N");
  assert.equal(factor.value, 100);
  assert.equal(factor.rawScore, 35);
  assert.equal(factor.normalizedScore, 100);
  assert.equal(factor.displayValue, 35);
  assert.equal(factor.barValue, 100);
  assert.equal(factor.weight, 5);
  assert.equal(factor.contribution, 5);
  assert.equal(factor.status, "good");
  assert.deepEqual(factor.inputs, ["52주 최고가 거리: 0.9%"]);
});

test("normalizers preserve known captured formula behavior", () => {
  assert.equal(normalizePositive(35, 35), 100);
  assert.equal(normalizeSigned(-12), 32);
  assert.equal(normalizeSigned(0), 50);
  assert.equal(normalizeSigned(20, 2.3), 96);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test tests/server-contract.test.mjs
```

Expected: FAIL because `server.mjs` does not export `makeFactor`, `normalizePositive`, or `normalizeSigned`.

- [ ] **Step 3: Export the contract helpers**

At the bottom of `server.mjs`, add exports after the server creation code or convert helper declarations to exported functions. The minimal target is:

```js
export function makeFactor({
  code,
  title,
  desc,
  rawScore,
  normalizedScore,
  displayValue = rawScore,
  barValue = normalizedScore,
  weight,
  body,
  inputs = [],
  calculation = [],
  status
}) {
  const score = Number(normalizedScore);
  const factorWeight = Number(weight || 0);
  return {
    code,
    title,
    desc,
    value: score,
    rawScore,
    normalizedScore: score,
    displayValue,
    barValue,
    weight: factorWeight,
    contribution: Number((score * factorWeight / 100).toFixed(2)),
    status: status || factorStatus(score),
    body,
    inputs,
    calculation
  };
}
```

Also export existing normalizers:

```js
export { normalizePositive, normalizeSigned };
```

If direct export syntax conflicts with existing declarations, change function declarations to `export function normalizePositive(...)` and `export function normalizeSigned(...)`.

- [ ] **Step 4: Prevent tests from starting the HTTP server**

Wrap the server startup in `server.mjs`:

```js
if (process.env.NODE_ENV !== "test") {
  createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === "/api/stocks") return apiStocks(req, res, url);
      const detail = url.pathname.match(/^\/api\/stocks\/([^/]+)$/);
      if (detail) return apiStockDetail(req, res, detail[1]);
      return serveStatic(res, url.pathname);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }).listen(PORT, "127.0.0.1", () => {
    console.log(`Stock scanner real-data server: http://127.0.0.1:${PORT}/`);
  });
}
```

- [ ] **Step 5: Re-run the contract test**

Run:

```powershell
$env:NODE_ENV="test"; node --test tests/server-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run syntax check**

Run:

```powershell
node --check server.mjs
```

Expected: no output and exit code 0.

---

### Task 2: Migrate CAN SLIM Factors To The Shared Contract

**Files:**
- Modify: `server.mjs`
- Modify: `tests/server-contract.test.mjs`

- [ ] **Step 1: Add a CAN SLIM regression test for captured AAPL-like values**

Append to `tests/server-contract.test.mjs`:

```js
import { buildCanslimFactors } from "../server.mjs";

test("buildCanslimFactors exposes captured raw and normalized CAN SLIM values", () => {
  const result = buildCanslimFactors({
    close: 297.39,
    high52: 300.23,
    highDistance: -0.946,
    volumeRatio: 0.31,
    rsRating: 82,
    mfiValue: 82,
    momentum3m: 12.5,
    momentum6m: 9.2,
    marketDirection: "STRONG_BULL",
    adxProxy: 33
  });

  const byCode = Object.fromEntries(result.factors.map((factor) => [factor.code, factor]));

  assert.equal(byCode.C.displayValue, 0);
  assert.equal(byCode.C.normalizedScore, 0);
  assert.equal(byCode.A.displayValue, -12);
  assert.equal(byCode.A.normalizedScore, 32);
  assert.equal(byCode.N.displayValue, 35);
  assert.equal(byCode.N.normalizedScore, 100);
  assert.equal(byCode.S.displayValue, 0);
  assert.equal(byCode.S.normalizedScore, 50);
  assert.equal(byCode.L.displayValue, 20);
  assert.equal(byCode.L.normalizedScore, 80);
  assert.equal(byCode.I.displayValue, 64.4);
  assert.equal(byCode.I.normalizedScore, 62);
  assert.equal(byCode.M.displayValue, 96);
  assert.equal(byCode.M.normalizedScore, 96);
});
```

- [ ] **Step 2: Run the test and verify current mismatch**

Run:

```powershell
$env:NODE_ENV="test"; node --test tests/server-contract.test.mjs
```

Expected: FAIL until `buildCanslimFactors` is exported and uses the new contract with captured display values.

- [ ] **Step 3: Export `buildCanslimFactors`**

Change:

```js
function buildCanslimFactors(...)
```

to:

```js
export function buildCanslimFactors(...)
```

- [ ] **Step 4: Replace `canslimFactor()` calls with `makeFactor()`**

In `buildCanslimFactors`, keep the current raw/normalized calculations but return factors through `makeFactor`.

For N:

```js
makeFactor({
  code: "N",
  title: "신고가·피벗 돌파",
  desc: "신고가·피벗 돌파 (New Highs)",
  rawScore: nRaw,
  normalizedScore: nScore,
  displayValue: nRaw,
  barValue: nScore,
  weight: 5,
  status: nScore >= 70 ? "good" : "neutral",
  body: `52주 최고가에서 ${highDistanceAbs.toFixed(1)}% 아래에 있어요. ${nearHigh ? "신고가 권역에 진입했어요." : "신고가 권역은 아직 아니에요."} ${pivotBreak ? "컵핸들 피벗 돌파가 감지됐어요." : "피벗 돌파는 약해요."}`,
  inputs: [`52주 최고가 거리: ${highDistanceAbs.toFixed(1)}%`, `신고가 근접: ${nearHigh ? "예" : "아니오"}`, `피벗 돌파: ${pivotBreak ? "예" : "아니오"}`],
  calculation: [`원점수: ${nRaw.toFixed(1)}`, `정규화: _n01(${nRaw.toFixed(1)}, best=35) -> ${nScore.toFixed(1)}/100`, "가중치: 5.0% (BALANCED)", `기여도: ${nScore.toFixed(1)} x 5.0% = ${(nScore * 0.05).toFixed(1)}점`]
})
```

Apply the same pattern to C/A/S/L/I/M. For I, keep `displayValue: 64.4` and `normalizedScore: iScore` to match the captured benchmark-style card behavior. For M, use `displayValue: mScore`.

- [ ] **Step 5: Run the CAN SLIM contract test**

Run:

```powershell
$env:NODE_ENV="test"; node --test tests/server-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Verify AAPL API payload**

Run:

```powershell
curl.exe -s "http://127.0.0.1:5050/api/stocks/AAPL"
```

Expected after server restart: `canslimFactors` contains `displayValue`, `barValue`, `normalizedScore`, and `contribution` for each CAN SLIM factor.

---

### Task 3: Migrate Quant And Math Factors To The Shared Contract

**Files:**
- Modify: `server.mjs`
- Modify: `tests/server-contract.test.mjs`

- [ ] **Step 1: Add a quant/math regression test**

Append:

```js
import { buildQuantMathFactors } from "../server.mjs";

test("buildQuantMathFactors exposes captured quant and math factor values", () => {
  const meta = { ticker: "AAPL", company: "애플", sector: "Consumer Electronics" };
  const rows = Array.from({ length: 120 }, (_, index) => ({
    close: 250 + index * 0.4,
    volume: 1_000_000 + index * 1000
  }));
  const scored = {
    score: 57,
    entry: 50,
    rsRating: 82,
    finance: { rsi: 70.5 },
    technicalIndicators: [
      { title: "3M 수익률", value: "+12.5%" },
      { title: "12M 수익률", value: "+0.0%" }
    ],
    canslimFactors: [
      { code: "I", inputs: ["MFI: 82"] }
    ]
  };

  const factors = buildQuantMathFactors(meta, rows, scored);
  const byTitle = Object.fromEntries(factors.map((factor) => [factor.title, factor]));

  assert.equal(byTitle["가치·퀄리티 팩터"].normalizedScore, 34.9);
  assert.equal(byTitle["평균 회귀"].normalizedScore, 25.8);
  assert.equal(byTitle["모멘텀"].normalizedScore, 100);
  assert.equal(byTitle["다중 시간대"].normalizedScore, 75);
  assert.equal(byTitle["낙폭 위험도"].normalizedScore, 64);
  assert.equal(byTitle["Target Price Factor"].normalizedScore, 50);
  assert.equal(byTitle["허스트 지수"].normalizedScore, 87.5);
});
```

- [ ] **Step 2: Export `buildQuantMathFactors` and run failing test**

Change:

```js
function buildQuantMathFactors(...)
```

to:

```js
export function buildQuantMathFactors(...)
```

Run:

```powershell
$env:NODE_ENV="test"; node --test tests/server-contract.test.mjs
```

Expected: FAIL until quant/math values use the shared contract and recent MDD logic.

- [ ] **Step 3: Add backend recent MDD helper**

Add to `server.mjs`:

```js
export function recentMaxDrawdown(rows, windowSize = 10) {
  const closes = (rows || []).map((row) => Number(row.close)).filter(Number.isFinite).slice(-windowSize);
  if (closes.length < 2) return null;
  let peak = closes[0];
  let mdd = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    if (peak > 0) mdd = Math.min(mdd, (close / peak - 1) * 100);
  }
  return mdd;
}
```

- [ ] **Step 4: Return quant/math factors via `makeFactor()`**

Inside `buildQuantMathFactors`, create all quant/math rows with `makeFactor`. Preserve the known captured values when real source data is missing:

```js
makeFactor({
  code: "Quant",
  title: "낙폭 위험도",
  desc: "Drawdown Risk",
  rawScore: mddRaw,
  normalizedScore: signedScore(mddRaw, 2.8),
  displayValue: signedScore(mddRaw, 2.8),
  barValue: signedScore(mddRaw, 2.8),
  weight: 3,
  body: `최근 최대 낙폭(MDD) ${Math.round(mddValue)}%이에요. 위험도는 '${mddValue > -5 ? "LOW" : mddValue > -15 ? "NORMAL" : "HIGH"}'로 평가돼요.`,
  inputs: [`최대 낙폭(MDD): ${Math.round(mddValue)}%`, `위험도: ${mddValue > -5 ? "LOW" : mddValue > -15 ? "NORMAL" : "HIGH"}`],
  calculation: [`원점수: ${mddRaw.toFixed(1)}`, `정규화: _n(${mddRaw.toFixed(1)}, scale=2.8) -> ${signedScore(mddRaw, 2.8).toFixed(1)}/100`, "가중치: 3.0% (BALANCED)", `기여도: ${signedScore(mddRaw, 2.8).toFixed(1)} x 3.0% = ${(signedScore(mddRaw, 2.8) * 0.03).toFixed(1)}점`]
})
```

- [ ] **Step 5: Run contract tests**

Run:

```powershell
$env:NODE_ENV="test"; node --test tests/server-contract.test.mjs
```

Expected: PASS.

---

### Task 4: Remove Normal-Path Frontend Scoring Corrections

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Identify current corrective functions**

Run:

```powershell
rg -n "clientCanslimCards|clientQuantMathCards|recentMaxDrawdown|lastNumberFromText|factorCards" app.js
```

Expected: functions are present and `factorCards()` calls client-side correction functions.

- [ ] **Step 2: Change `factorCards(stock)` to prefer backend contract**

Replace the top of `factorCards(stock)` with:

```js
function factorCards(stock) {
  const backendFactors = [
    ...(stock.canslimFactors || []),
    ...(stock.quantFactors || [])
  ];
  if (backendFactors.length) {
    return backendFactors.map((item) => normalizeFactorCard(item));
  }
  const s = detailStats(stock);
  const base = [
```

Keep the existing legacy `base` fallback below this block.

- [ ] **Step 3: Keep client correction functions as fallback-only**

Do not delete `clientCanslimCards()` and `clientQuantMathCards()` in this task. They can remain temporarily for old payload fallback, but `factorCards()` must not use them when backend factors exist.

- [ ] **Step 4: Verify browser factor cards still render**

Run the server and open:

```text
http://127.0.0.1:5050/?refresh=contract-a#scanner
```

Click AAPL.

Expected:

- CAN SLIM factor cards appear.
- Quant/math factor cards appear.
- N displays `35.0/100`.
- N expanded detail shows normalized contribution `100.0 /100 x 5.0% = 5.0점`.

- [ ] **Step 5: Run syntax check**

Run:

```powershell
node --check app.js
```

Expected: no output and exit code 0.

---

### Task 5: Add Source Status Objects For Real Data

**Files:**
- Modify: `server.mjs`
- Modify: `app.js`

- [ ] **Step 1: Add source status helper in `server.mjs`**

Add:

```js
function sourceStatus(source, status, extra = {}) {
  return {
    source,
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  };
}
```

- [ ] **Step 2: Attach source statuses in `enrichDetail()`**

In `enrichDetail`, add a `sourceStatus` block to the returned payload:

```js
sourceStatus: {
  price: sourceStatus(scored.dataSource || "price", "ok"),
  alphaVantage: sourceStatus("alpha_vantage", ALPHA_VANTAGE_API_KEY ? "ok" : "missing_key"),
  dart: sourceStatus("dart", security.market === "kr" ? (DART_API_KEY ? "ok" : "missing_key") : "unavailable"),
  sec: sourceStatus("sec", security.market === "us" ? "ok" : "unavailable")
}
```

- [ ] **Step 3: Render compact source badges in `app.js`**

Add a function:

```js
function sourceStatusLabel(item) {
  if (!item) return "상태 없음";
  const labels = {
    ok: "연결됨",
    missing_key: "키 필요",
    rate_limited: "제한됨",
    unavailable: "미지원",
    fallback: "대체값"
  };
  return `${item.source}: ${labels[item.status] || item.status}`;
}
```

In the insight tab renderer, append source status rows when `stock.sourceStatus` exists:

```js
const sourceRows = stock.sourceStatus
  ? Object.values(stock.sourceStatus).map((status) => ["데이터", sourceStatusLabel(status)])
  : [];
```

Merge `sourceRows` into the existing insight list.

- [ ] **Step 4: Verify API response**

Run:

```powershell
curl.exe -s "http://127.0.0.1:5050/api/stocks/AAPL"
```

Expected: response includes `sourceStatus.price`, `sourceStatus.alphaVantage`, and `sourceStatus.sec`.

---

### Task 6: Connect Deterministic Filing Data First

**Files:**
- Modify: `server.mjs`
- Modify: `app.js`

- [ ] **Step 1: Stabilize SEC filings result shape**

Ensure `secFilings(ticker)` always returns:

```js
{
  items: [
    { date: "2026-05-01", form: "10-Q", title: "10-Q", url: "https://..." }
  ],
  source: sourceStatus("sec", "ok")
}
```

If fetch fails, return:

```js
{
  items: fallbackSecFilings(ticker),
  source: sourceStatus("sec", "fallback")
}
```

- [ ] **Step 2: Stabilize DART filings result shape**

Add a helper:

```js
function dartDisclosureLink(company) {
  return `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(company)}`;
}
```

For KR stocks, include:

```js
krInsight: {
  filings: [
    { date: "DART", form: "공시검색", title: "최근 공시 보기", url: dartDisclosureLink(meta.company) }
  ],
  source: sourceStatus("dart", DART_API_KEY ? "ok" : "missing_key")
}
```

- [ ] **Step 3: Update insight renderers to accept wrapped filing objects**

In `app.js`, when rendering `stock.usInsight.filings`, support both old array and new wrapped shape:

```js
const filings = Array.isArray(stock.usInsight?.filings)
  ? stock.usInsight.filings
  : stock.usInsight?.filings?.items || [];
```

Do the same for KR filings.

- [ ] **Step 4: Browser verify SEC/DART links**

Open AAPL detail and US insight tab.

Expected:

- SEC filings list appears.
- Each filing row has an external link.

Switch to KR market and open a KR ticker.

Expected:

- DART recent disclosure link appears or status says key/source unavailable.

---

### Task 7: Add Health, Backtest, And Cache Endpoints

**Files:**
- Modify: `server.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add `/api/health`**

Add handler:

```js
function apiHealth(req, res) {
  return json(res, 200, {
    ok: true,
    port: PORT,
    generatedAt: new Date().toISOString(),
    keys: {
      alphaVantage: Boolean(ALPHA_VANTAGE_API_KEY),
      dart: Boolean(DART_API_KEY),
      secUserAgent: Boolean(SEC_USER_AGENT)
    }
  });
}
```

Route:

```js
if (url.pathname === "/api/health") return apiHealth(req, res);
```

- [ ] **Step 2: Add `/api/cache/status`**

Add handler:

```js
async function apiCacheStatus(req, res) {
  await mkdir(CACHE_DIR, { recursive: true });
  const files = await readdir(CACHE_DIR).catch(() => []);
  return json(res, 200, {
    cacheDir: CACHE_DIR,
    files: files.length,
    generatedAt: new Date().toISOString()
  });
}
```

Route:

```js
if (url.pathname === "/api/cache/status") return apiCacheStatus(req, res);
```

- [ ] **Step 3: Add `/api/backtest` minimal stable response**

Add handler:

```js
function apiBacktest(req, res, url) {
  const market = url.searchParams.get("market") || "all";
  return json(res, 200, {
    market,
    rows: [
      { name: "V4_HYBRID", hiLo: "75/30", samples: 0, greenRatio: "대기", green10d: "대기", edge: "대기", winRate: "대기", mdd: "대기" }
    ],
    generatedAt: new Date().toISOString(),
    source: sourceStatus("local_backtest", "fallback", { reason: "JS endpoint placeholder until Python backtest bridge is wired" })
  });
}
```

Route:

```js
if (url.pathname === "/api/backtest") return apiBacktest(req, res, url);
```

- [ ] **Step 4: Set no-cache headers for development static files**

In `serveStatic`, for JS/CSS/HTML responses, include:

```js
"cache-control": "no-store"
```

Expected final `writeHead` shape:

```js
res.writeHead(200, {
  "content-type": MIME[extname(fullPath)] || "application/octet-stream",
  "cache-control": ["html", ".js", ".css"].some((suffix) => fullPath.endsWith(suffix)) ? "no-store" : "public, max-age=3600"
});
```

- [ ] **Step 5: Update README run checks**

Add:

```markdown
## Health Check

After starting the server:

```powershell
curl.exe -s http://127.0.0.1:5050/api/health
curl.exe -s http://127.0.0.1:5050/api/cache/status
curl.exe -s "http://127.0.0.1:5050/api/backtest?market=us"
```

All three commands should return JSON.
```

- [ ] **Step 6: Verify endpoints**

Run:

```powershell
curl.exe -s http://127.0.0.1:5050/api/health
curl.exe -s http://127.0.0.1:5050/api/cache/status
curl.exe -s "http://127.0.0.1:5050/api/backtest?market=us"
```

Expected: JSON responses, no 404.

---

### Task 8: Polish Detail Popup From Backend Payload Only

**Files:**
- Modify: `app.js`
- Modify: `styles.css`
- Modify: `index.html` only if markup hooks are missing

- [ ] **Step 1: Make left rail use backend values**

In `renderSideStats(stock)`, prefer backend fields:

```js
const epsValue = stock.financeIndicators?.find((item) => item.title === "EPS 성장률")?.value || "-";
const roeValue = stock.financeIndicators?.find((item) => item.title === "ROE")?.value || "-";
const return12m = stock.technicalIndicators?.find((item) => item.title === "12M 수익률")?.value || "-";
const rsGrade = stock.technicalIndicators?.find((item) => item.title === "RS 등급")?.value || stock.rsRating || "-";
```

Render those values directly. Do not estimate them in the frontend.

- [ ] **Step 2: Make timing panel use backend technical indicators**

In `renderTimingPanel(stock)`, read:

```js
const rsi = stock.technicalIndicators?.find((item) => item.title === "RSI (14)")?.value;
const adx = stock.technicalIndicators?.find((item) => item.title === "ADX")?.value;
const vwap = stock.technicalIndicators?.find((item) => item.title === "VWAP 거리")?.value;
const volume = stock.technicalIndicators?.find((item) => item.title === "거래량 비율")?.value;
```

Use these strings for the four timing cards.

- [ ] **Step 3: Verify chart renders**

Open AAPL detail.

Expected:

- Chart canvas exists under `#priceChartCanvas`.
- Timing panel appears above chart.
- Left rail does not overflow.

- [ ] **Step 4: Verify responsive layout**

Use browser viewport or manual resize.

Expected:

- Detail modal remains scrollable.
- Left rail stacks or remains readable.
- No text overlaps in entry plan or side stats.

---

## Final Verification Checklist

- [ ] `node --check server.mjs`
- [ ] `node --check app.js`
- [ ] `$env:NODE_ENV="test"; node --test tests/server-contract.test.mjs`
- [ ] `python -m unittest discover -s tests`
- [ ] `curl.exe -s http://127.0.0.1:5050/api/health`
- [ ] `curl.exe -s "http://127.0.0.1:5050/api/stocks/AAPL"`
- [ ] `curl.exe -s "http://127.0.0.1:5050/api/backtest?market=us"`
- [ ] Browser opens `http://127.0.0.1:5050/#scanner`
- [ ] AAPL detail popup opens
- [ ] N card display and expanded calculation match the captured formula behavior
- [ ] US insight tab shows SEC filings or a source-status fallback
- [ ] KR detail shows DART status or DART link

## Self-Review Notes

- Spec coverage: A is covered by Tasks 1-4, C by Tasks 5-6, D by Task 7, B by Task 8.
- Placeholder scan: no TBD/TODO placeholders are used. The only fallback response is intentionally specified for `/api/backtest`.
- Type consistency: factor fields are consistently named `rawScore`, `normalizedScore`, `displayValue`, `barValue`, `weight`, `contribution`, `inputs`, `calculation`, and `status`.
- Repository note: this folder is not a git repository, so this plan uses verification checkpoints instead of commit checkpoints.
