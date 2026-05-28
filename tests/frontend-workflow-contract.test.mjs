import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scanner keeps searched tickers and exposes watchlist controls", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

  for (const needle of [
    "WATCHLIST_STORAGE_KEY",
    "toggleWatchlist",
    "renderQuickFilters",
    "passesQuickFilter",
    "recordScanHistory",
    "SCAN_HISTORY_STORAGE_KEY",
    "SCANNED_STOCKS_STORAGE_KEY",
    "rememberScannedStocks",
    "mergeSavedScannedStocks",
    "mergeServerScannedStocks",
    "/api/scanned",
    "requestDataEnrichment",
    "/api/enrichment",
    "row-watch-toggle",
    "mergeStockResults(stocks, incoming)",
    "searchResultTickers.add(stock.ticker)"
  ]) {
    assert.ok(app.includes(needle), `app.js missing scanner workflow hook: ${needle}`);
  }
});

test("watchlist is the first scanner view and supports direct ticker add", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  for (const needle of [
    'let activeSector = "__watchlist"',
    "const WATCHLIST_SECTOR",
    "watchlist-add-form",
    "watchlistTickerInput",
    "addWatchlistTickers",
    "ensureWatchlistStocks",
    "fetchWatchlistStocks",
    "loadCloudWatchlist",
    "persistCloudWatchlist",
    "/api/watchlist",
    "priorityTickers",
    "첫 화면은 관심 종목부터 보여줍니다"
  ]) {
    assert.ok(app.includes(needle), `watchlist-first workflow missing: ${needle}`);
  }

  assert.ok(css.includes(".watchlist-rail-card"));
  assert.ok(css.includes(".watchlist-add-form"));
});

test("detail trust panel exposes data audit controls", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.ok(app.includes("renderDataCrossChecks"));
  assert.ok(app.includes("dataCrossChecks"));
  assert.ok(app.includes("anomalyWarnings"));
  assert.ok(css.includes("data-audit-row"));
});

test("fundamental preload covers extended FMP financial endpoints", async () => {
  const preload = await readFile(new URL("../preload_fundamentals.mjs", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  for (const endpoint of [
    "key-metrics-ttm",
    "balance-sheet-statement",
    "cash-flow-statement",
    "analyst-estimates"
  ]) {
    assert.ok(preload.includes(endpoint), `preload missing FMP endpoint: ${endpoint}`);
    assert.ok(server.includes(endpoint), `server missing FMP endpoint: ${endpoint}`);
  }

  for (const field of ["keyMetrics", "balance", "cashflow", "estimates"]) {
    assert.ok(server.includes(field), `server missing FMP bundle field: ${field}`);
  }
});

test("news sentiment exposes per-item evidence and weighted method", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  assert.ok(server.includes("newsToneScore"));
  assert.ok(server.includes("가중 키워드"));
  assert.ok(server.includes("newsConfidence"));
  assert.ok(app.includes("감성점수"));
  assert.ok(app.includes("item.reason"));
});

test("backtest defaults to long sample request in the UI", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

  assert.ok(app.includes("limit=60"));
  assert.ok(app.includes("years=5"));
  assert.ok(app.includes("표본 기준 통과"));
  assert.ok(app.includes("backtestHistory"));
  assert.ok(app.includes("누적 검증 기록"));
});

test("SEC insight renders structured Form 4 and 13F summary", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  assert.ok(server.includes("secStructureSummary"));
  assert.ok(server.includes("filingSummary"));
  assert.ok(app.includes("renderFilingSummary"));
  assert.ok(app.includes("SEC/Form 4/13F 구조화 요약"));
});

test("US price loader rejects too-short chart caches", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  assert.ok(server.includes("MIN_US_HISTORY_ROWS = 40"));
  assert.ok(server.includes("cacheRead(key, MIN_US_HISTORY_ROWS)"));
  assert.ok(server.includes("raw.rows.length < minRows"));
  assert.ok(server.includes("rows.length >= MIN_US_HISTORY_ROWS"));
  assert.ok(server.includes("alphaRows.length >= MIN_US_HISTORY_ROWS"));
});

test("portfolio cloud requests include a local access token", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  assert.ok(app.includes("PORTFOLIO_ACCESS_TOKEN_KEY"));
  assert.ok(app.includes("portfolioCloudHeaders"));
  assert.ok(app.includes("x-portfolio-token"));
  assert.ok(server.includes("portfolioTokenHash"));
  assert.ok(server.includes("portfolioAuthMatches"));
  assert.ok(server.includes("stripPortfolioAuth"));
});

test("portfolio account size accepts one-dollar precision", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.ok(html.includes('id="portfolioEquityInput"'));
  assert.ok(html.includes('step="1"'));
  assert.ok(!html.includes('id="portfolioEquityInput" type="number" min="0" step="100"'));
});

test("portfolio summary cards include help tooltips", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  [
    "계좌 규모",
    "평가 금액",
    "오픈 리스크",
    "포트폴리오 Heat",
    "섹터 집중도",
    "최대 단일 리스크",
    "KRW 환산 평가",
    "점수 변화"
  ].forEach((label) => {
    assert.ok(html.includes(`data-term-help="${label}"`));
    assert.ok(app.includes(`"${label}"`));
  });
  assert.ok(app.includes("hydrateStaticTermHelp"));
});

test("FMP bundle cache schema includes expanded financial fields", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../preload_fundamentals.mjs", import.meta.url), "utf8");

  assert.ok(server.includes("FMP_BUNDLE_SCHEMA_VERSION = 2"));
  assert.ok(server.includes("fmpBundleHasExpandedCoverage"));
  assert.ok(server.includes("bundle.balance?.length || bundle.cashflow?.length"));
  assert.ok(preload.includes("FMP_BUNDLE_SCHEMA_VERSION = 2"));
  assert.ok(preload.includes("bundle.keyMetrics"));
  assert.ok(preload.includes("bundle.balance.length"));
  assert.ok(preload.includes("bundle.cashflow.length"));
});
