# Current QA Notes - 2026-05-21

Scope: read-only QA notes for the current stock scanner state. This document does not define new product behavior; it records observed risks and follow-up checks so feature work can continue separately.

## Search Flow

- US search resolves local universe tickers and company-name fragments before falling back to remote Yahoo metadata.
- Nasdaq-100 examples verified recently:
  - `GOOG` resolves to Alphabet's `GOOG` class.
  - `GOOGL` resolves separately to Alphabet's `GOOGL` class.
  - `Costco` resolves to `COST`.
  - `SNDK` resolves to Sandisk.
- When a query is present, the server scores only the matched security. This reduces the risk that a single search triggers a full Nasdaq-100 scan.
- `TEAM` should not be treated as a current Nasdaq-100 constituent in this local list.

## API Response Risks

- Price data can be missing even when search resolution succeeds. In that case the payload should remain usable with:
  - `dataSource: "missing"` or another explicit non-OK source marker
  - `price: null`
  - `chart: []`
  - `sourceStatus`
  - `trust`
  - an `errors` entry on list endpoints when the price fetch failed
- Detail popups should still open for missing-price securities, but the UI must not imply that score or entry timing was actually calculated from price history.
- PowerShell JSON parsing can be stricter than browser or Node parsing. If future payload fields add names that differ only by case, for example `canSlim` and `canslim`, PowerShell `ConvertFrom-Json` may fail.
- `/api/cache/status` can show a large `missingWatchedSymbols` count after expanding the universe. That is expected until cache preload catches up.
- `/api/backtest?market=us` can be sensitive to universe size and cache freshness. Keep the endpoint bounded or sampled unless full-universe backtesting is intentionally requested.

## UI QA Findings

- Desktop search and detail popup flow worked in recent checks:
  - search field accepts ticker and company-name fragments
  - result table shows one matched row for direct search
  - detail popup opens
  - US insight tab renders classification evidence and data trust status
- Browser console still reports `favicon.ico` 404. Functional impact is low, but it is noisy during QA.
- Mobile width has visible layout overflow:
  - quick filters extend horizontally beyond the viewport
  - the scanner table remains much wider than the viewport
  - the detail modal is usable, but the top chart/callout area can sit partially outside the visible modal scroll position after viewport resize
- Mobile layout should be treated as a design task, not a data/search bug.

## Recommended Non-Feature Follow-Ups

- Add a small favicon or a harmless `/favicon.ico` response to remove console noise.
- Add a mobile-specific design pass for quick filters, table scrolling, and detail modal scroll anchoring.
- Add API tests for missing-price responses to lock down `price: null`, `chart: []`, `trust`, and `sourceStatus`.
- Keep Nasdaq-100 membership updates in a separate task from search behavior changes.
