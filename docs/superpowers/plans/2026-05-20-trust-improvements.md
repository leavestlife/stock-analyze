# Stock Scanner Trust Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build A -> B -> C trust upgrades so users can see data reliability, verified score math, and backtest evidence instead of trusting black-box scores.

**Architecture:** Keep the current Node server plus Vanilla JS frontend. Add small backend helper functions for confidence metadata and backtest calculation, then render those fields in the existing dashboard/detail popup without a broad rewrite.

**Tech Stack:** Node `http` server, Yahoo/Naver/Alpha/DART/SEC data adapters already in `server.mjs`, Vanilla JS `app.js`, CSS in `styles.css`, Node built-in test runner.

---

### Task A: Data Trust Badges And Score Evidence

**Files:**
- Modify: `server.mjs`
- Modify: `app.js`
- Modify: `styles.css`
- Test: `tests/server-contract.test.mjs`

- [ ] **Step 1: Add backend trust summary helper**

Add a helper in `server.mjs` near `sourceStatus()`:

```js
function trustSummary(sourceStatusMap = {}) {
  const statuses = Object.values(sourceStatusMap).map((item) => item?.status).filter(Boolean);
  const fallbackCount = statuses.filter((status) => status === "fallback" || status === "missing_key").length;
  const okCount = statuses.filter((status) => status === "ok").length;
  const label = fallbackCount === 0 && okCount > 0 ? "높음" : fallbackCount <= 2 ? "보통" : "낮음";
  return {
    label,
    okCount,
    fallbackCount,
    note: fallbackCount ? "일부 항목은 대체값 또는 API 미연결 상태입니다." : "주요 데이터가 정상 연결되었습니다."
  };
}
```

- [ ] **Step 2: Attach trust summary to detail payload**

In `enrichDetail()`, build `sourceStatus` first, then attach:

```js
const sources = {
  price: sourceStatus(scored.dataSource || "price", "ok"),
  alphaVantage: sourceStatus("alphaVantage", alphaSourceStatus(overview, earnings)),
  dart: sourceStatus("dart", dartStatus),
  sec: sourceStatus("sec", secSourceStatus(isKr, filings))
};
```

Return `sourceStatus: sources` and `trust: trustSummary(sources)`.

- [ ] **Step 3: Add test for trust summary**

In `tests/server-contract.test.mjs`, import `createAppServer`, start it on port `0`, fetch `/api/stocks/AAPL`, and assert `sourceStatus` plus `trust.label` exist:

```js
test("detail payload includes source status and trust summary", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const payload = await (await fetch(`http://127.0.0.1:${port}/api/stocks/AAPL`)).json();
  server.close();
  assert.ok(payload.sourceStatus.price);
  assert.ok(["높음", "보통", "낮음"].includes(payload.trust.label));
});
```

- [ ] **Step 4: Render trust panel in detail popup**

In `app.js`, add `renderTrustSummary(stock)` near `renderSourceStatus()`:

```js
function renderTrustSummary(stock) {
  if (!stock.trust) return "";
  return `
    <article class="trust-summary ${stock.trust.label === "높음" ? "good" : stock.trust.label === "낮음" ? "bad" : "neutral"}">
      <span>데이터 신뢰도</span>
      <strong>${escapeHtml(stock.trust.label)}</strong>
      <small>${escapeHtml(stock.trust.note || "")}</small>
    </article>
  `;
}
```

Include it before data source rows in `renderSourceStatus(stock)`.

- [ ] **Step 5: Style trust panel**

Add to `styles.css`:

```css
.trust-summary {
  border-radius: 8px;
  padding: 12px;
  background: #fff;
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, .08);
}

.trust-summary span,
.trust-summary small {
  display: block;
  color: #64748b;
  font-size: 11px;
}

.trust-summary strong {
  display: block;
  margin: 4px 0;
  color: #111827;
  font-size: 20px;
}
```

- [ ] **Step 6: Verify**

Run:

```powershell
node --check server.mjs
node --check app.js
node --test tests\server-contract.test.mjs
```

Expected: all pass.

### Task B: Real Backtest Engine Evidence

**Files:**
- Modify: `server.mjs`
- Modify: `app.js`
- Test: `tests/server-contract.test.mjs`

- [ ] **Step 1: Add a compact backtest calculator**

In `server.mjs`, add `runCompactBacktest(securities)` near `apiBacktest()`:

```js
async function runCompactBacktest(securities) {
  const samples = [];
  const errors = [];
  for (const security of securities) {
    try {
      const rows = await loadHistory(security);
      for (let index = 260; index < rows.length - 10; index += 10) {
        const history = rows.slice(0, index + 1);
        const scored = scoreSecurity(security, history);
        const now = rows[index].close;
        const future = rows[index + 10].close;
        const ret10 = now ? ((future / now) - 1) * 100 : 0;
        samples.push({ entry: scored.entry, ret10 });
      }
    } catch (error) {
      errors.push({ ticker: security.ticker, error: error.message });
    }
  }
  const green = samples.filter((row) => row.entry >= 75);
  const baseline = samples.length ? average(samples.map((row) => row.ret10)) : 0;
  const greenReturn = green.length ? average(green.map((row) => row.ret10)) : 0;
  return {
    results: [{
      name: "V4_HYBRID",
      high: 75,
      low: 30,
      samples: samples.length,
      green_ratio: samples.length ? Number((green.length / samples.length * 100).toFixed(1)) : 0,
      green_return_10d: Number(greenReturn.toFixed(2)),
      edge: Number((greenReturn - baseline).toFixed(2)),
      win_rate: green.length ? Number((green.filter((row) => row.ret10 > 0).length / green.length * 100).toFixed(1)) : 0,
      mdd_20d: null,
      status: samples.length ? "computed" : "no_samples"
    }],
    errors
  };
}
```

- [ ] **Step 2: Replace `apiBacktest()` placeholder**

Use `runCompactBacktest(marketItems(market).slice(0, 20))` and return `status: "computed"` when samples exist.

- [ ] **Step 3: Add backtest API contract test**

In `tests/server-contract.test.mjs`, start `createAppServer()`, fetch `/api/backtest?market=us`, and assert:

```js
assert.equal(payload.results[0].name, "V4_HYBRID");
assert.ok(Number.isFinite(payload.results[0].samples));
assert.notEqual(payload.status, "not_ready");
```

- [ ] **Step 4: Render evidence summary in UI**

In `app.js`, above the backtest rows, show status text using the existing table message row when `payload.status === "computed"`:

```js
backtestRows.innerHTML = `<tr><td colspan="8">실제 과거 일봉 기준으로 계산된 결과입니다.</td></tr>` + rows.map(...)
```

- [ ] **Step 5: Verify**

Run:

```powershell
node --check server.mjs
node --check app.js
node --test tests\server-contract.test.mjs
```

Expected: tests pass and `/api/backtest?market=us` returns numeric metrics.

### Task C: Classification Evidence And Risk Warnings

**Files:**
- Modify: `server.mjs`
- Modify: `app.js`
- Modify: `styles.css`
- Test: `tests/server-contract.test.mjs`

- [ ] **Step 1: Add classification evidence to resolved securities**

In `resolveSecurity()`, include:

```js
classification: {
  source: meta.quoteType ? "Yahoo quoteType" : KNOWN_US_ETFS.has(upper) ? "known ETF list" : "fallback default",
  quoteType: meta.quoteType || "",
  asset_type
}
```

- [ ] **Step 2: Preserve classification in scored output**

Ensure `scoreSecurity(meta, rows)` spreads `...meta`, so `classification` flows to the frontend. Ensure `fallbackScoredSecurity(meta)` also spreads `...meta`.

- [ ] **Step 3: Render classification evidence**

In `renderSourceStatus(stock)`, add an indicator row when `stock.classification` exists:

```js
indicatorRow([
  "종목 분류",
  stock.classification.source,
  stock.classification.asset_type === "etf" ? "ETF" : "개별주식",
  stock.classification.asset_type !== "unknown"
])
```

- [ ] **Step 4: Add visible score warning**

In `renderTrustSummary(stock)`, append a small warning when trust is not high:

```js
${stock.trust.label !== "높음" ? "<small>점수는 후보 압축용이며 매수 확정 신호가 아닙니다.</small>" : ""}
```

- [ ] **Step 5: Style warning text**

Add:

```css
.trust-summary.bad {
  background: #fff1f2;
}

.trust-summary.neutral {
  background: #fff7ed;
}
```

- [ ] **Step 6: Verify**

Run:

```powershell
node --check server.mjs
node --check app.js
node --test tests\server-contract.test.mjs
```

Expected: all pass. Manual API probe should show `classification.asset_type` for searched tickers.

---

## Self-Review

- Spec coverage: A maps to data badges and score evidence, B maps to backtest evidence, C maps to classification/risk warnings.
- Placeholder scan: no TBD/TODO language remains in implementation steps.
- Type consistency: `sourceStatus`, `trust`, and `classification` are explicit payload fields used by frontend renderers.
