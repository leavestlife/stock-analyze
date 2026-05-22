# Real Data Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ticker/company searches such as `google`, `mu`, `nvidia`, `voo`, and `005930` resolve to real securities instead of temporary candidates.

**Architecture:** Keep the server as the authority for search resolution, classification, and fallback reasons. The frontend should display server results in API mode and only use local sample candidates in `file://` mode.

**Tech Stack:** Node HTTP server in `server.mjs`, Vanilla JS frontend in `app.js`, contract tests in `tests/server-contract.test.mjs`.

---

### Task 1: Server Search Resolver

**Files:**
- Modify: `server.mjs`
- Test: `tests/server-contract.test.mjs`

- [ ] **Step 1: Add alias maps**

Add local alias maps near constants:

```js
const US_STOCK_ALIASES = new Map([
  ["GOOGLE", "GOOGL"],
  ["ALPHABET", "GOOGL"],
  ["NVIDIA", "NVDA"],
  ["엔비디아", "NVDA"],
  ["MICRON", "MU"],
  ["마이크론", "MU"],
  ["APPLE", "AAPL"],
  ["애플", "AAPL"],
  ["TESLA", "TSLA"],
  ["테슬라", "TSLA"],
  ["MICROSOFT", "MSFT"],
  ["AMAZON", "AMZN"],
  ["META", "META"],
  ["FACEBOOK", "META"]
]);
const KR_STOCK_ALIASES = new Map([
  ["삼성전자", "005930"],
  ["SAMSUNG", "005930"],
  ["하이닉스", "000660"],
  ["SK하이닉스", "000660"],
  ["SK HYNIX", "000660"]
]);
```

- [ ] **Step 2: Add `resolveSearchInput()`**

Add a helper that normalizes the raw search term and returns canonical ticker plus source.

```js
function resolveSearchInput(raw) {
  const original = String(raw || "").trim();
  const upper = original.toUpperCase();
  if (US_STOCK_ALIASES.has(upper)) return { query: US_STOCK_ALIASES.get(upper), source: "alias", original };
  if (KR_STOCK_ALIASES.has(original)) return { query: KR_STOCK_ALIASES.get(original), source: "alias", original };
  if (KR_STOCK_ALIASES.has(upper)) return { query: KR_STOCK_ALIASES.get(upper), source: "alias", original };
  return { query: upper, source: "input", original };
}
```

- [ ] **Step 3: Use resolver in `resolveSecurity()` and `/api/stocks`**

`resolveSecurity(raw)` should call `resolveSearchInput(raw)` before known security, ETF, KR, and Yahoo lookup. `/api/stocks` should move the resolved security to the top even if it already exists in the universe.

- [ ] **Step 4: Test aliases**

Add contract tests:

```js
const google = await getJson(port, "/api/stocks?market=us&query=google");
assert.equal(google.items[0].ticker, "GOOGL");
const mu = await getJson(port, "/api/stocks?market=us&query=mu");
assert.equal(mu.items[0].ticker, "MU");
```

### Task 2: Frontend API Mode Search Behavior

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Send all non-empty search terms to server**

Replace the strict alphanumeric query condition with a safer length-based condition:

```js
const safeQuery = query.length <= 40 ? query : "";
const queryParam = safeQuery ? `&query=${encodeURIComponent(safeQuery)}` : "";
```

- [ ] **Step 2: Stop adding ad-hoc candidates in API mode**

When `canUseApi` is true, assign `payload.items` directly. Do not call `ensureSearchTicker()` on successful API responses. If no rows return, show the no-data row.

- [ ] **Step 3: Keep file mode fallback**

Only `file://` mode should use `ensureSearchTicker()` and `buildAdHocTicker()`.

### Task 3: ETF And KR Coverage

**Files:**
- Modify: `server.mjs`
- Test: `tests/server-contract.test.mjs`

- [ ] **Step 1: Ensure ETF aliases resolve**

Known ETFs resolve before Yahoo and keep `classification.assetType = "etf"`.

- [ ] **Step 2: Ensure KR aliases resolve**

`삼성전자` resolves to `005930`, `SK하이닉스` resolves to `000660`, and Korean 6-digit tickers keep Naver history loading.

- [ ] **Step 3: Add contract tests**

```js
const voo = await getJson(port, "/api/stocks?market=us&query=voo");
assert.equal(voo.items[0].classification.assetType, "etf");
const samsung = await getJson(port, "/api/stocks?market=kr&query=삼성전자");
assert.equal(samsung.items[0].ticker, "005930");
```

### Task 4: Verification

**Files:**
- Test only

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check server.mjs
node --check app.js
```

Expected: no output and exit code 0.

- [ ] **Step 2: Run contract tests**

Run:

```powershell
node --test tests\server-contract.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Smoke query payloads**

Run an ephemeral server and check:

```text
google -> GOOGL / stock
mu -> MU / stock
voo -> VOO / etf
삼성전자 -> 005930 / stock
```
