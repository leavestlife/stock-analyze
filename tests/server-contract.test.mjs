import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuantMathFactors,
  calculatePortfolioPosition,
  calculatePositionSizing,
  buildCanslimFactors,
  createAppServer,
  makeFactor,
  normalizePositive,
  normalizeSigned,
  recentMaxDrawdown
} from "../server.mjs";

test("position sizing follows fixed fractional risk and strictest constraint", () => {
  const riskBound = calculatePositionSizing({ accountSize: 10000, riskPct: 1, entry: 100, stop: 95, maxPositionPct: 20 });
  assert.equal(riskBound.shares, 20);
  assert.equal(riskBound.dollarRisk, 100);
  assert.equal(riskBound.positionValue, 2000);
  assert.equal(riskBound.bindingConstraint, "risk_budget");

  const positionBound = calculatePositionSizing({ accountSize: 10000, riskPct: 2, entry: 100, stop: 99, maxPositionPct: 10 });
  assert.equal(positionBound.shares, 10);
  assert.equal(positionBound.dollarRisk, 10);
  assert.equal(positionBound.bindingConstraint, "max_position");
});

test("portfolio position math calculates current value, pnl, open risk, and heat", () => {
  const usStock = calculatePortfolioPosition({
    ticker: "AAPL",
    shares: 10,
    avgCost: 180,
    accountSize: 10000,
    quote: { market: "us", price: 200, tradePlan: { stop: 190 } }
  });
  assert.equal(usStock.value, 2000);
  assert.equal(usStock.pnl, 200);
  assert.equal(usStock.openRisk, 100);
  assert.equal(usStock.heat, 1);
  assert.equal(usStock.heatStatus, "good");

  const usEtf = calculatePortfolioPosition({
    ticker: "VOO",
    shares: 20,
    avgCost: 450,
    accountSize: 10000,
    quote: { market: "us", asset_type: "etf", price: 500, tradePlan: { stop: 460 } }
  });
  assert.equal(usEtf.value, 10000);
  assert.equal(usEtf.pnl, 1000);
  assert.equal(usEtf.openRisk, 800);
  assert.equal(usEtf.heat, 8);
  assert.equal(usEtf.heatStatus, "risk");

  const krStock = calculatePortfolioPosition({
    ticker: "005930",
    shares: 10,
    avgCost: 70000,
    accountSize: 1000000,
    quote: { market: "kr", price: 75000, tradePlan: { stop: 69000 } }
  });
  assert.equal(krStock.value, 750000);
  assert.equal(krStock.pnl, 50000);
  assert.equal(krStock.openRisk, 60000);
  assert.equal(krStock.heat, 6);
  assert.equal(krStock.heatStatus, "warn");
});

test("detail trade plan exposes stop calculation basis", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const payload = await (await fetch(`http://127.0.0.1:${port}/api/stocks/AAPL`)).json();
    assert.equal(typeof payload.tradePlan.stopBasis, "string");
    assert.equal(typeof payload.tradePlan.atrStop, "number");
    assert.equal(typeof payload.tradePlan.vcpStop, "number");
    assert.ok(["ATR 1.8배", "20일 저가 1% 여유"].includes(payload.tradePlan.stopBasis));
  } finally {
    server.close();
  }
});

test("detail payload exposes data cross checks and anomaly warnings", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const stockPayload = await (await fetch(`http://127.0.0.1:${port}/api/stocks/NVDA`)).json();
    assert.ok(stockPayload.dataCrossChecks);
    assert.ok(Array.isArray(stockPayload.dataCrossChecks.checks));
    assert.equal(typeof stockPayload.dataCrossChecks.warnCount, "number");
    assert.ok(Array.isArray(stockPayload.anomalyWarnings));
    assert.equal(typeof stockPayload.trust.issueCount, "number");

    const etfPayload = await (await fetch(`http://127.0.0.1:${port}/api/stocks/VOO`)).json();
    assert.ok(etfPayload.anomalyWarnings.some((item) => item.label === "ETF 처리"));
    assert.ok((etfPayload.financeIndicators || []).every((item) => !["PER", "PBR", "ROE", "EPS"].includes(item.title)));
  } finally {
    server.close();
  }
});

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
  assert.equal(normalizePositive(70, 35), 100);
  assert.equal(normalizeSigned(-12), 32);
  assert.equal(normalizeSigned(-100), 0);
  assert.equal(normalizeSigned(0), 50);
  assert.equal(normalizeSigned(20, 2.3), 96);
  assert.equal(normalizeSigned(100), 100);
});

test("buildCanslimFactors exposes captured raw and normalized CAN SLIM values", () => {
  const { factors } = buildCanslimFactors({
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
  const byCode = Object.fromEntries(factors.map((factor) => [factor.code, factor]));

  assert.equal(byCode.C.displayValue, 0);
  assert.equal(byCode.C.normalizedScore, 0);
  assert.equal(byCode.A.displayValue, 32);
  assert.equal(byCode.A.normalizedScore, 32);
  assert.equal(byCode.N.displayValue, 35);
  assert.equal(byCode.N.normalizedScore, 100);
  assert.equal(byCode.S.displayValue, 0);
  assert.equal(byCode.S.normalizedScore, 50);
  assert.equal(byCode.L.displayValue, 20);
  assert.equal(byCode.L.normalizedScore, 80);
  assert.equal(byCode.I.displayValue, 62);
  assert.equal(byCode.I.normalizedScore, 62);
  assert.equal(byCode.M.displayValue, 96);
  assert.equal(byCode.M.normalizedScore, 96);
});

test("buildQuantMathFactors exposes captured Quant/Math normalized values", () => {
  const closes = Array.from({ length: 253 }, (_, index) => {
    if (index < 127) return 100 + index * 0.3;
    if (index === 127) return 200;
    if (index === 128) return 120;
    if (index < 233) return 121 + (index - 129) * 0.28;
    const recent = [
      154, 140, 153.5, 154.2, 154.8,
      155.1, 155.5, 155.9, 156.2, 156.6,
      157, 155.43, 157.8, 158.1, 158.5,
      158.8, 159.1, 159.4, 159.7, 160
    ];
    return recent[index - 233];
  });
  const rows = closes.map((close, index) => ({
    close,
    high: close * 1.01,
    low: close * 0.99,
    volume: 1_000_000 + index
  }));
  const factors = buildQuantMathFactors(
    { sector: "Semiconductors" },
    rows,
    { price: closes.at(-1), entry: 60, finance: { rsi: 70 } }
  );
  const byTitle = Object.fromEntries(factors.map((factor) => [factor.title, factor]));

  assert.equal(byTitle["가치·퀄리티 팩터"].normalizedScore, 34.9);
  assert.equal(byTitle["평균 회귀"].normalizedScore, 25.8);
  assert.equal(byTitle["모멘텀"].normalizedScore, 100);
  assert.equal(byTitle["다중 시간대"].normalizedScore, 75);
  assert.equal(Number(recentMaxDrawdown(closes, 20).toFixed(0)), -9);
  assert.equal(Number(recentMaxDrawdown(closes).toFixed(0)), -1);
  assert.equal(byTitle["낙폭 위험도"].normalizedScore, 64);
  assert.ok(byTitle["낙폭 위험도"].inputs.some((input) => input.includes("-1%")));
  assert.ok(byTitle["낙폭 위험도"].inputs.some((input) => input.includes("LOW")));
  assert.equal(byTitle["목표가 팩터"].normalizedScore, 50);
  assert.equal(byTitle["허스트 지수"].normalizedScore, 87.5);

  for (const factor of [byTitle["다중 시간대"], byTitle["낙폭 위험도"]]) {
    assert.equal(factor.displayValue, factor.normalizedScore);
    assert.equal(factor.barValue, factor.normalizedScore);
    assert.equal(factor.contribution, Number((factor.normalizedScore * factor.weight / 100).toFixed(2)));
  }

  for (const factor of [
    byTitle["가치·퀄리티 팩터"],
    byTitle["평균 회귀"],
    byTitle["모멘텀"],
    byTitle["다중 시간대"],
    byTitle["낙폭 위험도"],
    byTitle["목표가 팩터"],
    byTitle["허스트 지수"]
  ]) {
    assert.ok(Object.hasOwn(factor, "displayValue"));
    assert.ok(Object.hasOwn(factor, "barValue"));
    assert.ok(Object.hasOwn(factor, "normalizedScore"));
    assert.ok(Object.hasOwn(factor, "contribution"));
  }
});

test("detail payload includes source status and trust summary", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const payload = await (await fetch(`http://127.0.0.1:${port}/api/stocks/AAPL`)).json();
    assert.ok(payload.sourceStatus.price);
    assert.ok(["높음", "보통", "낮음"].includes(payload.trust.label));
  } finally {
    server.close();
  }
});

test("detail payload includes stock and ETF classification evidence", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const aapl = await (await fetch(`http://127.0.0.1:${port}/api/stocks/AAPL`)).json();
    const voo = await (await fetch(`http://127.0.0.1:${port}/api/stocks/VOO`)).json();

    assert.equal(aapl.classification.assetType, "stock");
    assert.equal(aapl.classification.label, "개별종목");
    assert.equal(aapl.classification.source, "universe");
    assert.equal(voo.classification.assetType, "etf");
    assert.equal(voo.classification.label, "ETF");
    assert.equal(voo.classification.source, "universe");

    for (const payload of [aapl, voo]) {
      assert.equal(typeof payload.classification.reason, "string");
      assert.ok(payload.classification.reason.length > 0);
      if (payload.dataSource === "fallback") {
        assert.ok(payload.classification);
      }
    }
  } finally {
    server.close();
  }
});

test("backtest endpoint returns real-engine contract shape", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/backtest?market=us`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.market, "us");
    assert.ok(["ok", "partial", "not_ready", "no_samples"].includes(payload.status));
    assert.equal(payload.source, "local");
    assert.equal(typeof payload.method, "string");
    assert.equal(typeof payload.params, "object");
    assert.equal(typeof payload.coverage, "object");
    assert.equal(typeof payload.backtestReliability, "object");
    assert.equal(payload.backtestReliability.lookaheadBlocked, true);
    assert.equal(payload.backtestReliability.requiredSecurities, 10);
    assert.equal(payload.backtestReliability.requiredEvaluatedPoints, 500);
    assert.equal(typeof payload.backtestReliability.meetsSampleRule, "boolean");
    assert.equal(typeof payload.generatedAt, "string");
    assert.ok(Array.isArray(payload.results));
    assert.ok(Array.isArray(payload.errors));
    assert.ok(Array.isArray(payload.backtestHistory));

    if (payload.results.length) {
      const hybrid = payload.results.find((row) => row.name === "V4_HYBRID");
      assert.ok(hybrid);
      for (const key of ["name", "high", "low", "samples", "green_ratio", "green_return_10d", "edge", "win_rate", "mdd_20d"]) {
        assert.ok(Object.hasOwn(hybrid, key));
      }
    }
  } finally {
    server.close();
  }
});

test("backtest history endpoint exposes accumulated runs", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/api/backtest?market=us&limit=5`);
    const response = await fetch(`http://127.0.0.1:${port}/api/backtest/history`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.items));
    assert.equal(typeof payload.limit, "number");
  } finally {
    server.close();
  }
});

test("backtest endpoint supports long-term walk-forward parameters", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/backtest?market=us&limit=5&mode=long&years=3&step=10&horizon=10&mdd=20`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.params.mode, "long");
    assert.equal(payload.params.years, 3);
    assert.equal(payload.params.step, 10);
    assert.equal(payload.params.horizon, 10);
    assert.equal(payload.params.mddHorizon, 20);
    assert.match(payload.method, /lookahead|rows\.slice\(0, i \+ 1\)/);
    if (payload.results.length) {
      assert.ok(Object.hasOwn(payload.results[0], "forward_return"));
      assert.ok(Object.hasOwn(payload.results[0], "forward_mdd"));
    }
  } finally {
    server.close();
  }
});

test("search endpoint resolves real securities from aliases and ticker input", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const getJson = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();

  try {
    const google = await getJson("/api/stocks?market=us&query=google");
    const goog = await getJson("/api/stocks?market=us&query=goog");
    const googl = await getJson("/api/stocks?market=us&query=googl");
    const nvidia = await getJson("/api/stocks?market=us&query=nvidia");
    const costco = await getJson("/api/stocks?market=us&query=costco");
    const sndk = await getJson("/api/stocks?market=us&query=sndk");
    const team = await getJson("/api/stocks?market=us&query=team");
    const mu = await getJson("/api/stocks?market=us&query=mu");
    const voo = await getJson("/api/stocks?market=us&query=voo");
    const spy = await getJson("/api/stocks?market=us&query=spy");
    const samsung = await getJson(`/api/stocks?market=kr&query=${encodeURIComponent("삼성전자")}`);

    assert.equal(google.items[0].ticker, "GOOGL");
    assert.equal(google.items[0].classification.assetType, "stock");
    assert.equal(google.items[0].searchMatched, true);

    assert.equal(goog.items[0].ticker, "GOOG");
    assert.equal(goog.items[0].sector, "Communication Service (통신 서비스)");
    assert.equal(goog.items.length, 1);

    assert.equal(googl.items[0].ticker, "GOOGL");
    assert.equal(googl.items.length, 1);

    assert.equal(mu.items[0].ticker, "MU");
    assert.equal(mu.items[0].classification.assetType, "stock");

    assert.equal(nvidia.items[0].ticker, "NVDA");
    assert.equal(nvidia.items[0].classification.assetType, "stock");

    assert.equal(costco.items[0].ticker, "COST");
    assert.equal(costco.items[0].sector, "Consumer Staples/Defensive (필수 소비재)");
    assert.equal(costco.items[0].classification.assetType, "stock");
    assert.equal(costco.items[0].searchMatched, true);
    assert.equal(costco.items.length, 1);

    assert.equal(sndk.items[0].ticker, "SNDK");
    assert.equal(sndk.items[0].sector, "Information Technology (정보통신기술주)");
    assert.equal(sndk.items[0].classification.assetType, "stock");
    assert.equal(sndk.items.length, 1);

    assert.notEqual(team.items[0]?.sector, "Nasdaq 100");

    assert.equal(voo.items[0].ticker, "VOO");
    assert.equal(voo.items[0].classification.assetType, "etf");

    assert.equal(spy.items[0].ticker, "SPY");
    assert.equal(spy.items[0].classification.assetType, "etf");

    assert.equal(samsung.items[0].ticker, "005930");
    assert.equal(samsung.items[0].classification.assetType, "stock");
  } finally {
    server.close();
  }
});

test("cache status endpoint exposes price cache readiness", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const payload = await (await fetch(`http://127.0.0.1:${port}/api/cache/status`)).json();
    assert.equal(typeof payload.files, "number");
    assert.equal(typeof payload.priceFiles, "number");
    assert.equal(typeof payload.freshPriceFiles, "number");
    assert.equal(typeof payload.stalePriceFiles, "number");
    assert.equal(typeof payload.priceSources, "object");
    assert.equal(typeof payload.dataQuality, "object");
    assert.equal(typeof payload.dataQuality.score, "number");
    assert.ok(["높음", "보통", "낮음"].includes(payload.dataQuality.label));
    assert.equal(typeof payload.dataQuality.freshPricePct, "number");
    assert.equal(typeof payload.dataQuality.fundamentalPct, "number");
    assert.ok(Array.isArray(payload.dataQuality.warnings));
    assert.ok(Array.isArray(payload.dataQuality.blockers));
    assert.ok(Array.isArray(payload.watchedSymbols));
    assert.ok(payload.watchedSymbols.includes("GOOGL"));
    assert.ok(payload.watchedSymbols.includes("GOOG"));
    assert.ok(payload.watchedSymbols.includes("COST"));
    assert.ok(payload.watchedSymbols.includes("ADBE"));
    assert.ok(payload.watchedSymbols.includes("PANW"));
    assert.ok(payload.watchedSymbols.includes("SNDK"));
    assert.ok(payload.watchedSymbols.includes("SPY"));
    assert.ok(!payload.watchedSymbols.includes("TEAM"));
    assert.ok(Array.isArray(payload.missingWatchedSymbols));
  } finally {
    server.close();
  }
});

test("enrichment endpoint queues scanned tickers for background cache fill", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/enrichment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickers: ["AAPL", "AAPL", "bad ticker"], start: false })
    });
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.accepted));
    assert.equal(payload.accepted.length, 1);
    assert.equal(payload.accepted[0], "AAPL");
    assert.equal(typeof payload.queued, "number");

    const status = await (await fetch(`http://127.0.0.1:${port}/api/enrichment`)).json();
    assert.equal(typeof status.running, "boolean");
    assert.equal(typeof status.queued, "number");
    assert.ok(Array.isArray(status.items));
    assert.ok(status.items.some((item) => item.ticker === "AAPL"));
  } finally {
    server.close();
  }
});

test("enrichment endpoint prioritizes watchlist tickers", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/enrichment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickers: ["AAPL", "MSFT"], priorityTickers: ["MSFT"], start: false })
    });
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.priority, ["MSFT"]);
    assert.ok(payload.items.some((item) => item.ticker === "MSFT" && item.priority === true));
  } finally {
    server.close();
  }
});

test("scanned endpoint persists searched stocks on the server", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const save = await fetch(`http://127.0.0.1:${port}/api/scanned`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ ticker: "AAPL", company: "Apple", market: "us", score: 50 }] })
    });
    const saved = await save.json();
    assert.equal(saved.ok, true);
    assert.ok(saved.items.some((item) => item.ticker === "AAPL"));

    const payload = await (await fetch(`http://127.0.0.1:${port}/api/scanned`)).json();
    assert.equal(payload.ok, true);
    assert.ok(payload.items.some((item) => item.ticker === "AAPL"));
  } finally {
    server.close();
  }
});

test("watchlist cloud endpoint responds without crashing", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const token = "local-test-token-123456";
    const save = await fetch(`http://127.0.0.1:${port}/api/watchlist`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-portfolio-token": token },
      body: JSON.stringify({ clientId: "local-test-watchlist", tickers: ["aapl", "bad ticker", "NVDA"] })
    });
    const saved = await save.json();
    assert.equal(typeof saved.ok, "boolean");
    assert.equal(typeof saved.configured, "boolean");
    if (saved.configured) {
      assert.deepEqual(saved.tickers, ["AAPL", "NVDA"]);
      const payload = await (await fetch(`http://127.0.0.1:${port}/api/watchlist?clientId=local-test-watchlist`, {
        headers: { "x-portfolio-token": token }
      })).json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.tickers, ["AAPL", "NVDA"]);
    } else {
      assert.match(saved.error, /관심 종목|Supabase/);
    }
  } finally {
    server.close();
  }
});

test("watchlist audit reports reliability and queues weak tickers", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const payload = await (await fetch(`http://127.0.0.1:${port}/api/watchlist/audit?tickers=AAPL`)).json();
    assert.equal(payload.ok, true);
    assert.ok(["높음", "보통", "낮음", "준비중"].includes(payload.label));
    assert.equal(typeof payload.total, "number");
    assert.ok(Array.isArray(payload.items));
    assert.ok(Array.isArray(payload.needsEnrichment));
    if (payload.items.length) {
      assert.ok(payload.items[0].trust);
      assert.ok(payload.items[0].sourceStatus);
    }
  } finally {
    server.close();
  }
});

test("portfolio cloud endpoint responds without crashing", async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const payload = await (await fetch(`http://127.0.0.1:${port}/api/portfolio?clientId=local-test-portfolio`)).json();
    assert.equal(typeof payload.ok, "boolean");
    assert.equal(typeof payload.configured, "boolean");
    if (payload.configured) {
      assert.ok("portfolio" in payload);
    } else {
      assert.match(payload.error, /Supabase/);
    }
  } finally {
    server.close();
  }
});
