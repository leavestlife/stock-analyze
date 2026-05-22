# Operations Preflight Checklist

Use this before sharing the app, demoing it, or starting a larger UI/data change. Keep checks lightweight and evidence-based.

## 1. Local Server

- Start the app from the project folder.
- Open `http://127.0.0.1:5050/`.
- Confirm health endpoint responds:

```powershell
curl.exe http://127.0.0.1:5050/api/health
```

Pass criteria:

- `ok` is `true`.
- `keys.alphaVantage`, `keys.dart`, and `keys.secUserAgent` reflect the current `.env` setup.
- No secret values are printed.

## 2. Cache Readiness

Check cache status:

```powershell
curl.exe http://127.0.0.1:5050/api/cache/status
```

Pass criteria:

- Response includes `priceFiles`, `freshPriceFiles`, `stalePriceFiles`, `watchedSymbols`, and `missingWatchedSymbols`.
- `watchedSymbols` includes representative checks:
  - `GOOGL`
  - `GOOG`
  - `NVDA`
  - `COST`
  - `SNDK`
  - `SPY`
- `watchedSymbols` should not include `TEAM` unless a future Nasdaq official update restores it.

Notes:

- A high `missingWatchedSymbols` count is acceptable after universe expansion, but it should be called out before demos.
- If many important symbols are missing, run the price preloader for a small representative batch instead of preloading everything at once.

## 3. Representative Searches

Run these in the UI or API:

```powershell
curl.exe "http://127.0.0.1:5050/api/stocks?market=us&query=GOOG"
curl.exe "http://127.0.0.1:5050/api/stocks?market=us&query=GOOGL"
curl.exe "http://127.0.0.1:5050/api/stocks?market=us&query=Costco"
curl.exe "http://127.0.0.1:5050/api/stocks?market=us&query=SNDK"
curl.exe "http://127.0.0.1:5050/api/stocks?market=us&query=SPY"
```

Pass criteria:

- `GOOG` returns ticker `GOOG`.
- `GOOGL` returns ticker `GOOGL`.
- `Costco` returns ticker `COST`.
- `SNDK` returns ticker `SNDK`.
- `SPY` is classified as an ETF.
- Direct search returns one matched security rather than triggering a full visible result list.

## 4. Detail Popup

Check at least one stock and one ETF:

- `COST` or `GOOG`
- `SPY` or `QQQ`

Pass criteria:

- Detail popup opens even if price data is missing.
- Header shows company, ticker, sector, and industry without obvious overlap.
- US insight tab shows:
  - classification evidence
  - data trust summary
  - source status rows
- Missing-price securities clearly show that score and entry timing are not real calculated signals.

## 5. Backtest Smoke

Run:

```powershell
curl.exe "http://127.0.0.1:5050/api/backtest?market=us"
```

Pass criteria:

- Endpoint returns HTTP 200.
- Response has `status`, `results`, `errors`, `source`, and `generatedAt`.
- `status` is one of:
  - `ok`
  - `partial`
  - `not_ready`
  - `no_samples`
- If `results` is empty or `status` is not `ok`, mention it in demo notes instead of implying full evidence is available.

## 6. Browser QA

Desktop viewport:

- Search for `Costco`.
- Confirm one visible row.
- Open detail popup.
- Switch to `US 인사이트`.

Mobile viewport:

- Check header stacking.
- Check quick filters.
- Check table horizontal overflow.
- Check detail modal scroll.

Known current risk:

- Mobile table and quick filters can overflow horizontally. Treat this as a design follow-up unless the current task is mobile layout.
- `favicon.ico` may return 404. Functional impact is low, but it creates console noise.

## 7. Verification Commands

Run before handing off code changes:

```powershell
node --check server.mjs
node --check app.js
node --test tests\server-contract.test.mjs
```

Pass criteria:

- Both syntax checks exit successfully.
- Node test runner reports all tests passing.

## 8. Handoff Notes

Include these in the handoff:

- Changed files.
- Verification command results.
- Whether API keys were present, without exposing values.
- Cache status summary.
- Any fallback-heavy searches observed.
- Any UI issues that are out of scope for the current task.
