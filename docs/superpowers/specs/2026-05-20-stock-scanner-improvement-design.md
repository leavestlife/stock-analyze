# Stock Scanner Improvement Design

Date: 2026-05-20
Project: CAN SLIM Quant Scanner
Priority order: A -> C -> D -> B

## Goal

Make the scanner reliable before making it prettier. The next work should first remove mismatched score calculations, then strengthen real data, then stabilize the local server, and only then polish the detailed popup layout.

The app should behave like a real analysis tool, not a mock UI. Users must be able to click a stock, see where each number came from, and trust that the summary, card value, expanded calculation, and API response are all using the same formula.

## Current Problems

The current app has four main issues.

1. Some values are calculated or corrected in the frontend, while other values come from `server.mjs`.
2. A single factor can have multiple meanings on screen: raw score, normalized score, displayed score, and weighted contribution.
3. Several real-data sections still fall back to placeholder values or weak proxies.
4. Local running behavior is fragile: server restarts, cache busting, and missing endpoints can confuse the browser state.

## Non-Goals

This phase does not try to predict stock prices or produce buy/sell certainty.

It also does not require paid data sources. Free or already-provided keys should be used first. When a data source is missing, the UI should say that clearly instead of silently inventing a value.

## Approach Decision

Use the user's selected order:

1. A: Value accuracy and formula unification
2. C: Real data connection
3. D: Server and execution stability
4. B: Detailed popup completion

This order is deliberate. If UI polishing happens before formula cleanup, the app can look correct while still producing inconsistent numbers. If real data is added before formula cleanup, debugging becomes harder because each mismatch could come from either the data source or the formula layer.

## A. Value Accuracy And Formula Unification

### Design

Move scoring responsibility into a single backend calculation layer in `server.mjs`.

The frontend should render factor data. It should not decide CAN SLIM scores, quant scores, display scores, or weighted contributions except for pure visual formatting.

All factor-like outputs should use one shared data contract:

```js
{
  code: "N",
  title: "신고가·피벗 돌파",
  desc: "신고가·피벗 돌파 (New Highs)",
  rawScore: 35,
  normalizedScore: 100,
  displayValue: 35,
  barValue: 100,
  weight: 5,
  contribution: 5,
  status: "good",
  body: "52주 최고가에서 0.9% 아래에 있어요...",
  inputs: ["52주 최고가 거리: 0.9%", "신고가 근접: 예"],
  calculation: ["원점수: 35.0", "정규화: _n01(35.0, best=35) -> 100.0/100"]
}
```

### Important Distinction

Some original-site cards show a raw score on the card but use normalized score for contribution.

Example:

- N card display: `35.0/100`
- Expanded contribution: `100.0/100 x 5.0% = 5.0점`

This is not a bug if the data contract names the fields clearly. The backend must explicitly return both `displayValue` and `normalizedScore`.

### Acceptance Criteria

- CAN SLIM factors C/A/N/S/L/I/M are produced by one backend path.
- Quant and math factors are produced by one backend path.
- Frontend `clientCanslimCards()` and `clientQuantMathCards()` style corrective scoring is removed or reduced to fallback-only behavior.
- Summary rows, factor cards, expanded detail, and API payload agree.
- Expanded detail always shows input data and calculation process when available.

## C. Real Data Connection

### Design

Connect free and key-backed sources in layers.

US market:

- Price/history: Yahoo path already in use
- Earnings date/data: Alpha Vantage when available
- SEC filings: SEC company search or submissions API with configured user agent
- Analyst targets: Alpha Vantage if available, fallback to Yahoo/placeholder with explicit status
- News sentiment: Alpha Vantage when available, fallback to price/volume proxy with explicit status

KR market:

- Price/history: Naver or Yahoo `.KS` / `.KQ`
- Financial statements: DART using provided key
- Recent filings: DART disclosure links
- News sentiment: Naver news search or existing free source if available; otherwise show source unavailable

### Data Status

Each external section should include a source status:

```js
{
  source: "alpha_vantage",
  status: "ok" | "missing_key" | "rate_limited" | "unavailable" | "fallback",
  updatedAt: "2026-05-20T00:00:00+09:00"
}
```

The UI should display unavailable data as unavailable, not as a confident numeric score.

### Acceptance Criteria

- US insight tab includes earnings, sentiment, analyst targets, and SEC filings when data exists.
- KR disclosure/news tab includes DART filings and Korean stock-specific news or a clear unavailable state.
- All API keys are read from `.env`; no secrets are printed in logs or UI.
- If a source fails, the page still renders.

## D. Server And Execution Stability

### Design

Make local operation boring and predictable.

Add or stabilize these endpoints:

- `GET /api/health`
- `GET /api/stocks?market=us|kr`
- `GET /api/stocks/:ticker`
- `GET /api/backtest?market=us|kr`
- `GET /api/cache/status`

Create one recommended local run path. Existing scripts can remain, but README should point to one primary command.

The browser should not require manual cache version guesses. During development, either static files should be served with no-cache headers or the app should expose a simple refresh token strategy.

### Acceptance Criteria

- Starting the server from the documented command opens a working app on port 5050.
- `/api/backtest` no longer returns 404.
- Browser reload does not show stale JavaScript after code edits when using the documented development path.
- If port 5050 is occupied, the error message explains what to do.

## B. Detailed Popup Completion

### Design

After data and scoring are stable, complete the detailed popup around backend-provided values.

The popup should include:

- Left summary rail matching the benchmark: total score, price, targets, RSI, conviction, entry plan, R:R, EPS, ROE, 12M return, RS rating
- Chart area with timing analysis: trend, momentum, volatility, supply
- CAN SLIM tab with summary rows and factor cards
- Technical tab with RSI, ADX, ATR%, VWAP, RS grade, return metrics, volume, ORB/NR7/Bollinger status
- Finance tab with PER, PBR, ROE, EPS growth, margin, debt ratio, market cap, value and quality factors
- US insight or KR disclosure/news tab depending on market

### Chart

The chart should continue using Chart.js unless there is a strong reason to replace it. It should show:

- Close
- EMA20
- EMA50
- EMA200
- Volume bars

Optional later improvements:

- Bollinger band
- OBV line
- Watermark style if needed

### Acceptance Criteria

- Popup renders without layout overlap on desktop and narrow widths.
- Chart appears for stocks with price history.
- Left rail values come from the same API payload as the tabs.
- US and KR stocks show market-appropriate insight tabs.

## Suggested Implementation Sequence

1. Add a backend `factor` data contract helper and migrate CAN SLIM factors.
2. Migrate quant/math factor generation to the same contract.
3. Replace frontend scoring corrections with API-driven rendering.
4. Add source status objects for US/KR data sections.
5. Connect SEC and DART filing sections first because they are high-value and relatively deterministic.
6. Add earnings, analyst target, and news sentiment with graceful fallback.
7. Add health/backtest/cache endpoints and update run documentation.
8. Polish popup layout using the stabilized API payload.

## Testing And Verification

Use a small known ticker set for smoke tests:

- US stock: AAPL
- US ETF: VOO
- KR stock: 005930 or another available KR ticker

Checks:

- API payload has stable factor fields.
- Expanded factor details match card display and contribution.
- Missing data is labeled as unavailable.
- Browser popup opens and chart renders.
- No console errors from missing routes.

## Risks

External free APIs can be rate-limited or incomplete. This design handles that by surfacing source status and using fallbacks only when clearly labeled.

The original benchmark site may use proprietary formulas or cached data snapshots that cannot be perfectly reproduced. The goal is not byte-for-byte equality. The goal is internally consistent calculations that match the captured formula behavior where known.

## Open Decisions

No blocking open decisions. The user has chosen the implementation order A-C-D-B.

When implementation starts, the first concrete task should be A: move frontend corrective scoring into a backend formula contract and verify AAPL factor values end to end.
