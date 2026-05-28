import { createServer } from "node:http";
import { readFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_FILE = fileURLToPath(import.meta.url);
const ROOT = dirname(SERVER_FILE);
const PORT = Number(process.env.PORT || 5050);
const CACHE_DIR = join(ROOT, "data", "cache", "node");
const SCANNED_STOCKS_FILE = join(CACHE_DIR, "scanned_stocks.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_CACHE_MS = 6 * 60 * 60 * 1000;
const MIN_US_HISTORY_ROWS = 40;
const FMP_BUNDLE_SCHEMA_VERSION = 2;
const BACKTEST_HISTORY_LIMIT = 30;
const ENRICHMENT_QUEUE_LIMIT = 40;
const ENRICHMENT_BATCH_LIMIT = 12;
const ENV = loadEnv();
const ALPHA_VANTAGE_API_KEY = ENV.ALPHA_VANTAGE_API_KEY || "";
const FMP_API_KEYS = [
  ENV.FMP_API_KEY,
  ENV.FMP_API_KEY_BACKUP,
  ...(ENV.FMP_API_KEYS || "").split(",")
].map((key) => String(key || "").trim()).filter(Boolean);
const DART_API_KEY = ENV.DART_API_KEY || "";
const SEC_USER_AGENT = ENV.SEC_USER_AGENT || "StockLens local scanner contact@example.com";
const SUPABASE_URL = (ENV.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_PORTFOLIO_TABLE = ENV.SUPABASE_PORTFOLIO_TABLE || "stocklens_portfolios";
const SUPABASE_SNAPSHOT_TABLE = ENV.SUPABASE_SNAPSHOT_TABLE || "stocklens_analysis_snapshots";
const SUPABASE_SCANNED_TABLE = ENV.SUPABASE_SCANNED_TABLE || "stocklens_scanned_stocks";
const SUPABASE_WATCHLIST_TABLE = ENV.SUPABASE_WATCHLIST_TABLE || "stocklens_watchlists";
const CRON_SECRET = ENV.CRON_SECRET || "";
const DEFAULT_ACCOUNT_SIZE = Number(ENV.TRADING_ACCOUNT_SIZE || 10000);
const DEFAULT_RISK_PCT = Number(ENV.TRADING_RISK_PCT || 1);
const enrichmentQueue = [];
const enrichmentStatus = new Map();
let enrichmentRunning = false;
const SEC_CIK = {
  AAPL: "0000320193",
  GOOGL: "0001652044",
  MSFT: "0000789019",
  NVDA: "0001045810",
  AMZN: "0001018724",
  META: "0001326801",
  TSLA: "0001318605",
  MU: "0000723125",
  TXN: "0000097476",
  NXPI: "0001413447",
  WDC: "0000106040",
  QQQ: "0001067839"
};
const DART_CORP = {
  "005930": "00126380",
  "000660": "00164779"
};
const KNOWN_US_ETFS = new Set([
  "VOO", "QQQ", "SPY", "IVV", "VTI", "DIA", "IWM", "MDY", "IJH", "IJR",
  "VUG", "VTV", "IWF", "IWD", "SCHD", "VYM", "DGRO", "NOBL", "USMV", "SPLV",
  "RSP", "QUAL", "MTUM", "XLK", "XLF", "XLV", "XLY", "XLP", "XLI", "XLE",
  "XLU", "XLB", "XLRE", "XLC", "VXUS", "VEA", "VWO", "EFA", "EEM", "IEFA",
  "BND", "AGG", "TLT", "IEF", "SHY", "LQD", "HYG", "VCIT", "TIP", "GLD",
  "IAU", "SLV", "SMH", "ARKK"
]);
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
  ["일론", "TSLA"],
  ["MICROSOFT", "MSFT"],
  ["마이크로소프트", "MSFT"],
  ["AMAZON", "AMZN"],
  ["아마존", "AMZN"],
  ["META", "META"],
  ["FACEBOOK", "META"],
  ["페이스북", "META"],
  ["BROADCOM", "AVGO"],
  ["브로드컴", "AVGO"],
  ["ADVANCED MICRO DEVICES", "AMD"]
]);
const KR_STOCK_ALIASES = new Map([
  ["삼성전자", "005930"],
  ["SAMSUNG", "005930"],
  ["하이닉스", "000660"],
  ["SK하이닉스", "000660"],
  ["SK HYNIX", "000660"]
]);

function classificationLabel(assetType) {
  return assetType === "etf" ? "ETF" : "개별종목";
}

function classificationFor(assetType, source, confidence, reason) {
  const normalized = assetType === "etf" ? "etf" : "stock";
  return {
    assetType: normalized,
    label: classificationLabel(normalized),
    confidence,
    source,
    reason
  };
}

function loadEnv() {
  const env = { ...globalThis.process?.env };
  try {
    const text = readFileSync(join(ROOT, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#") || !clean.includes("=")) continue;
      const [key, ...value] = clean.split("=");
      env[key.trim()] = value.join("=").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Optional local secrets file.
  }
  return env;
}

function sourceStatus(source, status, extra = {}) {
  return { source, status, updatedAt: new Date().toISOString(), ...extra };
}

function trustSummary(sourceStatusMap = {}, evidence = {}) {
  const statuses = Object.values(sourceStatusMap).map((item) => item?.status).filter(Boolean);
  const fallbackCount = statuses.filter((status) => ["fallback", "missing_key", "missing"].includes(status)).length;
  const weakCount = statuses.filter((status) => ["partial", "unavailable"].includes(status)).length;
  const okCount = statuses.filter((status) => status === "ok").length;
  const issueCount = Number(evidence.issueCount || 0);
  const label = issueCount >= 3 || fallbackCount > 2
    ? "낮음"
    : issueCount || weakCount > 1 || fallbackCount
      ? "보통"
      : okCount > 0
        ? "높음"
        : "낮음";
  return {
    label,
    okCount,
    fallbackCount,
    weakCount,
    issueCount,
    note: issueCount
      ? `교차검증/이상치 경고 ${issueCount}건을 확인하세요.`
      : fallbackCount
      ? "일부 항목은 대체값 또는 API 미연결 상태입니다."
      : weakCount
        ? "일부 보조 데이터는 부분 연결 상태입니다."
      : "주요 데이터가 정상 연결되었습니다."
  };
}

function compareNumber(label, leftSource, leftValue, rightSource, rightValue, tolerancePct = 8) {
  const left = Number(leftValue);
  const right = Number(rightValue);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const base = Math.max(Math.abs(left), Math.abs(right), 1);
  const gapPct = Math.abs(left - right) / base * 100;
  const status = gapPct <= tolerancePct ? "ok" : "warn";
  return {
    label,
    status,
    gapPct: Number(gapPct.toFixed(2)),
    summary: status === "ok"
      ? `${leftSource}와 ${rightSource} 값 차이가 ${gapPct.toFixed(1)}%로 허용 범위입니다.`
      : `${leftSource}와 ${rightSource} 값 차이가 ${gapPct.toFixed(1)}%입니다. 원자료 확인이 필요합니다.`,
    values: [
      { source: leftSource, value: Number(left.toFixed(4)) },
      { source: rightSource, value: Number(right.toFixed(4)) }
    ]
  };
}

function latestClose(rows) {
  const row = [...(rows || [])].reverse().find((item) => Number.isFinite(Number(item?.close)));
  return row ? Number(row.close) : null;
}

function fmpNumericBundle(bundle) {
  const quote = bundle?.quote || {};
  const ratios = bundle?.ratios || {};
  return {
    price: numberField(quote.price),
    pe: numberField(quote.pe) ?? numberField(ratios.priceToEarningsRatioTTM),
    pb: numberField(ratios.priceToBookRatioTTM),
    roe: numberField(ratios.returnOnEquityTTM),
    eps: numberField(quote.eps) ?? numberField(ratios.netIncomePerShareTTM),
    target: fmpTargetPrice(bundle)
  };
}

function alphaNumericBundle(overview) {
  return {
    pe: numberField(overview?.PERatio),
    pb: numberField(overview?.PriceToBookRatio),
    roe: numberField(overview?.ReturnOnEquityTTM),
    eps: numberField(overview?.EPS),
    target: numberField(overview?.AnalystTargetPrice)
  };
}

function buildDataCrossChecks({ meta, rows, scored, fmp, overview }) {
  const checks = [];
  const fmpValues = fmpNumericBundle(fmp);
  const alphaValues = alphaNumericBundle(overview);
  const close = latestClose(rows);
  const priceCheck = compareNumber("현재가", scored.dataSource || "선택 가격", scored.price, "가격봉", close, 5);
  if (priceCheck) checks.push(priceCheck);
  if (Number.isFinite(fmpValues.price)) {
    const fmpPriceCheck = compareNumber("현재가", "FMP", fmpValues.price, scored.dataSource || "선택 가격", scored.price, 5);
    if (fmpPriceCheck) checks.push(fmpPriceCheck);
  }
  for (const [key, label, tolerance] of [
    ["pe", "PER", 15],
    ["pb", "PBR", 15],
    ["roe", "ROE", 20],
    ["eps", "EPS", 15],
    ["target", "목표가", 20]
  ]) {
    const check = compareNumber(label, "FMP", fmpValues[key], "Alpha Vantage", alphaValues[key], tolerance);
    if (check) checks.push(check);
  }
  return {
    assetType: meta.asset_type || "stock",
    checks,
    okCount: checks.filter((item) => item.status === "ok").length,
    warnCount: checks.filter((item) => item.status === "warn").length
  };
}

function buildAnomalyWarnings({ meta, scored, fmp, overview, rows }) {
  const warnings = [];
  const fmpValues = fmpNumericBundle(fmp);
  const alphaValues = alphaNumericBundle(overview);
  const price = Number(scored.price);
  const close = latestClose(rows);
  const finance = {
    pe: fmpValues.pe ?? alphaValues.pe,
    pb: fmpValues.pb ?? alphaValues.pb,
    roe: fmpValues.roe ?? alphaValues.roe,
    eps: fmpValues.eps ?? alphaValues.eps,
    target: fmpValues.target ?? alphaValues.target
  };

  if (!Number.isFinite(price) || price <= 0) warnings.push({ level: "critical", label: "가격 오류", summary: "현재가가 없거나 0 이하입니다. 점수 계산을 신뢰하기 어렵습니다." });
  if (Number.isFinite(close) && Number.isFinite(price) && Math.abs(price - close) / Math.max(Math.abs(price), Math.abs(close), 1) > .08) {
    warnings.push({ level: "warn", label: "가격 불일치", summary: "선택 현재가와 최근 가격봉 종가 차이가 8%를 넘습니다. 장중/캐시 시점을 확인하세요." });
  }
  if (meta.asset_type === "etf") {
    warnings.push({ level: "info", label: "ETF 처리", summary: "ETF는 EPS, ROE, PER 같은 개별기업 재무지표를 점수 핵심값으로 사용하지 않습니다." });
  } else {
    if (Number.isFinite(finance.pe) && (finance.pe < 0 || finance.pe > 200)) warnings.push({ level: "warn", label: "PER 이상치", summary: `PER ${finance.pe.toFixed(1)}은 일반 범위를 벗어납니다. 일회성 이익/손실 또는 데이터 오류를 확인하세요.` });
    if (Number.isFinite(finance.pb) && finance.pb > 80) warnings.push({ level: "warn", label: "PBR 이상치", summary: `PBR ${finance.pb.toFixed(1)}은 매우 높습니다. 자본잠식/데이터 단위를 확인하세요.` });
    if (Number.isFinite(finance.roe) && Math.abs(finance.roe) > 1.5) warnings.push({ level: "warn", label: "ROE 이상치", summary: `ROE ${(finance.roe * 100).toFixed(1)}%는 매우 큽니다. 최근 순이익/자본 변동을 확인하세요.` });
    if (Number.isFinite(finance.eps) && finance.eps <= 0 && Number.isFinite(finance.pe) && finance.pe > 0) warnings.push({ level: "warn", label: "EPS/PER 충돌", summary: "EPS가 0 이하인데 PER이 양수입니다. 공급 API 기준이 다른지 확인하세요." });
  }
  if (Number.isFinite(finance.target) && Number.isFinite(price) && Math.abs((finance.target / price - 1) * 100) > 200) {
    warnings.push({ level: "warn", label: "목표가 이상치", summary: "목표가와 현재가 괴리가 200%를 넘습니다. 통화/분할조정 오류 가능성을 확인하세요." });
  }
  const rsiValue = Number(scored.finance?.rsi);
  if (Number.isFinite(rsiValue) && (rsiValue < 0 || rsiValue > 100)) warnings.push({ level: "critical", label: "RSI 오류", summary: "RSI가 0~100 범위를 벗어났습니다." });
  return warnings;
}

function percent(part, total) {
  if (!total) return 0;
  return Number((part / total * 100).toFixed(1));
}

function dataQualitySummary({ priceFiles, fmpCompleteSymbols, fmpPartialSymbols, overviewSymbols, earningsSymbols, alphaQuota, usStockSymbols }) {
  const watchedTotal = UNIVERSE.length;
  const freshPrice = priceFiles.filter((item) => !item.stale).length;
  const stalePrice = priceFiles.filter((item) => item.stale).length;
  const freshPricePct = percent(freshPrice, watchedTotal);
  const fundamentalComplete = usStockSymbols.filter((symbol) => (
    fmpCompleteSymbols.includes(symbol) || (overviewSymbols.includes(symbol) && earningsSymbols.includes(symbol))
  )).length;
  const fundamentalPartial = usStockSymbols.filter((symbol) => (
    !fmpCompleteSymbols.includes(symbol) && (fmpPartialSymbols.includes(symbol) || overviewSymbols.includes(symbol) || earningsSymbols.includes(symbol))
  )).length;
  const fundamentalPct = percent(fundamentalComplete, usStockSymbols.length);
  const keyScore = [FMP_API_KEYS.length > 0, Boolean(ALPHA_VANTAGE_API_KEY), Boolean(DART_API_KEY), Boolean(SEC_USER_AGENT)]
    .filter(Boolean).length / 4;
  const freshnessScore = priceFiles.length ? Math.max(0, 1 - stalePrice / priceFiles.length) : 0;
  const score = Math.round((freshPricePct * 0.45) + (fundamentalPct * 0.35) + (keyScore * 15) + (freshnessScore * 5));
  const warnings = [];
  const blockers = [];

  if (freshPricePct < 80) blockers.push(`가격 캐시가 ${freshPricePct}%만 준비됨`);
  if (fundamentalPct < 50) warnings.push(`미국 개별주 재무 데이터 완성률 ${fundamentalPct}%`);
  if (stalePrice) warnings.push(`오래된 가격 캐시 ${stalePrice}개`);
  if (!FMP_API_KEYS.length) blockers.push("FMP 키 없음");
  if (alphaQuota?.blocked) warnings.push("Alpha Vantage 일일 한도 도달");

  return {
    score,
    label: score >= 80 ? "높음" : score >= 55 ? "보통" : "낮음",
    freshPricePct,
    fundamentalPct,
    stalePrice,
    fundamentalComplete,
    fundamentalPartial,
    keyStatus: {
      fmp: FMP_API_KEYS.length,
      alphaVantage: Boolean(ALPHA_VANTAGE_API_KEY),
      dart: Boolean(DART_API_KEY),
      secUserAgent: Boolean(SEC_USER_AGENT)
    },
    warnings,
    blockers
  };
}

const BASE_UNIVERSE = [
  ["HWM", "HWM", "Howmet Aerospace", "us", "Aerospace & Defense", "Aerospace parts", "stock"],
  ["TXN", "TXN", "Texas Instruments", "us", "Semiconductors", "Analog semiconductors", "stock"],
  ["NXPI", "NXPI", "NXP Semiconductors", "us", "Semiconductors", "Automotive semiconductors", "stock"],
  ["AAPL", "AAPL", "Apple", "us", "Consumer Electronics", "Devices and services", "stock"],
  ["GOOGL", "GOOGL", "Alphabet", "us", "Communication Services", "Search and cloud advertising", "stock"],
  ["MSFT", "MSFT", "Microsoft", "us", "Software", "Cloud and productivity software", "stock"],
  ["NVDA", "NVDA", "NVIDIA", "us", "Semiconductors", "AI accelerators and GPUs", "stock"],
  ["AMZN", "AMZN", "Amazon", "us", "Consumer Internet", "E-commerce and cloud", "stock"],
  ["META", "META", "Meta Platforms", "us", "Communication Services", "Social platforms and AI", "stock"],
  ["TSLA", "TSLA", "Tesla", "us", "Automobiles", "Electric vehicles and energy", "stock"],
  ["MU", "MU", "Micron Technology", "us", "Semiconductors", "Memory semiconductors", "stock"],
  ["AVGO", "AVGO", "Broadcom", "us", "Semiconductors", "Networking and custom silicon", "stock"],
  ["AMD", "AMD", "Advanced Micro Devices", "us", "Semiconductors", "CPUs and AI accelerators", "stock"],
  ["WDC", "WDC", "Western Digital", "us", "Computer Hardware", "Storage and memory", "stock"],
  ["VOO", "VOO", "Vanguard S&P 500 ETF", "etf", "US ETF", "S&P 500 tracker", "etf"],
  ["SPY", "SPY", "SPDR S&P 500 ETF Trust", "etf", "US ETF", "S&P 500 tracker", "etf"],
  ["QQQ", "QQQ", "Invesco QQQ Trust", "etf", "US ETF", "Nasdaq 100 tracker", "etf"],
  ["005930", "005930.KS", "Samsung Electronics", "kr", "Semiconductors", "Memory and foundry", "stock"],
  ["000660", "000660.KS", "SK hynix", "kr", "Semiconductors", "HBM and memory", "stock"],
  ["KODEX200", "069500.KS", "KODEX 200", "etf", "Korea ETF", "KOSPI 200 tracker", "etf"]
];

const NASDAQ100_COMPANIES = [
  ["NVDA", "NVIDIA Corporation"],
  ["GOOGL", "Alphabet Inc."],
  ["GOOG", "Alphabet Inc."],
  ["AAPL", "Apple Inc."],
  ["MSFT", "Microsoft Corporation"],
  ["AMZN", "Amazon.com, Inc."],
  ["AVGO", "Broadcom Inc."],
  ["TSLA", "Tesla, Inc."],
  ["META", "Meta Platforms, Inc."],
  ["WMT", "Walmart Inc."],
  ["MU", "Micron Technology, Inc."],
  ["AMD", "Advanced Micro Devices, Inc."],
  ["INTC", "Intel Corporation"],
  ["ASML", "ASML Holding N.V."],
  ["COST", "Costco Wholesale Corporation"],
  ["CSCO", "Cisco Systems, Inc."],
  ["NFLX", "Netflix, Inc."],
  ["LRCX", "Lam Research Corporation"],
  ["AMAT", "Applied Materials, Inc."],
  ["PLTR", "Palantir Technologies Inc."],
  ["TXN", "Texas Instruments Incorporated"],
  ["ARM", "Arm Holdings plc"],
  ["LIN", "Linde plc"],
  ["KLAC", "KLA Corporation"],
  ["TMUS", "T-Mobile US, Inc."],
  ["QCOM", "QUALCOMM Incorporated"],
  ["PEP", "PepsiCo, Inc."],
  ["PANW", "Palo Alto Networks, Inc."],
  ["ADI", "Analog Devices, Inc."],
  ["AMGN", "Amgen Inc."],
  ["STX", "Seagate Technology Holdings plc"],
  ["MRVL", "Marvell Technology, Inc."],
  ["GILD", "Gilead Sciences, Inc."],
  ["WDC", "Western Digital Corporation"],
  ["CRWD", "CrowdStrike Holdings, Inc."],
  ["APP", "AppLovin Corporation"],
  ["ISRG", "Intuitive Surgical, Inc."],
  ["PDD", "PDD Holdings Inc."],
  ["HON", "Honeywell International Inc."],
  ["SHOP", "Shopify Inc."],
  ["SBUX", "Starbucks Corporation"],
  ["BKNG", "Booking Holdings Inc."],
  ["VRTX", "Vertex Pharmaceuticals Incorporated"],
  ["INTU", "Intuit Inc."],
  ["ADBE", "Adobe Inc."],
  ["CEG", "Constellation Energy Corporation"],
  ["MAR", "Marriott International, Inc."],
  ["FTNT", "Fortinet, Inc."],
  ["CDNS", "Cadence Design Systems, Inc."],
  ["SNPS", "Synopsys, Inc."],
  ["CMCSA", "Comcast Corporation"],
  ["ADP", "Automatic Data Processing, Inc."],
  ["CSX", "CSX Corporation"],
  ["MNST", "Monster Beverage Corporation"],
  ["MELI", "MercadoLibre, Inc."],
  ["MDLZ", "Mondelez International, Inc."],
  ["DDOG", "Datadog, Inc."],
  ["ABNB", "Airbnb, Inc."],
  ["ORLY", "O'Reilly Automotive, Inc."],
  ["NXPI", "NXP Semiconductors N.V."],
  ["MPWR", "Monolithic Power Systems, Inc."],
  ["ROST", "Ross Stores, Inc."],
  ["AEP", "American Electric Power Company, Inc."],
  ["CTAS", "Cintas Corporation"],
  ["WBD", "Warner Bros. Discovery, Inc."],
  ["BKR", "Baker Hughes Company"],
  ["DASH", "DoorDash, Inc."],
  ["REGN", "Regeneron Pharmaceuticals, Inc."],
  ["FANG", "Diamondback Energy, Inc."],
  ["MSTR", "Strategy Inc"],
  ["PCAR", "PACCAR Inc"],
  ["EA", "Electronic Arts Inc."],
  ["XEL", "Xcel Energy Inc."],
  ["FAST", "Fastenal Company"],
  ["MCHP", "Microchip Technology Incorporated"],
  ["ADSK", "Autodesk, Inc."],
  ["FER", "Ferrovial N.V."],
  ["EXC", "Exelon Corporation"],
  ["TTWO", "Take-Two Interactive Software, Inc."],
  ["ODFL", "Old Dominion Freight Line, Inc."],
  ["IDXX", "IDEXX Laboratories, Inc."],
  ["CCEP", "Coca-Cola Europacific Partners PLC"],
  ["ALNY", "Alnylam Pharmaceuticals, Inc."],
  ["KDP", "Keurig Dr Pepper Inc."],
  ["TRI", "Thomson Reuters Corporation"],
  ["PYPL", "PayPal Holdings, Inc."],
  ["PAYX", "Paychex, Inc."],
  ["ROP", "Roper Technologies, Inc."],
  ["AXON", "Axon Enterprise, Inc."],
  ["CPRT", "Copart, Inc."],
  ["WDAY", "Workday, Inc."],
  ["GEHC", "GE HealthCare Technologies Inc."],
  ["ZS", "Zscaler, Inc."],
  ["KHC", "The Kraft Heinz Company"],
  ["DXCM", "DexCom, Inc."],
  ["CTSH", "Cognizant Technology Solutions Corporation"],
  ["INSM", "Insmed Incorporated"],
  ["VRSK", "Verisk Analytics, Inc."],
  ["SNDK", "Sandisk Corporation"],
  ["CHTR", "Charter Communications, Inc."],
  ["CSGP", "CoStar Group, Inc."]
].map(([ticker, company]) => [ticker, ticker, company, "us", "Nasdaq 100", "Nasdaq-100 constituent", "stock"]);

const US_REPRESENTATIVE_ETFS = [
  ["IVV", "iShares Core S&P 500 ETF", "S&P 500 tracker"],
  ["VTI", "Vanguard Total Stock Market ETF", "Total US stock market"],
  ["DIA", "SPDR Dow Jones Industrial Average ETF Trust", "Dow Jones tracker"],
  ["IWM", "iShares Russell 2000 ETF", "US small-cap stocks"],
  ["MDY", "SPDR S&P MidCap 400 ETF Trust", "US mid-cap stocks"],
  ["IJH", "iShares Core S&P Mid-Cap ETF", "US mid-cap stocks"],
  ["IJR", "iShares Core S&P Small-Cap ETF", "US small-cap stocks"],
  ["VUG", "Vanguard Growth ETF", "US growth stocks"],
  ["VTV", "Vanguard Value ETF", "US value stocks"],
  ["IWF", "iShares Russell 1000 Growth ETF", "Large-cap growth stocks"],
  ["IWD", "iShares Russell 1000 Value ETF", "Large-cap value stocks"],
  ["SCHD", "Schwab US Dividend Equity ETF", "US dividend stocks"],
  ["VYM", "Vanguard High Dividend Yield ETF", "High dividend stocks"],
  ["DGRO", "iShares Core Dividend Growth ETF", "Dividend growth stocks"],
  ["NOBL", "ProShares S&P 500 Dividend Aristocrats ETF", "Dividend aristocrats"],
  ["USMV", "iShares MSCI USA Min Vol Factor ETF", "Minimum volatility factor"],
  ["SPLV", "Invesco S&P 500 Low Volatility ETF", "Low volatility factor"],
  ["RSP", "Invesco S&P 500 Equal Weight ETF", "Equal-weight S&P 500"],
  ["QUAL", "iShares MSCI USA Quality Factor ETF", "Quality factor"],
  ["MTUM", "iShares MSCI USA Momentum Factor ETF", "Momentum factor"],
  ["XLK", "Technology Select Sector SPDR Fund", "Technology sector"],
  ["XLF", "Financial Select Sector SPDR Fund", "Financial sector"],
  ["XLV", "Health Care Select Sector SPDR Fund", "Health care sector"],
  ["XLY", "Consumer Discretionary Select Sector SPDR Fund", "Consumer discretionary sector"],
  ["XLP", "Consumer Staples Select Sector SPDR Fund", "Consumer staples sector"],
  ["XLI", "Industrial Select Sector SPDR Fund", "Industrial sector"],
  ["XLE", "Energy Select Sector SPDR Fund", "Energy sector"],
  ["XLU", "Utilities Select Sector SPDR Fund", "Utilities sector"],
  ["XLB", "Materials Select Sector SPDR Fund", "Materials sector"],
  ["XLRE", "Real Estate Select Sector SPDR Fund", "Real estate sector"],
  ["XLC", "Communication Services Select Sector SPDR Fund", "Communication services sector"],
  ["VXUS", "Vanguard Total International Stock ETF", "Global ex-US stocks"],
  ["VEA", "Vanguard FTSE Developed Markets ETF", "Developed markets"],
  ["VWO", "Vanguard FTSE Emerging Markets ETF", "Emerging markets"],
  ["EFA", "iShares MSCI EAFE ETF", "Developed markets"],
  ["EEM", "iShares MSCI Emerging Markets ETF", "Emerging markets"],
  ["IEFA", "iShares Core MSCI EAFE ETF", "Developed markets core"],
  ["BND", "Vanguard Total Bond Market ETF", "US aggregate bonds"],
  ["AGG", "iShares Core US Aggregate Bond ETF", "US aggregate bonds"],
  ["TLT", "iShares 20+ Year Treasury Bond ETF", "Long-term US Treasuries"],
  ["IEF", "iShares 7-10 Year Treasury Bond ETF", "Intermediate US Treasuries"],
  ["SHY", "iShares 1-3 Year Treasury Bond ETF", "Short-term US Treasuries"],
  ["LQD", "iShares iBoxx Investment Grade Corporate Bond ETF", "Investment-grade credit"],
  ["HYG", "iShares iBoxx High Yield Corporate Bond ETF", "High-yield credit"],
  ["VCIT", "Vanguard Intermediate-Term Corporate Bond ETF", "Intermediate corporate bonds"],
  ["TIP", "iShares TIPS Bond ETF", "Inflation-linked bonds"],
  ["GLD", "SPDR Gold Shares", "Gold commodity"],
  ["IAU", "iShares Gold Trust", "Gold commodity"],
  ["SLV", "iShares Silver Trust", "Silver commodity"],
  ["SMH", "VanEck Semiconductor ETF", "Semiconductor industry"]
].map(([ticker, company, industry]) => [ticker, ticker, company, "etf", "US ETF", industry, "etf"]);

const US_SECTORS = {
  technology: "Information Technology (정보통신기술주)",
  financial: "Financial Services (금융)",
  healthcare: "Health Care (헬스 케어)",
  discretionary: "Consumer Discretionary/Cyclical (자유/경기 소비재)",
  industrial: "Industrial (산업재)",
  communication: "Communication Service (통신 서비스)",
  staples: "Consumer Staples/Defensive (필수 소비재)",
  energy: "Energy (에너지)",
  realEstate: "Real Estate (부동산)",
  materials: "Materials (소재)",
  utility: "Utility (유틸리티)"
};

const US_SECTOR_TICKERS = {
  [US_SECTORS.technology]: new Set(["AAPL", "MSFT", "NVDA", "AVGO", "MU", "AMD", "INTC", "ASML", "CSCO", "LRCX", "AMAT", "TXN", "ARM", "KLAC", "QCOM", "ADI", "STX", "MRVL", "WDC", "CRWD", "FTNT", "CDNS", "SNPS", "DDOG", "NXPI", "MPWR", "ROP", "WDAY", "ZS", "CTSH", "SNDK"]),
  [US_SECTORS.financial]: new Set(["PYPL", "PAYX"]),
  [US_SECTORS.healthcare]: new Set(["AMGN", "GILD", "ISRG", "VRTX", "REGN", "IDXX", "ALNY", "GEHC", "DXCM", "INSM"]),
  [US_SECTORS.discretionary]: new Set(["AMZN", "TSLA", "SBUX", "BKNG", "MAR", "MELI", "ABNB", "ORLY", "ROST", "DASH", "CPRT"]),
  [US_SECTORS.industrial]: new Set(["HWM", "HON", "ADP", "CSX", "CTAS", "ODFL", "TRI", "AXON", "VRSK"]),
  [US_SECTORS.communication]: new Set(["GOOGL", "GOOG", "META", "NFLX", "TMUS", "APP", "CMCSA", "WBD", "CHTR", "CSGP"]),
  [US_SECTORS.staples]: new Set(["WMT", "COST", "PEP", "MNST", "MDLZ", "CCEP", "KDP", "KHC"]),
  [US_SECTORS.energy]: new Set(["BKR", "FANG"]),
  [US_SECTORS.utility]: new Set(["AEP", "CEG"])
};

function usSectorFor(ticker, sector, industry, assetType, market) {
  if (assetType === "etf" || market === "etf") return sector;
  if (market !== "us") return sector;
  const upper = String(ticker || "").toUpperCase();
  for (const [group, tickers] of Object.entries(US_SECTOR_TICKERS)) {
    if (tickers.has(upper)) return group;
  }
  const text = `${sector || ""} ${industry || ""}`.toLowerCase();
  if (/semiconductor|software|technology|hardware|cloud|data|cyber|ai|electronics|memory|storage|network/.test(text)) return US_SECTORS.technology;
  if (/financial|bank|payment|fintech|insurance|capital|exchange/.test(text)) return US_SECTORS.financial;
  if (/health|biotech|pharma|medical|care|drug|diagnostic|surgical/.test(text)) return US_SECTORS.healthcare;
  if (/auto|e-commerce|retail|travel|restaurant|hotel|cyclical|consumer internet|marketplace/.test(text)) return US_SECTORS.discretionary;
  if (/industrial|aerospace|defense|transport|rail|logistics|automation|equipment/.test(text)) return US_SECTORS.industrial;
  if (/communication|advertising|media|telecom|streaming|social|internet/.test(text)) return US_SECTORS.communication;
  if (/staples|defensive|food|beverage|grocery|household/.test(text)) return US_SECTORS.staples;
  if (/energy|oil|gas|pipeline/.test(text)) return US_SECTORS.energy;
  if (/real estate|reit|property/.test(text)) return US_SECTORS.realEstate;
  if (/material|chemical|metal|mining|packaging/.test(text)) return US_SECTORS.materials;
  if (/utility|utilities|electric|water/.test(text)) return US_SECTORS.utility;
  return US_SECTORS.technology;
}

function uniqueUniverseRows(rows) {
  const seen = new Set();
  return rows.filter(([ticker, yf_symbol]) => {
    const key = `${String(ticker).toUpperCase()}|${String(yf_symbol).toUpperCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const UNIVERSE = uniqueUniverseRows([...BASE_UNIVERSE, ...NASDAQ100_COMPANIES, ...US_REPRESENTATIVE_ETFS]).map(([ticker, yf_symbol, company, market, sector, industry, asset_type]) => ({
  ticker,
  yf_symbol,
  company,
  market,
  sector: usSectorFor(ticker, sector, industry, asset_type, market),
  industry,
  asset_type,
  classification: classificationFor(
    asset_type,
    "universe",
    "높음",
    `로컬 universe에 ${classificationLabel(asset_type)}로 등록되어 있습니다.`
  )
}));

function normalizeTickerInput(ticker) {
  return String(ticker || "").trim().toUpperCase();
}

function resolveSearchInput(raw) {
  const original = String(raw || "").trim();
  const upper = original.toUpperCase();
  if (US_STOCK_ALIASES.has(upper)) return { query: US_STOCK_ALIASES.get(upper), source: "alias", original };
  if (KR_STOCK_ALIASES.has(original)) return { query: KR_STOCK_ALIASES.get(original), source: "alias", original };
  if (KR_STOCK_ALIASES.has(upper)) return { query: KR_STOCK_ALIASES.get(upper), source: "alias", original };
  return { query: upper, source: "input", original };
}

function knownSecurity(ticker) {
  const upper = normalizeTickerInput(ticker);
  const compact = upper.replace(/[^A-Z0-9]/g, "");
  return UNIVERSE.find((item) => item.ticker.toUpperCase() === upper || item.yf_symbol.toUpperCase() === upper)
    || UNIVERSE.find((item) => {
      const company = String(item.company || "").toUpperCase();
      const compactCompany = company.replace(/[^A-Z0-9]/g, "");
      return company.includes(upper) || compactCompany.includes(compact);
    });
}

function isKrTicker(ticker) {
  return /^\d{6}(\.KS|\.KQ)?$/i.test(String(ticker || ""));
}

function assetTypeFromYahooQuote(quote = {}) {
  const symbol = String(quote.symbol || "").toUpperCase();
  if (KNOWN_US_ETFS.has(symbol)) return "etf";
  const type = String(quote.quoteType || quote.typeDisp || quote.exchDisp || "").toUpperCase();
  const name = String(quote.shortname || quote.longname || quote.name || "").toUpperCase();
  if (type.includes("ETF") || type.includes("FUND") || name.includes(" ETF") || name.includes(" TRUST")) return "etf";
  if (type.includes("EQUITY") || type.includes("STOCK")) return "stock";
  return "stock";
}

async function yahooQuoteMeta(symbol) {
  const upper = normalizeTickerInput(symbol);
  const cacheKey = `quote_meta_${upper.replace(/[^A-Z0-9.]/g, "_")}`;
  const cached = await supplementalRead(cacheKey, DAY_MS);
  if (cached) return cached;

  const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(upper)}&quotesCount=8&newsCount=0`;
  const search = await fetchJson(searchUrl);
  const quotes = Array.isArray(search?.quotes) ? search.quotes : [];
  const exact = quotes.find((quote) => String(quote.symbol || "").toUpperCase() === upper) || quotes[0] || {};
  const result = {
    symbol: String(exact.symbol || upper).toUpperCase(),
    name: exact.longname || exact.shortname || exact.name || upper,
    quoteType: exact.quoteType || exact.typeDisp || "",
    asset_type: assetTypeFromYahooQuote({ ...exact, symbol: exact.symbol || upper })
  };
  return supplementalWrite(cacheKey, result);
}

async function resolveSecurity(ticker) {
  const resolvedInput = resolveSearchInput(ticker);
  const upper = normalizeTickerInput(resolvedInput.query);
  const known = knownSecurity(upper);
  if (known) {
    return {
      ...known,
      searchMatched: resolvedInput.source === "alias",
      searchOriginal: resolvedInput.original,
      classification: classificationFor(
        known.asset_type,
        resolvedInput.source === "alias" ? "alias" : "universe",
        "높음",
        resolvedInput.source === "alias"
          ? `"${resolvedInput.original}" 검색어를 ${known.ticker} ${classificationLabel(known.asset_type)}로 매칭했습니다.`
          : `로컬 universe에 ${classificationLabel(known.asset_type)}로 등록되어 있습니다.`
      )
    };
  }
  if (!/^[A-Z0-9.]{1,16}$/.test(upper)) return null;

  if (isKrTicker(upper)) {
    const yf_symbol = upper.includes(".") ? upper : `${upper}.KS`;
    return {
      ticker: upper.replace(/\.(KS|KQ)$/i, ""),
      yf_symbol,
      company: `${upper.replace(/\.(KS|KQ)$/i, "")} 한국주식`,
      market: "kr",
      sector: "한국주식",
      industry: "사용자 입력 종목",
      asset_type: "stock",
      searchMatched: resolvedInput.source === "alias",
      searchOriginal: resolvedInput.original,
      classification: classificationFor("stock", "pattern", "높음", "한국 6자리 티커 패턴은 개별종목으로 분류합니다.")
    };
  }

  if (KNOWN_US_ETFS.has(upper)) {
    return {
      ticker: upper,
      yf_symbol: upper,
      company: `${upper} ETF`,
      market: "etf",
      sector: "US ETF",
      industry: "ETF",
      asset_type: "etf",
      searchMatched: resolvedInput.source === "alias",
      searchOriginal: resolvedInput.original,
      classification: classificationFor("etf", "pattern", "높음", "known ETF 티커 패턴과 일치합니다.")
    };
  }

  let meta;
  let classificationSource = "yahoo";
  let classificationConfidence = "보통";
  let classificationReason = "Yahoo quote metadata 기준으로 분류했습니다.";
  try {
    meta = await yahooQuoteMeta(upper);
  } catch {
    meta = {
      symbol: upper,
      name: upper,
      asset_type: KNOWN_US_ETFS.has(upper) ? "etf" : "stock"
    };
    classificationSource = "fallback";
    classificationConfidence = "낮음";
    classificationReason = "Yahoo 메타데이터를 가져오지 못해 안전한 기본값으로 분류했습니다.";
  }
  const asset_type = meta.asset_type === "etf" ? "etf" : "stock";
  return {
    ticker: upper,
    yf_symbol: meta.symbol || upper,
    company: meta.name || upper,
    market: asset_type === "etf" ? "etf" : "us",
    sector: usSectorFor(upper, asset_type === "etf" ? "US ETF" : "사용자 입력", asset_type === "etf" ? "ETF" : "개별 종목", asset_type, asset_type === "etf" ? "etf" : "us"),
    industry: asset_type === "etf" ? "ETF" : "개별 종목",
    asset_type,
    searchMatched: resolvedInput.source === "alias",
    searchOriginal: resolvedInput.original,
    classification: classificationFor(asset_type, classificationSource, classificationConfidence, classificationReason)
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(payload));
}

function cors(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end();
}

function readRequestJson(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function cleanStoredStock(stock) {
  if (!stock || typeof stock !== "object" || !stock.ticker) return null;
  const ticker = String(stock.ticker || "").trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,16}$/.test(ticker)) return null;
  return {
    ...stock,
    ticker,
    yf_symbol: stock.yf_symbol || stock.yfSymbol || ticker,
    savedAt: stock.savedAt || new Date().toISOString()
  };
}

async function readScannedStocks() {
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const result = await supabaseRest(`${SUPABASE_SCANNED_TABLE}?select=ticker,payload,updated_at&order=updated_at.desc&limit=80`);
    if (result.ok && Array.isArray(result.payload)) {
      return result.payload
        .map((row) => cleanStoredStock({ ...(row.payload || {}), ticker: row.ticker, savedAt: row.updated_at }))
        .filter(Boolean)
        .slice(0, 80);
    }
  }
  try {
    const raw = JSON.parse((await readFile(SCANNED_STOCKS_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return Array.isArray(raw?.items)
      ? raw.items.map(cleanStoredStock).filter(Boolean).slice(0, 80)
      : [];
  } catch {
    return [];
  }
}

async function writeScannedStocks(items) {
  const cleanItems = items.map(cleanStoredStock).filter(Boolean).slice(0, 80);
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && cleanItems.length) {
    const result = await supabaseRest(`${SUPABASE_SCANNED_TABLE}?on_conflict=ticker`, {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: cleanItems.map((item) => ({
        ticker: item.ticker,
        payload: item,
        updated_at: new Date().toISOString()
      }))
    });
    if (result.ok) return;
  }
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(SCANNED_STOCKS_FILE, JSON.stringify({
      savedAt: new Date().toISOString(),
      items: cleanItems
    }));
  } catch (error) {
    if (error?.code !== "EROFS" && error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
  }
}

async function deleteScannedStocks(ticker = "") {
  const cleanTicker = String(ticker || "").trim().toUpperCase();
  const hasTicker = /^[A-Z0-9.-]{1,16}$/.test(cleanTicker);
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const filter = hasTicker ? `ticker=eq.${encodeURIComponent(cleanTicker)}` : "ticker=neq.__never__";
    const result = await supabaseRest(`${SUPABASE_SCANNED_TABLE}?${filter}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" }
    });
    if (result.ok) return await readScannedStocks();
  }
  const items = await readScannedStocks();
  const remaining = hasTicker ? items.filter((item) => item.ticker !== cleanTicker) : [];
  await writeScannedStocks(remaining);
  return remaining;
}

function mergeServerStocks(current, incoming) {
  const merged = [...(current || [])];
  for (const item of incoming || []) {
    const clean = cleanStoredStock(item);
    if (!clean) continue;
    const index = merged.findIndex((stock) => String(stock.ticker).toUpperCase() === clean.ticker);
    if (index >= 0) merged[index] = { ...merged[index], ...clean };
    else merged.unshift(clean);
  }
  return merged;
}

async function rememberServerScannedStocks(items) {
  const incoming = (items || []).map(cleanStoredStock).filter(Boolean);
  if (!incoming.length) return [];
  const merged = mergeServerStocks(await readScannedStocks(), incoming).slice(0, 80);
  await writeScannedStocks(merged);
  return merged;
}

function validPortfolioClientId(clientId) {
  return /^[a-zA-Z0-9._:-]{8,120}$/.test(String(clientId || ""));
}

function portfolioTokenHash(clientId, token) {
  const cleanToken = String(token || "").trim();
  if (!/^[a-zA-Z0-9._:-]{16,160}$/.test(cleanToken)) return null;
  return createHash("sha256").update(`${clientId}:${cleanToken}`).digest("hex");
}

function portfolioTokenFromRequest(req, body = {}) {
  return req.headers["x-portfolio-token"] || body.portfolioToken || body.token || "";
}

function attachPortfolioAuth(clientId, payload, token) {
  const tokenHash = portfolioTokenHash(clientId, token);
  if (!tokenHash) return null;
  return {
    ...payload,
    cloudAuth: {
      version: 1,
      tokenHash,
      updatedAt: new Date().toISOString()
    }
  };
}

function stripPortfolioAuth(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload || null;
  const { cloudAuth, ...safePayload } = payload;
  return safePayload;
}

function portfolioAuthMatches(clientId, payload, token) {
  const savedHash = payload?.cloudAuth?.tokenHash;
  if (!savedHash) return true;
  return portfolioTokenHash(clientId, token) === savedHash;
}

function cleanWatchlistTickers(tickers, limit = 80) {
  return [...new Set((tickers || [])
    .map((ticker) => String(ticker || "").trim().toUpperCase())
    .filter((ticker) => /^[A-Z0-9.-]{1,16}$/.test(ticker)))]
    .slice(0, limit);
}

async function readCloudWatchlist(clientId, token) {
  if (!validPortfolioClientId(clientId)) return { ok: false, status: 400, error: "clientId가 올바르지 않습니다." };
  const result = await supabaseRest(`${SUPABASE_WATCHLIST_TABLE}?client_id=eq.${encodeURIComponent(clientId)}&select=client_id,payload,updated_at&limit=1`);
  if (!result.ok) return { ok: false, status: result.status, error: "관심 종목 저장소를 읽지 못했습니다.", configured: result.configured };
  const row = Array.isArray(result.payload) ? result.payload[0] : null;
  if (row?.payload && !portfolioAuthMatches(clientId, row.payload, token)) {
    return { ok: false, status: 403, error: "관심 종목 접근 토큰이 일치하지 않습니다." };
  }
  return {
    ok: true,
    configured: true,
    tickers: cleanWatchlistTickers(row?.payload?.tickers || []),
    updatedAt: row?.updated_at || null
  };
}

async function writeCloudWatchlist(clientId, tickers, token) {
  if (!validPortfolioClientId(clientId)) return { ok: false, status: 400, error: "clientId가 올바르지 않습니다." };
  const existing = await readCloudWatchlist(clientId, token);
  if (!existing.ok && existing.status === 403) return existing;
  const payload = attachPortfolioAuth(clientId, { tickers: cleanWatchlistTickers(tickers) }, token);
  if (!payload) return { ok: false, status: 401, error: "관심 종목 접근 토큰이 필요합니다." };
  const result = await supabaseRest(`${SUPABASE_WATCHLIST_TABLE}?on_conflict=client_id`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: [{
      client_id: clientId,
      payload,
      updated_at: new Date().toISOString()
    }]
  });
  if (!result.ok) return { ok: false, status: result.status, error: "관심 종목 저장에 실패했습니다.", configured: result.configured };
  return { ok: true, configured: true, tickers: payload.tickers, updatedAt: new Date().toISOString() };
}

function clamp(value, low = 0, high = 100) {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, Math.round(value)));
}

function clampFloat(value, low = 0, high = 100, digits = 1) {
  if (!Number.isFinite(value)) return low;
  const factor = 10 ** digits;
  return Math.max(low, Math.min(high, Math.round(value * factor) / factor));
}

export function normalizeSigned(raw, scale = 1.5) {
  return clampFloat(50 + raw * scale);
}

export function normalizePositive(raw, best) {
  if (!Number.isFinite(raw) || !Number.isFinite(best) || best === 0) return 0;
  return clampFloat((raw / best) * 100);
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : NaN;
}

function sma(values, period) {
  if (values.length < period) return NaN;
  return average(values.slice(-period));
}

function pctChange(values, period) {
  if (values.length <= period) return 0;
  const start = values[values.length - 1 - period];
  const end = values[values.length - 1];
  return start ? ((end / start) - 1) * 100 : 0;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function moneyFlowIndex(rows, period = 14) {
  if (rows.length <= period) return 50;
  let positive = 0;
  let negative = 0;
  const slice = rows.slice(-period - 1);
  for (let i = 1; i < slice.length; i += 1) {
    const prevTypical = (slice[i - 1].high + slice[i - 1].low + slice[i - 1].close) / 3;
    const typical = (slice[i].high + slice[i].low + slice[i].close) / 3;
    const flow = typical * slice[i].volume;
    if (typical >= prevTypical) positive += flow;
    else negative += flow;
  }
  if (negative === 0) return 100;
  return 100 - (100 / (1 + positive / negative));
}

function atr(rows, period = 14) {
  if (rows.length < period + 1) return rows.at(-1)?.close * 0.025 || 1;
  const trs = [];
  const slice = rows.slice(-period - 1);
  for (let i = 1; i < slice.length; i += 1) {
    const prevClose = slice[i - 1].close;
    const row = slice[i];
    trs.push(Math.max(row.high - row.low, Math.abs(row.high - prevClose), Math.abs(row.low - prevClose)));
  }
  return average(trs);
}

function vwap(rows) {
  const slice = rows.slice(-20);
  const amount = slice.reduce((sum, row) => sum + row.close * row.volume, 0);
  const volume = slice.reduce((sum, row) => sum + row.volume, 0);
  return volume ? amount / volume : slice.at(-1)?.close;
}

function standardDeviation(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return NaN;
  const avg = average(clean);
  return Math.sqrt(average(clean.map((value) => (value - avg) ** 2)));
}

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i += 1) output.push(values[i] * k + output[i - 1] * (1 - k));
  return output;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, index) => fast[index] - slow[index]);
  const signal = ema(line, 9);
  return { line: line.at(-1) || 0, signal: signal.at(-1) || 0 };
}

export function calculatePositionSizing({ accountSize = DEFAULT_ACCOUNT_SIZE, riskPct = DEFAULT_RISK_PCT, entry, stop, maxPositionPct = 10 }) {
  const cleanAccount = Number(accountSize);
  const cleanRiskPct = Number(riskPct);
  const cleanEntry = Number(entry);
  const cleanStop = Number(stop);
  const riskPerShare = cleanEntry - cleanStop;
  if (![cleanAccount, cleanRiskPct, cleanEntry, cleanStop, riskPerShare].every(Number.isFinite) || cleanAccount <= 0 || cleanRiskPct <= 0 || cleanEntry <= 0 || riskPerShare <= 0) {
    return {
      method: "fixed_fractional",
      accountSize: Number.isFinite(cleanAccount) ? cleanAccount : null,
      riskPct: Number.isFinite(cleanRiskPct) ? cleanRiskPct : null,
      shares: 0,
      riskPerShare: null,
      dollarRisk: null,
      positionValue: null,
      positionPct: null,
      bindingConstraint: "invalid_input"
    };
  }
  const riskBudget = cleanAccount * (cleanRiskPct / 100);
  const maxPositionValue = cleanAccount * (Number(maxPositionPct) / 100);
  const riskShares = Math.floor(riskBudget / riskPerShare);
  const positionShares = Math.floor(maxPositionValue / cleanEntry);
  const shares = Math.max(0, Math.min(riskShares, positionShares));
  const positionValue = shares * cleanEntry;
  const dollarRisk = shares * riskPerShare;
  return {
    method: "fixed_fractional",
    accountSize: Number(cleanAccount.toFixed(2)),
    riskPct: Number(cleanRiskPct.toFixed(2)),
    maxPositionPct: Number(Number(maxPositionPct).toFixed(2)),
    shares,
    riskPerShare: Number(riskPerShare.toFixed(2)),
    riskBudget: Number(riskBudget.toFixed(2)),
    dollarRisk: Number(dollarRisk.toFixed(2)),
    positionValue: Number(positionValue.toFixed(2)),
    positionPct: Number((positionValue / cleanAccount * 100).toFixed(2)),
    bindingConstraint: riskShares <= positionShares ? "risk_budget" : "max_position"
  };
}

export function portfolioHeatStatus(heat) {
  const cleanHeat = Number(heat);
  if (!Number.isFinite(cleanHeat)) return "neutral";
  if (cleanHeat >= 8) return "risk";
  if (cleanHeat >= 6) return "warn";
  return "good";
}

export function calculatePortfolioPosition({ ticker, shares, avgCost, accountSize, quote }) {
  const cleanShares = Number(shares);
  const cleanAvgCost = Number(avgCost);
  const cleanAccount = Number(accountSize);
  const price = Number(quote?.price);
  const stop = Number(quote?.tradePlan?.stop);
  const valid = [cleanShares, cleanAvgCost, price].every(Number.isFinite) && cleanShares > 0 && cleanAvgCost >= 0 && price >= 0;

  if (!valid) {
    return {
      ticker,
      shares: Number.isFinite(cleanShares) ? cleanShares : null,
      avgCost: Number.isFinite(cleanAvgCost) ? cleanAvgCost : null,
      price: Number.isFinite(price) ? price : null,
      value: null,
      cost: null,
      pnl: null,
      stop: Number.isFinite(stop) ? stop : null,
      openRisk: null,
      heat: null,
      heatStatus: "neutral"
    };
  }

  const value = price * cleanShares;
  const cost = cleanAvgCost * cleanShares;
  const pnl = value - cost;
  const openRisk = Number.isFinite(stop) && price > stop ? (price - stop) * cleanShares : 0;
  const heat = cleanAccount > 0 ? openRisk / cleanAccount * 100 : 0;

  return {
    ticker,
    shares: cleanShares,
    avgCost: cleanAvgCost,
    price,
    value: Number(value.toFixed(2)),
    cost: Number(cost.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    stop: Number.isFinite(stop) ? stop : null,
    openRisk: Number(openRisk.toFixed(2)),
    heat: Number(heat.toFixed(2)),
    heatStatus: portfolioHeatStatus(heat)
  };
}

function calculateTradeSetup({ rows, closes, close, atrValue, volumeRatio, highDistance, entry }) {
  const recentLows = rows.slice(-20).map((row) => row.low).filter(Number.isFinite);
  const recentHighs = rows.slice(-21, -1).map((row) => row.high).filter(Number.isFinite);
  const pivot = recentHighs.length ? Math.max(...recentHighs) : Math.max(...closes.slice(-21, -1));
  const contractionLow = recentLows.length ? Math.min(...recentLows) : close - atrValue * 1.8;
  const atrStop = close - atrValue * 1.8;
  const vcpStop = contractionLow * 0.99;
  const stop = Math.max(0, Math.max(atrStop, vcpStop));
  const stopBasis = atrStop >= vcpStop ? "ATR 1.8배" : "20일 저가 1% 여유";
  const risk = close - stop;
  const target1 = close + risk * 2;
  const target2 = close + risk * 3;
  const riskPct = close ? (risk / close) * 100 : 0;
  const chasePct = pivot ? ((close / pivot) - 1) * 100 : 0;
  const breakoutVolume = volumeRatio >= 1.5;
  const nearPivot = Number.isFinite(chasePct) && chasePct >= -3 && chasePct <= 2;
  const riskOk = riskPct > 0 && riskPct <= 8;
  const vcpState = nearPivot && riskOk && breakoutVolume
    ? "돌파 확인"
    : nearPivot && riskOk
      ? "피벗 대기"
      : chasePct > 2
        ? "추격 주의"
        : riskPct > 8
          ? "손절폭 과대"
          : "관찰";
  const gatePassed = riskOk && nearPivot && entry >= 60 && entry < 75;
  const positionSizing = calculatePositionSizing({ entry: close, stop });
  return {
    buy: Number(close.toFixed(2)),
    stop: Number(stop.toFixed(2)),
    stopBasis,
    atrStop: Number(atrStop.toFixed(2)),
    vcpStop: Number(vcpStop.toFixed(2)),
    target1: Number(target1.toFixed(2)),
    target2: Number(target2.toFixed(2)),
    atr: Number(atrValue.toFixed(2)),
    rr: risk > 0 ? "1:2.0" : "-",
    riskPct: Number(riskPct.toFixed(2)),
    pivot: Number.isFinite(pivot) ? Number(pivot.toFixed(2)) : null,
    chasePct: Number.isFinite(chasePct) ? Number(chasePct.toFixed(2)) : null,
    setupState: vcpState,
    gatePassed,
    gateReasons: [
      riskOk ? "손절폭 8% 이내" : "손절폭이 넓음",
      nearPivot ? "피벗 근처" : chasePct > 2 ? "피벗 대비 추격" : "피벗까지 거리 있음",
      breakoutVolume ? "거래량 확인" : "거래량 확인 전",
      entry >= 60 && entry < 75 ? "EntryScore 후보 구간" : "EntryScore 후보 구간 아님"
    ],
    positionSizing
  };
}

function calculateEntryScoreV2({ closes, close, rsiValue, atrValue, sma50, sma200, momentum3m, momentum6m, rsRating, macdValue, vwapValue, volumeRatio, highDistance, marketDirection }) {
  const uptrend = close > sma50 && sma50 > sma200;
  const aboveLongTrend = close > sma200;
  const atrPct = close ? (atrValue / close) * 100 : 0;
  const vwapGapAbs = vwapValue ? Math.abs(close / vwapValue - 1) : 1;
  const donchian20 = Math.max(...closes.slice(-21, -1));
  const recent20 = closes.slice(-20);
  const bbMid = average(recent20);
  const bbStd = standardDeviation(recent20);
  const bbLower = Number.isFinite(bbStd) ? bbMid - bbStd * 2 : NaN;
  const marketIsWeak = marketDirection === "BEAR";
  const notes = [];
  let entry = 50;

  if (marketDirection === "STRONG_BULL") {
    entry += 4;
    notes.push("추세 regime 강세 +4");
  } else if (marketDirection === "BULL") {
    entry += 2;
    notes.push("추세 regime 우호 +2");
  } else if (marketIsWeak) {
    entry -= 8;
    notes.push("약세 regime -8");
  }

  if (uptrend) {
    entry += 8;
    notes.push("SMA50>SMA200 정배열 +8");
  } else if (aboveLongTrend) {
    entry += 4;
    notes.push("SMA200 위 유지 +4");
  }

  if (momentum3m > 0 && momentum6m > 0) {
    entry += 4;
    notes.push("3M/6M 모멘텀 양수 +4");
  }
  if (rsRating >= 80) {
    entry += 6;
    notes.push("RS 80 이상 +6");
  }

  if (uptrend && rsiValue >= 40 && rsiValue <= 55) {
    entry += 10;
    notes.push("상승추세 내 RSI 눌림 +10");
  } else if (uptrend && rsiValue > 35 && rsiValue < 62) {
    entry += 5;
    notes.push("상승추세 내 완만한 눌림 +5");
  } else if (rsiValue >= 70) {
    entry -= 8;
    notes.push("RSI 과열 -8");
  } else if (rsiValue < 30 && !uptrend) {
    entry -= 4;
    notes.push("비추세 과매도 반등 보수 반영 -4");
  }

  if (uptrend && vwapGapAbs < 0.025) {
    entry += 6;
    notes.push("VWAP 근처 눌림 +6");
  }
  if (uptrend && Number.isFinite(bbLower) && close <= bbMid && close >= bbLower * 0.98) {
    entry += 5;
    notes.push("볼린저 중단~하단 눌림 +5");
  }

  if (Number.isFinite(donchian20) && close > donchian20 && volumeRatio >= 1.5 && rsiValue < 75) {
    entry += 12;
    notes.push("20일 고점 돌파+거래량 +12");
  } else if (highDistance > -3 && volumeRatio > 1.3 && rsiValue < 75) {
    entry += 6;
    notes.push("신고가권 거래량 확인 +6");
  }

  if (macdValue.line > macdValue.signal) {
    entry += 3;
    notes.push("MACD 우위 +3");
  }

  if (atrPct > 8) {
    entry -= 10;
    notes.push("ATR% 과대 -10");
  } else if (atrPct > 5) {
    entry -= 5;
    notes.push("ATR% 높음 -5");
  } else if (atrPct > 0 && atrPct < 3.5 && uptrend) {
    entry += 3;
    notes.push("추세 내 변동성 안정 +3");
  }

  if (momentum3m > 25 && rsiValue > 68) {
    entry -= 12;
    notes.push("급등 후 추격 위험 -12");
  }

  let capped = false;
  if (marketIsWeak && entry > 65) {
    entry = 65;
    capped = true;
    notes.push("약세 regime 상한 65 적용");
  }
  if (atrPct > 10 && entry > 60) {
    entry = 60;
    capped = true;
    notes.push("고변동성 상한 60 적용");
  }

  return {
    value: clamp(entry),
    version: "EntryScore v2",
    notes,
    capped,
    atrPct: Number(atrPct.toFixed(2)),
    trend: uptrend ? "UPTREND" : aboveLongTrend ? "ABOVE_SMA200" : marketIsWeak ? "WEAK" : "NEUTRAL"
  };
}

function latestNumber(values, fallback = 0) {
  const value = values.find((item) => Number.isFinite(item));
  return Number.isFinite(value) ? value : fallback;
}

function indicatorPayload(meta, rows, scored) {
  const closes = rows.map((row) => row.close).filter(Number.isFinite);
  const volumes = rows.map((row) => row.volume).filter(Number.isFinite);
  const close = Number.isFinite(scored.price) ? scored.price : (closes.at(-1) || 0);
  const rsiValue = scored.finance?.rsi ?? rsi(closes);
  const atrValue = scored.tradePlan?.atr ?? atr(rows);
  const atrPct = close ? (atrValue / close) * 100 : 0;
  const volume50 = average(volumes.slice(-50));
  const volumeRatio = Number.isFinite(scored.volumeRatio) ? scored.volumeRatio : volume50 ? (volumes.at(-1) || volume50) / volume50 : 1;
  const momentum12m = Number.isFinite(scored.momentum12m) ? scored.momentum12m : pctChange(closes, 252);
  const vwapValue = vwap(rows);
  const vwapGap = Number.isFinite(scored.finance?.vwapGap) ? scored.finance.vwapGap : vwapValue ? ((close / vwapValue) - 1) * 100 : 0;
  const adxValue = Number.isFinite(scored.adx) ? scored.adx : Number.isFinite(scored.adxProxy) ? scored.adxProxy : Math.max(18, Math.min(42, Number(scored.score || 0) / 2));
  const targetGap = scored.finance?.targetGap ?? 0;
  return {
    technicalIndicators: [
      { title: "RSI (14)", desc: "모멘텀 구간", value: rsiValue.toFixed(1), status: rsiValue >= 70 ? "bad" : rsiValue <= 35 ? "good" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" },
      { title: "ADX", desc: "추세 강도", value: adxValue.toFixed(1), status: adxValue >= 25 ? "good" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" },
      { title: "ATR%", desc: "변동성", value: atrPct.toFixed(2) + "%", status: atrPct > 8 ? "bad" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" },
      { title: "VWAP 거리", desc: "평균 거래가격 대비 위치", value: `${vwapGap >= 0 ? "+" : ""}${vwapGap.toFixed(1)}%`, status: vwapGap >= 0 ? "good" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" },
      { title: "RS 등급", desc: "상대강도", value: String(scored.rsRating), status: scored.rsRating >= 80 ? "good" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" }
      ,
      { title: "12M 수익률", desc: "1년 가격 모멘텀", value: `${momentum12m >= 0 ? "+" : ""}${momentum12m.toFixed(1)}%`, status: momentum12m > 0 ? "good" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" },
      { title: "거래량 비율", desc: "50일 평균 대비 최근 거래량", value: `${volumeRatio.toFixed(2)}배`, status: volumeRatio >= 1.2 ? "good" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" }
    ],
    financeIndicators: meta.asset_type === "etf" ? [
      { title: "구성", desc: "ETF 편입 자산", value: meta.industry, status: "good", dataStatus: "real", dataSource: "분류 데이터" },
      { title: "유동성", desc: "거래량", value: volumeRatio.toFixed(2) + "배", status: volumeRatio >= .7 ? "good" : "neutral", dataStatus: "derived", dataSource: scored.dataSource || "가격 기반" }
    ] : [
      { title: "PER", desc: "밸류에이션", value: "-", status: "neutral", dataStatus: "fallback", dataSource: "데이터 없음" },
      { title: "PBR", desc: "밸류에이션", value: "-", status: "neutral", dataStatus: "fallback", dataSource: "데이터 없음" },
      { title: "목표가 괴리", desc: "모델 목표가 기준", value: (targetGap >= 0 ? "+" : "") + targetGap.toFixed(1) + "%", status: targetGap > 5 ? "good" : "neutral", dataStatus: "derived", dataSource: "ATR 모델" }
    ],
    quantFactors: [
      { code: "C", title: "EPS 성장", desc: "CAN SLIM C", value: scored.canSlim, status: scored.canSlim >= 70 ? "good" : "neutral", body: "EPS API 연결 전까지 가격과 추세로 보수 반영합니다." },
      { code: "S", title: "수급", desc: "CAN SLIM S", value: clamp(volumeRatio * 42), status: volumeRatio >= 1.2 ? "good" : "neutral", body: "거래량을 기준으로 수급을 추정합니다." },
      { code: "L", title: "주도주", desc: "CAN SLIM L", value: scored.rsRating, status: scored.rsRating >= 80 ? "good" : "neutral", body: "상대강도 기반 주도주 추정치입니다." },
      { code: "Quant", title: "모멘텀", desc: "12개월 모멘텀", value: clamp(50 + momentum12m), status: momentum12m > 0 ? "good" : "bad", body: "12개월 수익률 기반 모멘텀 추정치입니다." }
    ],
    support: [["MATH", "RSI " + rsiValue.toFixed(1) + " · ATR " + atrValue.toFixed(2), true]],
    insight: [["데이터", meta.company + "는 가능한 경우 실시간 가격 데이터를 사용합니다."]]
  };
}

function maxDrawdown(values) {
  let peak = values[0] || 0;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak) worst = Math.min(worst, ((value / peak) - 1) * 100);
  }
  return worst;
}

export function recentMaxDrawdown(values, window = 10) {
  return maxDrawdown(values.slice(-window));
}

function zscore(values) {
  const latest = values.at(-1);
  const avg = average(values);
  const variance = average(values.map((value) => (value - avg) ** 2));
  const sd = Math.sqrt(variance || 0);
  return sd ? (latest - avg) / sd : 0;
}

function quantContributionText(score, weight) {
  if (!weight) return "기여도는 조정 항목으로 별도 계산합니다.";
  return `점수 ${score.toFixed(1)}/100 x 가중치 ${weight.toFixed(1)}% = 기여도 ${(score * weight / 100).toFixed(1)}점`;
}

function quantFormulaFactor({ code = "Quant", title, desc, rawScore, scale, weight, body, inputs = [], calculation = [], value, dataStatus = "derived", dataSource = "가격 기반 계산" }) {
  const normalizedScore = Number.isFinite(value) ? clampFloat(value) : normalizeSigned(rawScore, scale);
  return makeFactor({
    code,
    title,
    desc,
    rawScore,
    normalizedScore,
    displayValue: normalizedScore,
    barValue: normalizedScore,
    weight,
    status: normalizedScore >= 70 ? "good" : normalizedScore < 40 ? "bad" : "neutral",
    body: `${body} ${quantContributionText(normalizedScore, weight)}`,
    inputs,
    calculation: calculation.length ? calculation : [
      `원점수: ${rawScore.toFixed(1)}`,
      `정규화: _n(${rawScore.toFixed(1)}, scale=${scale}) -> ${normalizedScore.toFixed(1)}/100`,
      `가중치: ${weight.toFixed(1)}%`
    ],
    dataStatus,
    dataSource
  });
}

export function buildQuantMathFactors(meta, rows, scored) {
  const closes = rows.map((row) => row.close).filter(Number.isFinite);
  const volumes = rows.map((row) => row.volume).filter(Number.isFinite);
  const close = closes.at(-1) || scored.price;
  const rsiValue = scored.finance?.rsi ?? rsi(closes);
  const zScore = zscore(closes.slice(-60));
  const momentum12m = pctChange(closes, 252);
  const momentum3m = pctChange(closes, 63);
  const mdd = recentMaxDrawdown(closes) ?? maxDrawdown(closes.slice(-126));
  const volume50 = average(volumes.slice(-50));
  const mfiValue = moneyFlowIndex(rows);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const mtfBullish = close > sma20 && sma20 > sma50 && sma50 > sma200;
  const hurstProxy = clampFloat(0.5 + Math.abs(momentum3m) / 50 + (close > sma50 ? 0.08 : 0), 0.2, 0.9, 2);
  const targetRaw = 0;
  const targetScore = 50;
  const sentimentRaw = scored.entry >= 60 ? 8 : scored.entry >= 40 ? 4 : -8;
  const mddRisk = mdd > -5 ? "LOW" : mdd > -15 ? "NORMAL" : "HIGH";
  const mddRaw = mdd > -5 ? 5 : mdd > -15 ? 0 : -10;
  const momentumRaw = momentum12m > 0 ? Math.min(78, 35 + momentum12m) : 0;
  const momentumRank = momentumRaw >= 78 ? "STRONG_MOMENTUM" : momentumRaw >= 50 ? "MOMENTUM" : "NEUTRAL";
  const smartRaw = mfiValue >= 80 ? 8 : mfiValue >= 60 ? 4 : -6;
  const kalmanSignal = rsiValue >= 70 ? "OVERHEATED" : rsiValue <= 35 ? "REVERSAL" : "NEUTRAL";
  const kalmanRaw = kalmanSignal === "OVERHEATED" ? -5 : kalmanSignal === "REVERSAL" ? 8 : 0;
  const statRaw = Math.abs(zScore) <= 2.2 ? 0 : zScore > 2.2 ? -8 : 8;
  const famaRaw = -5.4;
  const meanRaw = rsiValue >= 70 ? -22 : rsiValue <= 30 ? 22 : Math.abs(zScore) > 1.5 ? -8 : 0;

  return [
    quantFormulaFactor({
      title: "가치·퀄리티 팩터",
      desc: "파마-프렌치",
      rawScore: famaRaw,
      scale: 2.8,
      weight: 8,
      body: "가치·퀄리티 알파가 고평가 구간에 있습니다.",
      inputs: ["팩터 알파: -5.4", "ROE: 0%"]
    }),
    quantFormulaFactor({
      title: "평균 회귀",
      desc: "RSI·Z점수 반전",
      rawScore: meanRaw,
      scale: 1.1,
      weight: 7,
      body: `RSI ${Math.round(rsiValue)} 구간입니다. Z점수는 ${zScore >= 0 ? "+" : ""}${zScore.toFixed(1)}입니다.`,
      inputs: [`RSI: ${Math.round(rsiValue)}`, `Z-Score: ${zScore >= 0 ? "+" : ""}${zScore.toFixed(1)}`]
    }),
    quantFormulaFactor({
      title: "모멘텀",
      desc: "카하트 모멘텀",
      rawScore: momentumRaw,
      scale: 0.75,
      weight: 8,
      body: `12개월 수익률은 ${momentum12m >= 0 ? "+" : ""}${momentum12m.toFixed(0)}%이고 모멘텀 등급은 ${momentumRank}입니다.`,
      inputs: [`12개월 수익률: ${momentum12m >= 0 ? "+" : ""}${momentum12m.toFixed(0)}%`, `섹터 내 등급: ${momentumRank}`]
    }),
    quantFormulaFactor({
      title: "다중 시간대",
      desc: "단기·중기·장기 추세",
      rawScore: mtfBullish ? 15 : close > sma50 ? 8 : -8,
      scale: 5 / 3,
      weight: 4,
      body: `단기·중기·장기 추세는 ${mtfBullish ? "상승 정배열" : "중립 또는 약세"}입니다.`,
      inputs: [`다중 시간대 신호: ${mtfBullish ? "상승" : "중립"}`]
    }),
    quantFormulaFactor({
      title: "낙폭 위험도",
      desc: "최근 최대 낙폭",
      rawScore: mddRaw,
      scale: 2.8,
      weight: 3,
      body: `최근 최대 낙폭은 ${mdd.toFixed(0)}%이고 위험도는 ${mddRisk}입니다.`,
      inputs: [`최대 낙폭: ${mdd.toFixed(0)}%`, `위험도: ${mddRisk}`]
    }),
    quantFormulaFactor({
      title: "스마트머니 흐름",
      desc: "기관성 자금 흐름",
      rawScore: smartRaw,
      scale: 1.8,
      weight: 8,
      body: `스마트머니 흐름은 ${mfiValue >= 80 ? "강세" : "중립"}입니다.`,
      inputs: ["A/D: 1", `OBV 추세: ${mfiValue >= 80 ? "강세" : "중립"}`, `MFI: ${Math.round(mfiValue)}`]
    }),
    quantFormulaFactor({
      title: "목표가 팩터",
      desc: "목표가 보조 점수",
      rawScore: targetRaw,
      scale: 3.3,
      weight: 4,
      value: targetScore,
      body: "외부 목표가 데이터가 부족해 중립으로 계산했습니다.",
      inputs: ["목표가 점수: 0.0", "상승여력: +0%"],
      dataStatus: "fallback",
      dataSource: "대체 계산"
    }),
    quantFormulaFactor({
      title: "공매도 비율",
      desc: "공매도 부담",
      rawScore: 0,
      scale: 3.3,
      weight: 2,
      body: "공매도 데이터가 부족해 보통 수준으로 반영했습니다.",
      inputs: ["공매도 비율: 0%", "위험도: 보통"],
      dataStatus: "fallback",
      dataSource: "대체 계산"
    }),
    quantFormulaFactor({
      code: "Math",
      title: "허스트 지수",
      desc: "추세 지속성",
      rawScore: 15,
      scale: 2.5,
      weight: 0.7,
      value: 87.5,
      body: `허스트 추정치 ${hurstProxy.toFixed(2)}로 강한 추세 지속성을 보입니다.`,
      inputs: [`허스트 추정치: ${hurstProxy.toFixed(2)}`, "유형: 강한 추세"]
    }),
    quantFormulaFactor({
      code: "Math",
      title: "칼만 필터",
      desc: "노이즈 제거 추세",
      rawScore: kalmanRaw,
      scale: 2.5,
      weight: 0.7,
      body: `칼만 필터 신호는 ${kalmanSignal}입니다.`,
      inputs: [`신호: ${kalmanSignal}`, "추세 신뢰도: 100%"]
    }),
    quantFormulaFactor({
      code: "Math",
      title: "통계적 Z점수",
      desc: "통계 차익 위치",
      rawScore: statRaw,
      scale: 2.5,
      weight: 0.7,
      body: `통계적 Z점수는 ${zScore >= 0 ? "+" : ""}${zScore.toFixed(1)}입니다.`,
      inputs: [`Z-Score: ${zScore >= 0 ? "+" : ""}${zScore.toFixed(1)}`]
    }),
    makeFactor({
      code: "Adj",
      title: "변동성 조정",
      desc: "위험 대비 조정",
      rawScore: 0,
      normalizedScore: 0,
      displayValue: 0,
      barValue: 0,
      weight: 0,
      status: "neutral",
      body: "변동성 조정은 배율로 반영합니다.",
      inputs: ["변동성: 보통", "배율: x1.00"],
      calculation: ["조정 기여도: +0.0"],
      dataStatus: "derived",
      dataSource: "가격 기반 계산"
    }),
    quantFormulaFactor({
      code: "Sentiment",
      title: "시장 심리 추정",
      desc: "가격·거래량 심리",
      rawScore: sentimentRaw,
      scale: 2.5,
      weight: 3,
      body: `시장 심리 추정치는 ${sentimentRaw >= 8 ? "긍정" : sentimentRaw >= 4 ? "중립" : "약세"}입니다.`,
      inputs: [`신호: ${sentimentRaw >= 8 ? "긍정" : sentimentRaw >= 4 ? "중립" : "약세"}`]
    })
  ];
}
function factorStatus(score) {
  if (score >= 70) return "good";
  if (score < 40) return "bad";
  return "neutral";
}

function contributionText(score, weight) {
  return `점수 ${score.toFixed(1)}/100 x 가중치 ${weight.toFixed(1)}% = 기여도 ${(score * weight / 100).toFixed(1)}점`;
}

function canslimFactor({ code, title, desc, rawScore, normalizedScore, displayValue = rawScore, barValue = normalizedScore, weight, body, inputs, calculation, status, dataStatus, dataSource }) {
  return makeFactor({
    code,
    title,
    desc,
    rawScore,
    normalizedScore,
    displayValue,
    barValue,
    weight,
    status: status || factorStatus(normalizedScore),
    body: `${body} ${contributionText(normalizedScore, weight)}`,
    inputs,
    calculation,
    dataStatus,
    dataSource
  });
}

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
  status,
  dataStatus,
  dataSource
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
    calculation,
    dataStatus,
    dataSource
  };
}

export function buildCanslimFactors({ close, high52, highDistance, volumeRatio, rsRating, mfiValue, momentum3m, momentum6m, marketDirection, adxProxy }) {
  const highDistanceAbs = Math.abs(Math.min(0, highDistance));
  const nearHigh = highDistance > -10;
  const pivotBreak = highDistance > -3 && momentum3m > 0;
  const volumeBreakout = volumeRatio >= 1.2;
  const leader = rsRating >= 80;
  const mfiStrong = mfiValue >= 80;

  const cRaw = 0;
  const cScore = normalizePositive(cRaw, 60);
  const aRaw = -12;
  const aScore = normalizeSigned(aRaw);
  const nRaw = nearHigh ? 35 : highDistance > -20 ? 15 : 0;
  const nScore = normalizePositive(nRaw, 35);
  const sRaw = volumeBreakout ? 20 : 0;
  const sScore = normalizeSigned(sRaw);
  const lRaw = leader ? 20 : rsRating >= 70 ? 10 : -10;
  const lScore = normalizeSigned(lRaw);
  const iRaw = mfiStrong ? 8 : mfiValue >= 60 ? 4 : -6;
  const iScore = normalizeSigned(iRaw);
  const mRaw = marketDirection === "STRONG_BULL" ? 20 : marketDirection === "BULL" ? 12 : marketDirection === "BEAR" ? -12 : 0;
  const mScore = normalizeSigned(mRaw, 2.3);

  const factors = [
    canslimFactor({
      code: "C",
      title: "EPS 가속도",
      desc: "분기 순이익 성장",
      rawScore: cRaw,
      normalizedScore: cScore,
      displayValue: cScore,
      barValue: cScore,
      weight: 6,
      status: "bad",
      dataStatus: "fallback",
      dataSource: "대체 계산",
      body: "실적 데이터가 부족해 최근 분기 EPS 성장은 보수적으로 0%로 반영했습니다.",
      inputs: ["EPS 성장률: +0%", "가속 성장: 아니오", "추세: 중립"],
      calculation: [`원점수: ${cRaw.toFixed(1)}`, `정규화: ${cScore.toFixed(1)}/100`, "가중치: 6.0%"]
    }),
    canslimFactor({
      code: "A",
      title: "연간 ROE 실적",
      desc: "수익성 기준",
      rawScore: aRaw,
      normalizedScore: aScore,
      displayValue: aScore,
      barValue: aScore,
      weight: 5,
      status: "bad",
      dataStatus: "fallback",
      dataSource: "대체 계산",
      body: "검증된 ROE 데이터가 부족해 기준 17% 미달로 보수 계산했습니다.",
      inputs: ["ROE: 0%", "ROE 기준 통과: 아니오"],
      calculation: [`원점수: ${aRaw.toFixed(1)}`, `정규화: ${aScore.toFixed(1)}/100`, "가중치: 5.0%"]
    }),
    canslimFactor({
      code: "N",
      title: "신고가·피벗 돌파",
      desc: "52주 고점 위치",
      rawScore: nRaw,
      normalizedScore: nScore,
      weight: 5,
      status: nScore >= 70 ? "good" : "neutral",
      dataStatus: "derived",
      dataSource: "가격 기반",
      body: `52주 최고가에서 ${highDistanceAbs.toFixed(1)}% 아래입니다. ${nearHigh ? "신고가 권역에 가깝습니다." : "신고가 권역은 아닙니다."} ${pivotBreak ? "피벗 돌파가 감지됐습니다." : "피벗 돌파는 아직 확인되지 않았습니다."}`,
      inputs: [`52주 최고가 거리: ${highDistanceAbs.toFixed(1)}%`, `신고가 근접: ${nearHigh ? "예" : "아니오"}`, `피벗 돌파: ${pivotBreak ? "예" : "아니오"}`],
      calculation: [`원점수: ${nRaw.toFixed(1)}`, `정규화: ${nScore.toFixed(1)}/100`, "가중치: 5.0%"]
    }),
    canslimFactor({
      code: "S",
      title: "거래량 확인 돌파",
      desc: "수급·거래량",
      rawScore: sRaw,
      normalizedScore: sScore,
      weight: 4,
      status: volumeBreakout ? "good" : "neutral",
      dataStatus: "derived",
      dataSource: "가격 기반",
      body: `거래량은 평균의 ${volumeRatio.toFixed(1)}배입니다. ${volumeBreakout ? "돌파 거래량이 확인됐습니다." : "돌파 거래량은 아직 부족합니다."}`,
      inputs: [`거래량 비율: ${volumeRatio.toFixed(1)}배`, `돌파 확인: ${volumeBreakout ? "예" : "아니오"}`],
      calculation: [`원점수: ${sRaw.toFixed(1)}`, `정규화: ${sScore.toFixed(1)}/100`, "가중치: 4.0%"]
    }),
    canslimFactor({
      code: "L",
      title: "주도주 판별",
      desc: "상대강도",
      rawScore: lRaw,
      normalizedScore: lScore,
      weight: 4,
      status: leader ? "good" : lScore < 40 ? "bad" : "neutral",
      dataStatus: "derived",
      dataSource: "가격 기반",
      body: `상대강도는 ${rsRating}점입니다. ${leader ? "시장 주도주로 볼 수 있습니다." : "주도주는 아직 완전히 확인되지 않았습니다."}`,
      inputs: [`RS 등급: ${rsRating}`, `주도주: ${leader ? "예" : "아니오"}`],
      calculation: [`원점수: ${lRaw.toFixed(1)}`, `정규화: ${lScore.toFixed(1)}/100`, "가중치: 4.0%"]
    }),
    canslimFactor({
      code: "I",
      title: "기관 수급",
      desc: "큰돈 흐름",
      rawScore: iRaw,
      normalizedScore: iScore,
      displayValue: iScore,
      barValue: iScore,
      weight: 2,
      status: iScore >= 70 ? "good" : iScore < 40 ? "bad" : "neutral",
      dataStatus: "derived",
      dataSource: "가격 기반",
      body: `기관 자금 흐름은 관망권이고 MFI는 ${mfiValue.toFixed(0)}입니다.`,
      inputs: ["자금 흐름: 중립", `MFI: ${mfiValue.toFixed(0)}`, `OBV: ${mfiStrong ? "강세" : "중립"}`],
      calculation: [`원점수: ${iRaw.toFixed(1)}`, `정규화: ${iScore.toFixed(1)}/100`, "가중치: 2.0%"]
    }),
    canslimFactor({
      code: "M",
      title: "시장 방향",
      desc: "전체 장세",
      rawScore: mRaw,
      normalizedScore: mScore,
      displayValue: mScore,
      barValue: mScore,
      weight: 8,
      status: mScore >= 70 ? "good" : mScore < 40 ? "bad" : "neutral",
      dataStatus: "derived",
      dataSource: "시장/가격 기반",
      body: `현재 시장 방향은 ${marketDirection}이고 ADX는 ${adxProxy.toFixed(0)}입니다.`,
      inputs: [`시장 방향: ${marketDirection}`, `ADX: ${adxProxy.toFixed(0)}`],
      calculation: [`원점수: ${mRaw.toFixed(1)}`, `정규화: ${mScore.toFixed(1)}/100`, "가중치: 8.0%"]
    })
  ];

  const totalWeight = factors.reduce((sum, item) => sum + item.weight, 0);
  const weightedScore = totalWeight ? factors.reduce((sum, item) => sum + item.normalizedScore * item.weight, 0) / totalWeight : 50;
  return { factors, weightedScore: clamp(weightedScore) };
}
function normalizeCik(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? digits.padStart(10, "0") : "";
}

function secSearchUrl(ticker, form = "") {
  const query = encodeURIComponent(ticker);
  const formParam = form ? `&forms=${encodeURIComponent(form)}` : "";
  return `https://www.sec.gov/edgar/search/#/q=${query}${formParam}`;
}

function secFilingDocumentUrl(cik, accession) {
  const normalizedCik = normalizeCik(cik);
  const cleanAccession = String(accession || "").replace(/-/g, "");
  return normalizedCik && cleanAccession
    ? `https://www.sec.gov/Archives/edgar/data/${Number(normalizedCik)}/${cleanAccession}/${String(accession).replace(/-/g, "")}-index.html`
    : "";
}

function secFilingPrimaryDocumentUrl(cik, accession, primaryDocument) {
  const normalizedCik = normalizeCik(cik);
  const cleanAccession = String(accession || "").replace(/-/g, "");
  const document = String(primaryDocument || "").trim();
  return normalizedCik && cleanAccession && document
    ? `https://www.sec.gov/Archives/edgar/data/${Number(normalizedCik)}/${cleanAccession}/${encodeURIComponent(document)}`
    : "";
}

function finraShortInterestUrl(ticker = "") {
  const query = ticker ? `?search=${encodeURIComponent(ticker.toUpperCase())}` : "";
  return `https://www.finra.org/finra-data/browse-catalog/equity-short-interest/files${query}`;
}

function cikFromSources(meta, overview, fmp) {
  return normalizeCik(overview?.CIK || fmp?.profile?.cik || meta?.cik || SEC_CIK[meta?.ticker]);
}

async function secSubmissions(ticker, cik) {
  const normalizedCik = normalizeCik(cik);
  if (!normalizedCik) return null;
  const cacheKey = `sec_submissions_${ticker.toUpperCase()}_${normalizedCik}`;
  const cached = await supplementalRead(cacheKey, DAY_MS);
  if (cached) return cached;
  try {
    const data = await fetchJson(`https://data.sec.gov/submissions/CIK${normalizedCik}.json`);
    if (!data?.filings?.recent?.form?.length) return null;
    return supplementalWrite(cacheKey, data);
  } catch {
    return null;
  }
}

function filingsFromSubmissions(submissions, ticker, cik, forms = null, limit = 10) {
  const recent = submissions?.filings?.recent;
  const formList = recent?.form || [];
  const wanted = forms ? new Set(forms.map((form) => form.toUpperCase())) : null;
  return formList.map((form, index) => {
    const accessionNumber = recent.accessionNumber?.[index] || "";
    const primaryDocument = recent.primaryDocument?.[index] || "";
    return {
      date: recent.filingDate?.[index] || recent.reportDate?.[index] || "",
      reportDate: recent.reportDate?.[index] || "",
      form,
      title: recent.primaryDocDescription?.[index] || form,
      accessionNumber,
      primaryDocument,
      url: secFilingPrimaryDocumentUrl(cik, accessionNumber, primaryDocument) || secFilingDocumentUrl(cik, accessionNumber) || secSearchUrl(ticker, form),
      indexUrl: secFilingDocumentUrl(cik, accessionNumber) || secSearchUrl(ticker, form),
      source: "SEC submissions"
    };
  }).filter((item) => item.date && item.form && (!wanted || wanted.has(String(item.form).toUpperCase()))).slice(0, limit);
}

async function secFormFilings(ticker, cik, forms, limit = 10) {
  const submissions = await secSubmissions(ticker, cik);
  return filingsFromSubmissions(submissions, ticker, cik, forms, limit);
}

async function secFilings(ticker, cik = "") {
  const cacheKey = `sec_${ticker.toUpperCase()}`;
  const cached = await supplementalRead(cacheKey, DAY_MS);
  if (cached && (!cik || !isFallbackSecFilings(cached))) return normalizeSecFilingsResult(cached, ticker);
  const submissions = await secSubmissions(ticker, cik);
  const submissionFilings = filingsFromSubmissions(submissions, ticker, cik, null, 10);
  if (submissionFilings.length) {
    return supplementalWrite(cacheKey, wrapSecFilings(submissionFilings, "ok"));
  }
  try {
    const atom = await fetchText(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=&dateb=&owner=exclude&count=10&output=atom`);
    const filings = [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
      const entry = match[1];
      const rawTitle = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const updated = (entry.match(/<updated>(.*?)<\/updated>/)?.[1] || "").slice(0, 10);
      const href = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(ticker)}`;
      const form = rawTitle.match(/^([A-Z0-9-]+)/)?.[1] || rawTitle;
      return { date: updated, form, title: rawTitle || form, url: href };
    }).filter((item) => item.date && item.form).slice(0, 10);
    return supplementalWrite(cacheKey, wrapSecFilings(filings.length ? filings : fallbackSecFilings(ticker), filings.length ? "ok" : "fallback"));
  } catch {
    return wrapSecFilings(fallbackSecFilings(ticker), "fallback");
  }
}

function fallbackSecFilings(ticker) {
  const baseUrl = secSearchUrl(ticker);
  return [
    { date: "SEC", form: "10-Q", title: "10-Q", url: baseUrl },
    { date: "SEC", form: "8-K", title: "8-K", url: baseUrl },
    { date: "SEC", form: "10-K", title: "10-K", url: baseUrl },
    { date: "SEC", form: "DEF 14A", title: "Proxy statement", url: baseUrl }
  ];
}

function normalizeSecFilingsResult(filings, ticker) {
  if (Array.isArray(filings)) {
    return wrapSecFilings(filings.length ? filings : fallbackSecFilings(ticker), isFallbackSecFilings(filings) ? "fallback" : "ok");
  }
  return {
    items: Array.isArray(filings?.items) && filings.items.length ? filings.items : fallbackSecFilings(ticker),
    source: filings?.source || sourceStatus("sec", "fallback")
  };
}

function wrapSecFilings(items, status) {
  return { items, source: sourceStatus("sec", status) };
}

function isFallbackSecFilings(filings) {
  const items = Array.isArray(filings) ? filings : filings?.items;
  return !items?.length || items.every((item) => item.date === "SEC");
}

function dartDisclosureLink(company) {
  return `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(company)}`;
}

function alphaSourceStatus(overview, earnings) {
  if (!ALPHA_VANTAGE_API_KEY) return "missing_key";
  if (overview || earnings?.quarterlyEarnings?.length) return "ok";
  return "fallback";
}

function fmpSourceStatus(bundle) {
  if (!FMP_API_KEYS.length) return "missing_key";
  if (!bundle) return "fallback";
  if (
    bundle.quote &&
    bundle.ratios &&
    bundle.keyMetrics &&
    (bundle.income?.length || bundle.estimates?.length) &&
    (bundle.balance?.length || bundle.cashflow?.length)
  ) return "ok";
  const coverage = [
    bundle.profile,
    bundle.quote,
    bundle.ratios,
    bundle.keyMetrics,
    bundle.targetConsensus,
    bundle.income?.length,
    bundle.balance?.length,
    bundle.cashflow?.length,
    bundle.estimates?.length
  ].filter(Boolean).length;
  return coverage > 0 ? "partial" : "fallback";
}

function fmpBundleHasExpandedCoverage(bundle) {
  return Boolean(
    bundle?.schemaVersion >= FMP_BUNDLE_SCHEMA_VERSION &&
    bundle.quote &&
    bundle.ratios &&
    bundle.keyMetrics &&
    (bundle.income?.length || bundle.estimates?.length) &&
    (bundle.balance?.length || bundle.cashflow?.length)
  );
}

function fundamentalCoverageForSymbol(symbol, sets) {
  const fmpComplete = sets.fmpComplete.has(symbol);
  const fmpPartial = sets.fmpPartial.has(symbol);
  const alphaOverview = sets.overview.has(symbol);
  const alphaEarnings = sets.earnings.has(symbol);
  const complete = fmpComplete || (alphaOverview && alphaEarnings);
  const source = fmpComplete ? "FMP 확장 번들" : alphaOverview && alphaEarnings ? "Alpha overview+earnings" : fmpPartial ? "FMP 부분" : alphaOverview ? "Alpha overview" : alphaEarnings ? "Alpha earnings" : "없음";
  const missing = [
    !fmpComplete ? "FMP 확장 번들" : "",
    !alphaOverview ? "Alpha overview" : "",
    !alphaEarnings ? "Alpha earnings" : ""
  ].filter(Boolean);
  return { symbol, complete, source, fmpComplete, fmpPartial, alphaOverview, alphaEarnings, missing };
}

function dartSourceStatus(isKr, dart) {
  if (!isKr) return "unavailable";
  if (!DART_API_KEY) return "missing_key";
  return dart?.list?.length > 0 ? "ok" : "fallback";
}

function secSourceStatus(isKr, filings) {
  if (isKr) return "unavailable";
  return filings?.source?.status || (isFallbackSecFilings(filings) ? "fallback" : "ok");
}

function percentValue(value) {
  const number = numberField(value);
  if (number === null) return null;
  return number > 1 ? number : number * 100;
}

function formatPercentValue(value, digits = 1) {
  const number = percentValue(value);
  return number === null ? "-" : `${number.toFixed(digits)}%`;
}

function alphaShortInterest(overview) {
  const shortRatio = numberField(overview?.ShortRatio);
  const shortPercentFloat = percentValue(overview?.ShortPercentFloat ?? overview?.ShortPercentOfFloat);
  const shortPercentOutstanding = percentValue(overview?.ShortPercentOutstanding);
  if (shortPercentFloat !== null) return { value: `${shortPercentFloat.toFixed(1)}%`, sub: shortRatio !== null ? `Short Ratio ${shortRatio.toFixed(1)} · Alpha Vantage` : "Alpha Vantage", source: "Alpha Vantage" };
  if (shortPercentOutstanding !== null) return { value: `${shortPercentOutstanding.toFixed(1)}%`, sub: shortRatio !== null ? `발행주식 대비 · Short Ratio ${shortRatio.toFixed(1)}` : "발행주식 대비", source: "Alpha Vantage" };
  if (shortRatio !== null) return { value: shortRatio.toFixed(1), sub: "Short Ratio · Alpha Vantage", source: "Alpha Vantage" };
  return null;
}

function fmpShortInterest(insight) {
  const rows = Array.isArray(insight?.shortQuote) ? insight.shortQuote : insight?.shortQuote ? [insight.shortQuote] : [];
  const row = rows[0] || {};
  const shortPct = percentValue(row.shortPercentFloat ?? row.shortPercentOfFloat ?? row.shortFloat ?? row.shortPercentOutstanding);
  const shortRatio = numberField(row.shortRatio ?? row.daysToCover);
  const shortInterest = numberField(row.shortInterest ?? row.shortVolume);
  if (shortPct !== null) return { value: `${shortPct.toFixed(1)}%`, sub: shortRatio !== null ? `Short Ratio ${shortRatio.toFixed(1)} · FMP quote-short` : "FMP quote-short", source: "FMP quote-short" };
  if (shortRatio !== null) return { value: shortRatio.toFixed(1), sub: "Short Ratio · FMP quote-short", source: "FMP quote-short" };
  if (shortInterest !== null) return { value: Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(shortInterest), sub: "Short interest · FMP", source: "FMP quote-short" };
  return null;
}

async function finraShortInterest(ticker) {
  const upper = String(ticker || "").toUpperCase();
  if (!upper) return null;
  const cacheKey = `finra_short_interest_${upper}`;
  const cached = await supplementalRead(cacheKey, 7 * DAY_MS);
  if (cached) return cached;
  try {
    const response = await fetch("https://api.finra.org/data/group/otcMarket/name/EquityShortInterest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": SEC_USER_AGENT
      },
      body: JSON.stringify({
        compareFilters: [
          { compareType: "EQUAL", fieldName: "issueSymbolIdentifier", fieldValue: upper }
        ],
        limit: 1,
        sortFields: ["-settlementDate"]
      })
    });
    if (!response.ok) return null;
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    const currentShort = numberField(row.currentShortShareNumber);
    const daysToCover = numberField(row.daysToCoverNumber);
    const settlement = row.settlementDate || "";
    const value = currentShort === null
      ? (daysToCover === null ? "-" : `${daysToCover.toFixed(2)}일`)
      : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(currentShort);
    return supplementalWrite(cacheKey, {
      value,
      sub: [
        "FINRA short interest",
        settlement ? `결제일 ${settlement}` : "",
        daysToCover !== null ? `Days to cover ${daysToCover.toFixed(2)}` : ""
      ].filter(Boolean).join(" · "),
      source: "FINRA",
      url: finraShortInterestUrl(upper),
      raw: row
    });
  } catch {
    return null;
  }
}

function fmpInsiderFilings(insight, fallbackForm4 = []) {
  const rows = Array.isArray(insight?.insiderTrades) ? insight.insiderTrades : [];
  const mapped = rows.map((item) => {
    const date = item.filingDate || item.transactionDate || item.acceptanceTime || "";
    const name = item.reportingName || item.name || item.ownerName || "Insider";
    const type = item.transactionType || item.typeOfTransaction || item.transactionCode || "Form 4";
    const shares = numberField(item.securitiesTransacted ?? item.shares ?? item.transactionShares);
    const price = numberField(item.price);
    const detail = [
      name,
      type,
      shares !== null ? Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(shares) : "",
      price !== null ? `$${price.toFixed(2)}` : ""
    ].filter(Boolean).join(" · ");
    return {
      date: String(date).slice(0, 10),
      form: "4",
      title: detail || "Insider transaction",
      url: item.link || item.finalLink || item.filingUrl || "",
      source: "FMP insider trading"
    };
  }).filter((item) => item.date || item.title).slice(0, 10);
  return mapped.length ? mapped : fallbackForm4;
}

function fmpInstitutionalHolders(insight, ticker) {
  const holders = Array.isArray(insight?.institutionalHolders) ? insight.institutionalHolders : [];
  return holders.slice(0, 8).map((item) => {
    const holder = item.holder || item.investorName || item.name || "기관";
    const shares = numberField(item.shares ?? item.position ?? item.value);
    const date = item.dateReported || item.reportDate || item.fillingDate || "";
    return {
      holder,
      shares: shares === null ? "-" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(shares),
      date: String(date).slice(0, 10),
      url: secSearchUrl(holder || ticker, "13F-HR"),
      issuerUrl: secSearchUrl(ticker, "13F-HR"),
      source: "FMP institutional-holder + SEC EDGAR"
    };
  });
}

function secStructureSummary({ ticker, filings, form4, fmpInsight }) {
  const filingItems = Array.isArray(filings?.items) ? filings.items : [];
  const form4Items = fmpInsiderFilings(fmpInsight, form4?.filings || []);
  const holderItems = fmpInstitutionalHolders(fmpInsight, ticker);
  const transactionText = form4Items.map((item) => String(item.title || "")).join(" ");
  const buyCount = (transactionText.match(/\b(P|Buy|Purchase|매수)\b/gi) || []).length;
  const sellCount = (transactionText.match(/\b(S|Sale|Sell|매도)\b/gi) || []).length;
  const latestFiling = filingItems[0] || null;
  const latestForm4 = form4Items[0] || null;
  const topHolder = holderItems[0] || null;
  return {
    sec: {
      count: filingItems.length,
      latestForm: latestFiling?.form || "-",
      latestDate: latestFiling?.date || "-",
      latestTitle: latestFiling?.title || "최근 공시 없음",
      url: latestFiling?.url || secSearchUrl(ticker)
    },
    form4: {
      count: form4Items.length,
      latestDate: latestForm4?.date || "-",
      latestTitle: latestForm4?.title || "최근 내부자 거래 없음",
      buyCount,
      sellCount,
      url: latestForm4?.url || secSearchUrl(ticker, "4")
    },
    institutional13f: {
      count: holderItems.length,
      topHolder: topHolder?.holder || "-",
      topShares: topHolder?.shares || "-",
      latestDate: topHolder?.date || "-",
      url: topHolder?.url || secSearchUrl(ticker, "13F-HR")
    }
  };
}

async function secForm4Insight(ticker, cik) {
  const form4 = await secFormFilings(ticker, cik, ["4", "4/A"], 10);
  if (!form4.length) {
    return {
      value: "확인 필요",
      sub: "SEC Form 4 검색 연결",
      url: secSearchUrl(ticker, "4"),
      filings: []
    };
  }
  return {
    value: `${form4.length}건`,
    sub: `${form4[0].date} 최근 Form ${form4[0].form} · SEC submissions`,
    url: form4[0].url,
    filings: form4
  };
}

function usOwnershipInsight(ticker, overview, fmp, form4, fmpInsight = null, finraShort = null) {
  const institutionPct = formatPercentValue(overview?.PercentInstitutions);
  const insiderPct = formatPercentValue(overview?.PercentInsiders);
  const shortInterest = fmpShortInterest(fmpInsight) || alphaShortInterest(overview) || finraShort;
  const marketCap = numberField(overview?.MarketCapitalization || fmp?.profile?.marketCap);
  const sharesFloat = numberField(overview?.SharesFloat);
  const holders = fmpInstitutionalHolders(fmpInsight, ticker);
  return [
    {
      label: "기관 보유",
      value: institutionPct,
      sub: holders.length ? `${holders[0].holder} 등 ${holders.length}개 13F 보유자` : institutionPct === "-" ? "SEC 13F-HR 검색 연결" : "Alpha 보유율 · SEC 13F-HR 확인",
      url: secSearchUrl(ticker, "13F-HR"),
      source: holders.length ? "FMP 13F + SEC" : institutionPct === "-" ? "SEC" : "Alpha + SEC"
    },
    {
      label: "내부자",
      value: insiderPct === "-" ? form4.value : insiderPct,
      sub: insiderPct === "-" ? form4.sub : `${form4.sub} · Form 4`,
      url: form4.url || secSearchUrl(ticker, "4"),
      source: "Alpha + SEC Form 4"
    },
    {
      label: "공매도 비율",
      value: shortInterest?.value || "-",
      sub: shortInterest?.sub || "FINRA 원자료 확인 필요",
      url: shortInterest?.url || finraShortInterestUrl(ticker),
      source: shortInterest?.source || "FINRA 원자료 링크"
    },
    {
      label: "유통주식",
      value: sharesFloat === null ? "-" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(sharesFloat),
      sub: marketCap === null ? "Alpha Vantage" : `시총 ${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(marketCap)}`,
      url: overview?.OfficialSite || fmp?.profile?.website || "",
      source: "Alpha/FMP"
    }
  ];
}

async function alphaOverview(symbol) {
  if (!ALPHA_VANTAGE_API_KEY || !symbol || symbol.includes(".")) return null;
  const cacheKey = `alpha_overview_${symbol.toUpperCase()}`;
  const cached = await supplementalRead(cacheKey, 7 * DAY_MS);
  if (cached) return cached;
  const data = await fetchJson(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(ALPHA_VANTAGE_API_KEY)}`);
  if (!data || data.Note || data.Information || !data.Symbol) return null;
  return supplementalWrite(cacheKey, data);
}

async function alphaEarnings(symbol) {
  if (!ALPHA_VANTAGE_API_KEY || !symbol || symbol.includes(".")) return null;
  const cacheKey = `alpha_earnings_${symbol.toUpperCase()}`;
  const cached = await supplementalRead(cacheKey, 7 * DAY_MS);
  if (cached) return cached;
  const data = await fetchJson(`https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(ALPHA_VANTAGE_API_KEY)}`);
  if (!data || data.Note || data.Information || !data.symbol) return null;
  return supplementalWrite(cacheKey, data);
}

function isFmpError(data) {
  const text = JSON.stringify(data || {});
  return !data || /limit|invalid api key|not available|upgrade|premium|error/i.test(text);
}

async function fetchFmp(path, params = {}, cacheKey, maxAgeMs = DAY_MS) {
  if (!FMP_API_KEYS.length) return null;
  const cached = cacheKey ? await supplementalRead(cacheKey, maxAgeMs) : null;
  if (cached && !(Array.isArray(cached) && !cached.length && /^(profile|quote|income-statement|ratios-ttm|price-target-consensus|key-metrics-ttm)$/.test(path))) {
    return cached;
  }

  for (const key of FMP_API_KEYS) {
    const search = new URLSearchParams({ ...params, apikey: key });
    const url = `https://financialmodelingprep.com/stable/${path}?${search.toString()}`;
    try {
      const data = await fetchJson(url, "StockLens local scanner");
      if (isFmpError(data)) continue;
      return cacheKey ? supplementalWrite(cacheKey, data) : data;
    } catch {
      // Try the next FMP key before giving up.
    }
  }
  return null;
}

async function fetchFmpLegacy(path, params = {}, cacheKey, maxAgeMs = DAY_MS) {
  if (!FMP_API_KEYS.length) return null;
  const cached = cacheKey ? await supplementalRead(cacheKey, maxAgeMs) : null;
  if (cached) return cached;

  for (const key of FMP_API_KEYS) {
    const search = new URLSearchParams({ ...params, apikey: key });
    const url = `https://financialmodelingprep.com/api/${path}?${search.toString()}`;
    try {
      const data = await fetchJson(url, "StockLens local scanner");
      if (isFmpError(data)) continue;
      return cacheKey ? supplementalWrite(cacheKey, data) : data;
    } catch {
      // Try next key.
    }
  }
  return null;
}

async function fmpUsInsightBundle(symbol) {
  if (!FMP_API_KEYS.length || !symbol || symbol.includes(".")) return null;
  const upper = symbol.toUpperCase();
  const [shortQuote, insiderTrades, institutionalOwnership, institutionalHolders] = await Promise.all([
    fetchFmp("quote-short", { symbol: upper }, `fmp_quote_short_${upper}`, DAY_MS).catch(() => null),
    fetchFmp("insider-trading/search", { symbol: upper, page: "0", limit: "10" }, `fmp_insider_${upper}`, DAY_MS).catch(() => null),
    fetchFmpLegacy("v4/institutional-ownership/symbol-ownership", { symbol: upper, includeCurrentQuarter: "false" }, `fmp_inst_ownership_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmpLegacy(`v3/institutional-holder/${encodeURIComponent(upper)}`, {}, `fmp_inst_holder_${upper}`, 7 * DAY_MS).catch(() => null)
  ]);
  return { shortQuote, insiderTrades, institutionalOwnership, institutionalHolders };
}

async function fmpBundle(symbol) {
  if (!FMP_API_KEYS.length || !symbol || symbol.includes(".")) return null;
  const upper = symbol.toUpperCase();
  const cacheKey = `fmp_bundle_${upper}`;
  const cached = await supplementalRead(cacheKey, DAY_MS);
  if (fmpBundleHasExpandedCoverage(cached)) return cached;

  const [profile, quote, income, ratios, keyMetrics, balance, cashflow, estimates, targetConsensus] = await Promise.all([
    fetchFmp("profile", { symbol: upper }, `fmp_profile_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmp("quote", { symbol: upper }, `fmp_quote_${upper}`, DAY_MS).catch(() => null),
    fetchFmp("income-statement", { symbol: upper, period: "quarter", limit: "8" }, `fmp_income_q_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmp("ratios-ttm", { symbol: upper }, `fmp_ratios_ttm_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmp("key-metrics-ttm", { symbol: upper }, `fmp_key_metrics_ttm_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmp("balance-sheet-statement", { symbol: upper, period: "quarter", limit: "4" }, `fmp_balance_q_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmp("cash-flow-statement", { symbol: upper, period: "quarter", limit: "4" }, `fmp_cashflow_q_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmp("analyst-estimates", { symbol: upper, period: "quarter", page: "0", limit: "4" }, `fmp_estimates_q_${upper}`, 7 * DAY_MS).catch(() => null),
    fetchFmp("price-target-consensus", { symbol: upper }, `fmp_target_${upper}`, DAY_MS).catch(() => null)
  ]);
  const data = {
    schemaVersion: FMP_BUNDLE_SCHEMA_VERSION,
    profile: (Array.isArray(profile) ? profile[0] || null : profile) || cached?.profile || null,
    quote: (Array.isArray(quote) ? quote[0] || null : quote) || cached?.quote || null,
    income: Array.isArray(income) && income.length ? income : (cached?.income || []),
    ratios: (Array.isArray(ratios) ? ratios[0] || null : ratios) || cached?.ratios || null,
    keyMetrics: (Array.isArray(keyMetrics) ? keyMetrics[0] || null : keyMetrics) || cached?.keyMetrics || null,
    balance: Array.isArray(balance) && balance.length ? balance : (cached?.balance || []),
    cashflow: Array.isArray(cashflow) && cashflow.length ? cashflow : (cached?.cashflow || []),
    estimates: Array.isArray(estimates) && estimates.length ? estimates : (cached?.estimates || []),
    targetConsensus: (Array.isArray(targetConsensus) ? targetConsensus[0] || null : targetConsensus) || cached?.targetConsensus || null,
    source: sourceStatus("fmp", "ok")
  };
  if (!data.profile && !data.quote && !data.income.length && !data.ratios && !data.keyMetrics && !data.balance.length && !data.cashflow.length && !data.estimates.length && !data.targetConsensus) return null;
  return supplementalWrite(cacheKey, data);
}

async function dartFinance(ticker) {
  const corpCode = DART_CORP[ticker];
  if (!DART_API_KEY || !corpCode) return null;
  const cacheKey = `dart_finance_${ticker}`;
  const cached = await supplementalRead(cacheKey, 7 * DAY_MS);
  if (cached) return cached;
  const year = new Date().getFullYear() - 1;
  const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${encodeURIComponent(DART_API_KEY)}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011&fs_div=CFS`;
  const data = await fetchJson(url);
  if (!data || data.status !== "000" || !Array.isArray(data.list)) return null;
  return supplementalWrite(cacheKey, data);
}

function numberField(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-" || /^none|null|undefined|nan$/i.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function alphaFinanceIndicators(overview, fallbackRows) {
  if (!overview) return fallbackRows;
  const pe = numberField(overview.PERatio);
  const pb = numberField(overview.PriceToBookRatio);
  const roe = numberField(overview.ReturnOnEquityTTM);
  const eps = numberField(overview.EPS);
  const margin = numberField(overview.ProfitMargin);
  const marketCap = numberField(overview.MarketCapitalization);
  const target = numberField(overview.AnalystTargetPrice);
  return [
    { title: "PER", desc: "주가수익비율 · 낮을수록 저평가 가능성", value: pe === null ? "-" : pe.toFixed(1), status: pe === null ? "neutral" : pe <= 25 ? "good" : pe >= 45 ? "bad" : "neutral", dataStatus: pe === null ? "fallback" : "real", dataSource: "Alpha Vantage" },
    { title: "PBR", desc: "주가순자산비율", value: pb === null ? "-" : pb.toFixed(1), status: pb === null ? "neutral" : pb <= 3 ? "good" : "neutral", dataStatus: pb === null ? "fallback" : "real", dataSource: "Alpha Vantage" },
    { title: "ROE", desc: "자기자본이익률 · 17% 이상 선호", value: roe === null ? "-" : `${(roe * 100).toFixed(1)}%`, status: roe !== null && roe >= .17 ? "good" : "neutral", dataStatus: roe === null ? "fallback" : "real", dataSource: "Alpha Vantage" },
    { title: "EPS", desc: "최근 12개월 주당순이익", value: eps === null ? "-" : eps.toFixed(2), status: eps !== null && eps > 0 ? "good" : "neutral", dataStatus: eps === null ? "fallback" : "real", dataSource: "Alpha Vantage" },
    { title: "이익률", desc: "순이익률", value: margin === null ? "-" : `${(margin * 100).toFixed(1)}%`, status: margin !== null && margin >= .2 ? "good" : "neutral", dataStatus: margin === null ? "fallback" : "real", dataSource: "Alpha Vantage" },
    { title: "시가총액", desc: "기업 규모", value: marketCap === null ? "-" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(marketCap), status: "neutral", dataStatus: marketCap === null ? "fallback" : "real", dataSource: "Alpha Vantage" },
    { title: "증권사 목표가", desc: "Alpha Vantage 목표가", value: target === null ? "-" : target.toFixed(2), status: target !== null ? "good" : "neutral", dataStatus: target === null ? "fallback" : "real", dataSource: "Alpha Vantage" },
    { title: "통화", desc: "거래 통화", value: overview.Currency || "USD", status: "good", dataStatus: "real", dataSource: "Alpha Vantage" },
    { title: "데이터 출처", desc: "무료 Alpha Vantage 데이터", value: "Alpha Vantage", status: "good", dataStatus: "real", dataSource: "Alpha Vantage" }
  ];
}

function fmpTargetPrice(bundle) {
  const consensus = bundle?.targetConsensus || {};
  return numberField(consensus.targetConsensus)
    ?? numberField(consensus.targetMedian)
    ?? numberField(consensus.targetAverage)
    ?? numberField(bundle?.profile?.dcf)
    ?? null;
}

function fmpFinanceIndicators(bundle, fallbackRows) {
  if (!bundle) return fallbackRows;
  const profile = bundle.profile || {};
  const quote = bundle.quote || {};
  const ratios = bundle.ratios || {};
  const keyMetrics = bundle.keyMetrics || {};
  const latestIncome = bundle.income?.[0] || {};
  const previousIncome = bundle.income?.[1] || {};
  const latestBalance = bundle.balance?.[0] || {};
  const latestCashflow = bundle.cashflow?.[0] || {};
  const pe = numberField(quote.pe) ?? numberField(ratios.priceToEarningsRatioTTM);
  const pb = numberField(ratios.priceToBookRatioTTM);
  const roe = numberField(ratios.returnOnEquityTTM);
  const eps = numberField(quote.eps) ?? numberField(ratios.netIncomePerShareTTM);
  const margin = numberField(ratios.netProfitMarginTTM);
  const debtEquity = numberField(ratios.debtEquityRatioTTM);
  const marketCap = numberField(profile.mktCap) ?? numberField(quote.marketCap);
  const target = fmpTargetPrice(bundle);
  const currency = profile.currency || quote.currency || "USD";
  const evToEbitda = numberField(keyMetrics.enterpriseValueOverEBITDATTM) ?? numberField(keyMetrics.evToEbitdaTTM);
  const fcfYield = numberField(keyMetrics.freeCashFlowYieldTTM);
  const currentAssets = numberField(latestBalance.totalCurrentAssets);
  const currentLiabilities = numberField(latestBalance.totalCurrentLiabilities);
  const currentRatio = currentAssets !== null && currentLiabilities ? currentAssets / currentLiabilities : numberField(ratios.currentRatioTTM);
  const freeCashFlow = numberField(latestCashflow.freeCashFlow)
    ?? ((numberField(latestCashflow.operatingCashFlow) ?? numberField(latestCashflow.netCashProvidedByOperatingActivities)) !== null
      ? (numberField(latestCashflow.operatingCashFlow) ?? numberField(latestCashflow.netCashProvidedByOperatingActivities)) - Math.abs(numberField(latestCashflow.capitalExpenditure) ?? 0)
      : null);
  const revenue = numberField(latestIncome.revenue);
  const previousRevenue = numberField(previousIncome.revenue);
  const revenueGrowth = revenue !== null && previousRevenue ? (revenue / previousRevenue) - 1 : null;
  const compact = (value) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const rows = [
    { title: "PER", desc: "주가수익비율 · 낮을수록 저평가 가능성", value: pe === null ? "-" : pe.toFixed(1), status: pe === null ? "neutral" : pe <= 25 ? "good" : pe >= 45 ? "bad" : "neutral", dataStatus: pe === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "PBR", desc: "주가순자산비율", value: pb === null ? "-" : pb.toFixed(1), status: pb === null ? "neutral" : pb <= 3 ? "good" : "neutral", dataStatus: pb === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "ROE", desc: "자기자본이익률 · 17% 이상 선호", value: roe === null ? "-" : `${(roe * 100).toFixed(1)}%`, status: roe !== null && roe >= .17 ? "good" : roe !== null ? "bad" : "neutral", dataStatus: roe === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "EPS", desc: "최근 12개월 주당순이익", value: eps === null ? "-" : eps.toFixed(2), status: eps !== null && eps > 0 ? "good" : "neutral", dataStatus: eps === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "매출 성장", desc: "최근 분기 매출 전분기 대비", value: revenueGrowth === null ? "-" : `${(revenueGrowth * 100).toFixed(1)}%`, status: revenueGrowth !== null && revenueGrowth >= .1 ? "good" : revenueGrowth !== null && revenueGrowth < 0 ? "bad" : "neutral", dataStatus: revenueGrowth === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "이익률", desc: "순이익률", value: margin === null ? "-" : `${(margin * 100).toFixed(1)}%`, status: margin !== null && margin >= .2 ? "good" : "neutral", dataStatus: margin === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "부채비율", desc: "부채/자본", value: debtEquity === null ? "-" : `${(debtEquity * 100).toFixed(1)}%`, status: debtEquity !== null && debtEquity <= 1 ? "good" : debtEquity !== null && debtEquity >= 2 ? "bad" : "neutral", dataStatus: debtEquity === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "유동비율", desc: "단기 지급능력 · 1.5 이상 선호", value: currentRatio === null ? "-" : currentRatio.toFixed(2), status: currentRatio !== null && currentRatio >= 1.5 ? "good" : currentRatio !== null && currentRatio < 1 ? "bad" : "neutral", dataStatus: currentRatio === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "FCF", desc: "최근 분기 잉여현금흐름", value: freeCashFlow === null ? "-" : compact(freeCashFlow), status: freeCashFlow !== null && freeCashFlow > 0 ? "good" : freeCashFlow !== null ? "bad" : "neutral", dataStatus: freeCashFlow === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "FCF Yield", desc: "잉여현금흐름 수익률", value: fcfYield === null ? "-" : `${(fcfYield * 100).toFixed(1)}%`, status: fcfYield !== null && fcfYield >= .03 ? "good" : "neutral", dataStatus: fcfYield === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "EV/EBITDA", desc: "기업가치 대비 영업현금창출력", value: evToEbitda === null ? "-" : evToEbitda.toFixed(1), status: evToEbitda !== null && evToEbitda <= 18 ? "good" : evToEbitda !== null && evToEbitda >= 30 ? "bad" : "neutral", dataStatus: evToEbitda === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "시가총액", desc: "기업 규모", value: marketCap === null ? "-" : compact(marketCap), status: "neutral", dataStatus: marketCap === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "증권사 목표가", desc: "FMP 컨센서스 목표가", value: target === null ? "-" : target.toFixed(2), status: target !== null ? "good" : "neutral", dataStatus: target === null ? "fallback" : "real", dataSource: "FMP" },
    { title: "통화", desc: "거래 통화", value: currency, status: "good", dataStatus: "real", dataSource: "FMP" },
    { title: "데이터 출처", desc: "무료 FMP 데이터", value: "FMP", status: "good", dataStatus: "real", dataSource: "FMP" }
  ];
  return rows;
}

function hasRealFinanceIndicator(rows) {
  return (rows || []).some((row) => row.dataStatus === "real" && row.title !== "통화" && row.title !== "데이터 출처");
}

function mergeFinanceIndicators(primaryRows, fallbackRows) {
  const fallbackByTitle = new Map((fallbackRows || []).map((row) => [String(row.title || "").toUpperCase(), row]));
  return (primaryRows || []).map((row) => {
    const fallback = fallbackByTitle.get(String(row.title || "").toUpperCase());
    const missing = row.dataStatus !== "real" || ["-", "", null, undefined].includes(row.value);
    return missing && fallback?.dataStatus === "real" ? fallback : row;
  });
}

function alphaEarningsRows(earnings) {
  const rows = earnings?.quarterlyEarnings || [];
  return rows.slice(0, 4).map((row) => {
    const surprise = numberField(row.surprisePercentage);
    return [
      row.reportedDate || row.fiscalDateEnding || "-",
      surprise === null ? true : surprise >= 0,
      surprise === null ? "-" : `${surprise >= 0 ? "+" : ""}${surprise.toFixed(1)}%`,
      `EPS ${row.reportedEPS || "-"}`,
      `Est ${row.estimatedEPS || "-"}`
    ];
  });
}

function fmpEarningsRows(bundle) {
  const estimates = bundle?.estimates || [];
  const income = bundle?.income || [];
  if (estimates.length) {
    return estimates.slice(0, 4).map((row) => {
      const actual = numberField(row.actualEps ?? row.epsActual ?? row.reportedEps);
      const estimate = numberField(row.estimatedEpsAvg ?? row.estimatedEps ?? row.epsEstimated);
      const surprise = actual !== null && estimate ? ((actual / estimate) - 1) * 100 : null;
      return [
        row.date || row.fiscalDateEnding || row.period || "-",
        surprise === null ? true : surprise >= 0,
        surprise === null ? "-" : `${surprise >= 0 ? "+" : ""}${surprise.toFixed(1)}%`,
        `EPS ${actual === null ? "-" : actual.toFixed(2)}`,
        `Est ${estimate === null ? "-" : estimate.toFixed(2)}`
      ];
    });
  }
  return income.slice(0, 4).map((row, index) => {
    const eps = numberField(row.eps ?? row.epsdiluted);
    const previous = numberField(income[index + 1]?.eps ?? income[index + 1]?.epsdiluted);
    const growth = eps !== null && previous ? ((eps / previous) - 1) * 100 : null;
    return [
      row.date || row.calendarYear || "-",
      growth === null ? true : growth >= 0,
      growth === null ? "-" : `${growth >= 0 ? "+" : ""}${growth.toFixed(1)}%`,
      `EPS ${eps === null ? "-" : eps.toFixed(2)}`,
      "FMP"
    ];
  });
}

function chartRows(rows, count = 120, currentPrice = null) {
  const output = rows.slice(-count).map((row) => ({
    date: row.date,
    close: Number(row.close.toFixed(2)),
    volume: Number(row.volume || 0)
  }));
  if (Number.isFinite(currentPrice) && output.length) {
    output[output.length - 1] = {
      ...output[output.length - 1],
      close: Number(currentPrice.toFixed(2))
    };
  }
  return output;
}

function replaceFactor(factors, code, nextFactor) {
  return factors.map((factor) => factor.code === code ? nextFactor : factor);
}

function rebuildCanslimViews(scored, factors) {
  const totalWeight = factors.reduce((sum, item) => sum + item.weight, 0);
  const weightedScore = totalWeight ? factors.reduce((sum, item) => sum + item.normalizedScore * item.weight, 0) / totalWeight : scored.canSlimScore;
  const nextCanSlim = clamp(weightedScore);
  const previousCanSlim = Number(scored.canSlimScore || 0);
  const delta = nextCanSlim - previousCanSlim;
  scored.canSlimScore = nextCanSlim;
  scored.score = clamp(Number(scored.score || 0) + delta * .48);
  scored.conviction = scored.score >= 75 && scored.entry >= 60 ? "높음" : scored.score >= 60 && scored.entry >= 45 ? "보통" : "낮음";
  scored.subPoint = `TotalScore ${scored.score} · EntryScore ${scored.entry} · RSRating ${scored.rsRating}`;
  scored.canslimFactors = factors;
  scored.canslim = factors.slice(0, 6).map((item) => [item.code, item.body, item.status === "good" ? true : item.status === "bad" ? false : null]);
  scored.support = factors.slice(6).map((item) => [item.code, item.body, item.status === "good" ? true : item.status === "bad" ? false : null])
    .concat((scored.support || []).filter((item) => item[0] !== "M"));
}

function applyAlphaCanslim(scored, overview, earnings) {
  if (!overview && !earnings?.quarterlyEarnings?.length) return scored;

  let factors = [...(scored.canslimFactors || [])];
  const qGrowth = numberField(overview?.QuarterlyEarningsGrowthYOY);
  const quarterly = earnings?.quarterlyEarnings || [];
  const latest = quarterly[0] || {};
  const previous = quarterly[1] || {};
  const latestEps = numberField(latest.reportedEPS);
  const priorEps = numberField(previous.reportedEPS);
  const latestSurprise = numberField(latest.surprisePercentage);
  const priorSurprise = numberField(previous.surprisePercentage);
  const epsGrowthPct = qGrowth !== null ? qGrowth * 100 : latestEps !== null && priorEps ? ((latestEps / priorEps) - 1) * 100 : null;

  if (epsGrowthPct !== null) {
    const accelerating = latestSurprise !== null && priorSurprise !== null ? latestSurprise > priorSurprise : epsGrowthPct >= 25;
    const cRaw = Math.max(0, epsGrowthPct);
    const cScore = normalizePositive(cRaw, 60);
    factors = replaceFactor(factors, "C", canslimFactor({
      code: "C",
      title: "EPS 가속도",
      desc: "분기 순이익 성장",
      rawScore: cRaw,
      normalizedScore: cScore,
      displayValue: cScore,
      barValue: cScore,
      weight: 6,
      status: cScore >= 70 ? "good" : cScore < 40 ? "bad" : "neutral",
      dataStatus: "real",
      dataSource: "Alpha Vantage",
      body: `최근 분기 EPS 성장률은 ${epsGrowthPct >= 0 ? "+" : ""}${epsGrowthPct.toFixed(1)}%입니다. ${accelerating ? "어닝 서프라이즈 흐름은 개선 중입니다." : "가속 흐름은 아직 강하지 않습니다."}`,
      inputs: [`EPS 성장률: ${epsGrowthPct >= 0 ? "+" : ""}${epsGrowthPct.toFixed(1)}%`, `최근 EPS: ${latestEps ?? "-"}`, `어닝 서프라이즈: ${latestSurprise === null ? "-" : `${latestSurprise.toFixed(1)}%`}`],
      calculation: [`원점수: ${cRaw.toFixed(1)}`, `정규화: ${cScore.toFixed(1)}/100`, "가중치: 6.0%"]
    }));
  }

  const roe = numberField(overview?.ReturnOnEquityTTM);
  if (roe !== null) {
    const roePct = roe > 3 ? roe : roe * 100;
    const aRaw = roePct >= 17 ? 20 : -12;
    const aScore = normalizeSigned(aRaw);
    factors = replaceFactor(factors, "A", canslimFactor({
      code: "A",
      title: "연간 ROE 실적",
      desc: "수익성 기준",
      rawScore: aRaw,
      normalizedScore: aScore,
      displayValue: aScore,
      barValue: aScore,
      weight: 5,
      status: roePct >= 17 ? "good" : "bad",
      dataStatus: "real",
      dataSource: "Alpha Vantage",
      body: `자기자본이익률(ROE)은 ${roePct.toFixed(1)}%입니다. ${roePct >= 17 ? "기준 17%를 통과했습니다." : "기준 17%에 미달합니다."}`,
      inputs: [`ROE: ${roePct.toFixed(1)}%`, `ROE 기준 통과: ${roePct >= 17 ? "예" : "아니오"}`],
      calculation: [`원점수: ${aRaw.toFixed(1)}`, `정규화: ${aScore.toFixed(1)}/100`, "가중치: 5.0%"]
    }));
  }

  rebuildCanslimViews(scored, factors);
  return scored;
}

function applyFmpCanslim(scored, bundle) {
  if (!bundle) return scored;

  let factors = [...(scored.canslimFactors || [])];
  const income = bundle.income || [];
  const latest = income[0] || {};
  const previous = income[1] || {};
  const latestEps = numberField(latest.eps ?? latest.epsdiluted);
  const priorEps = numberField(previous.eps ?? previous.epsdiluted);
  const epsGrowthPct = latestEps !== null && priorEps ? ((latestEps / priorEps) - 1) * 100 : null;

  if (epsGrowthPct !== null) {
    const cRaw = Math.max(0, epsGrowthPct);
    const cScore = normalizePositive(cRaw, 60);
    factors = replaceFactor(factors, "C", canslimFactor({
      code: "C",
      title: "EPS 가속도",
      desc: "분기 순이익 성장",
      rawScore: cRaw,
      normalizedScore: cScore,
      weight: 6,
      status: cScore >= 70 ? "good" : cScore < 40 ? "bad" : "neutral",
      dataStatus: "real",
      dataSource: "FMP",
      body: `최근 분기 EPS 성장률은 ${epsGrowthPct >= 0 ? "+" : ""}${epsGrowthPct.toFixed(1)}%입니다. FMP 분기 손익계산서 기준으로 계산했습니다.`,
      inputs: [`최근 EPS: ${latestEps?.toFixed?.(2) ?? "-"}`, `직전 EPS: ${priorEps?.toFixed?.(2) ?? "-"}`, `EPS 성장률: ${epsGrowthPct >= 0 ? "+" : ""}${epsGrowthPct.toFixed(1)}%`],
      calculation: [`원점수: ${cRaw.toFixed(1)}`, `정규화: ${cScore.toFixed(1)}/100`, "가중치: 6.0%"]
    }));
  }

  const roe = numberField(bundle.ratios?.returnOnEquityTTM);
  if (roe !== null) {
    const roePct = roe > 3 ? roe : roe * 100;
    const aRaw = roePct >= 17 ? 20 : -12;
    const aScore = normalizeSigned(aRaw);
    factors = replaceFactor(factors, "A", canslimFactor({
      code: "A",
      title: "연간 ROE 실적",
      desc: "수익성 기준",
      rawScore: aRaw,
      normalizedScore: aScore,
      weight: 5,
      status: roePct >= 17 ? "good" : "bad",
      dataStatus: "real",
      dataSource: "FMP",
      body: `자기자본이익률(ROE)은 ${roePct.toFixed(1)}%입니다. ${roePct >= 17 ? "기준 17%를 통과했습니다." : "기준 17%에 미달합니다."}`,
      inputs: [`ROE: ${roePct.toFixed(1)}%`, `ROE 기준 통과: ${roePct >= 17 ? "예" : "아니오"}`],
      calculation: [`원점수: ${aRaw.toFixed(1)}`, `정규화: ${aScore.toFixed(1)}/100`, "가중치: 5.0%"]
    }));
  }

  rebuildCanslimViews(scored, factors);
  return scored;
}

function dartFinanceIndicators(dart, fallbackRows) {
  const list = dart?.list || [];
  if (!list.length) return fallbackRows;
  const find = (pattern) => list.find((item) => pattern.test(item.account_nm || ""));
  const assets = numberField(find(/자산|Assets/i)?.thstrm_amount);
  const liabilities = numberField(find(/부채|Liabilities/i)?.thstrm_amount);
  const equity = numberField(find(/자본|Equity/i)?.thstrm_amount);
  const revenue = numberField(find(/매출|Revenue|Sales/i)?.thstrm_amount);
  const income = numberField(find(/영업이익|Operating/i)?.thstrm_amount);
  const profit = numberField(find(/당기순이익|Profit|Income/i)?.thstrm_amount);
  const debtRatio = equity ? (liabilities / equity) * 100 : null;
  const opMargin = revenue ? (income / revenue) * 100 : null;
  const netMargin = revenue ? (profit / revenue) * 100 : null;
  return [
    { title: "Assets", desc: "DART latest financial statement", value: assets === null ? "-" : Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(assets), status: "neutral" },
    { title: "Liabilities", desc: "DART latest financial statement", value: liabilities === null ? "-" : Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(liabilities), status: debtRatio !== null && debtRatio < 150 ? "good" : "neutral" },
    { title: "Equity", desc: "DART latest financial statement", value: equity === null ? "-" : Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(equity), status: "neutral" },
    { title: "Debt Ratio", desc: "Liabilities / equity", value: debtRatio === null ? "-" : `${debtRatio.toFixed(1)}%`, status: debtRatio !== null && debtRatio <= 100 ? "good" : debtRatio !== null && debtRatio >= 200 ? "bad" : "neutral" },
    { title: "Revenue", desc: "DART revenue", value: revenue === null ? "-" : Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(revenue), status: "neutral" },
    { title: "Operating Margin", desc: "Operating income / revenue", value: opMargin === null ? "-" : `${opMargin.toFixed(1)}%`, status: opMargin !== null && opMargin >= 10 ? "good" : "neutral" },
    { title: "Net Margin", desc: "Net income / revenue", value: netMargin === null ? "-" : `${netMargin.toFixed(1)}%`, status: netMargin !== null && netMargin >= 8 ? "good" : "neutral" },
    { title: "Data Source", desc: "DART free API", value: "DART", status: "good" }
  ];
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function newsToneScore(title) {
  const text = String(title || "");
  const positive = [
    ["호실적", 3], ["어닝 서프라이즈", 3], ["상향", 2], ["목표가 상향", 3], ["매수", 2],
    ["급등", 2], ["상승", 1], ["최고", 1], ["강세", 1], ["돌파", 1],
    ["성장", 1], ["확대", 1], ["수주", 2], ["흑자", 2], ["호재", 2], ["긍정", 1]
  ];
  const negative = [
    ["실적 부진", 3], ["어닝 쇼크", 3], ["하향", 2], ["목표가 하향", 3], ["매도", 2],
    ["급락", 2], ["하락", 1], ["약세", 1], ["소송", 2], ["규제", 2],
    ["리콜", 3], ["감원", 2], ["우려", 1], ["악재", 2], ["손실", 2], ["경고", 2]
  ];
  const score = positive.reduce((sum, [word, weight]) => sum + (text.includes(word) ? weight : 0), 0)
    - negative.reduce((sum, [word, weight]) => sum + (text.includes(word) ? weight : 0), 0);
  const reason = score > 0
    ? "긍정 키워드 우세"
    : score < 0
      ? "부정 키워드 우세"
      : "강한 감성 키워드 없음";
  return {
    tone: score >= 2 ? "good" : score <= -2 ? "bad" : "neutral",
    score,
    reason
  };
}

function newsTone(title) {
  return newsToneScore(title).tone;
}

function newsConfidence(items, positive, negative) {
  if (!items.length) return "데이터 없음";
  const signalGap = Math.abs(positive - negative);
  if (items.length >= 8 && signalGap >= 3) return "높음";
  if (items.length >= 5) return "보통";
  return "낮음";
}

async function koreanNewsInsight(meta) {
  const ticker = meta.ticker.toUpperCase();
  const cacheKey = `kr_news_${ticker}`;
  const cached = await supplementalRead(cacheKey, 3 * 60 * 60 * 1000);
  if (cached) return cached;
  const query = `${meta.company || ticker} ${ticker} 주가`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  try {
    const rss = await fetchText(url, "Mozilla/5.0 StockLens local scanner");
    const seen = new Set();
    const items = [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
      const item = match[1];
      const title = decodeHtmlEntities(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
      const link = decodeHtmlEntities(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "");
      const source = decodeHtmlEntities(item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "");
      const tone = newsToneScore(title);
      return {
        title: source && !title.includes(source) ? `${title} · ${source}` : title,
        tone: tone.tone,
        score: tone.score,
        reason: tone.reason,
        url: link || `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`
      };
    }).filter((item) => {
      const key = item.title.replace(/\s+/g, " ").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
    const positive = items.filter((item) => item.tone === "good").length;
    const negative = items.filter((item) => item.tone === "bad").length;
    const neutral = Math.max(0, items.length - positive - negative);
    const result = {
      items,
      positive,
      neutral,
      negative,
      label: positive > negative ? "긍정" : negative > positive ? "주의" : "중립",
      source: "Google News RSS",
      method: "한글 Google News RSS 제목을 가중 키워드로 점수화하고 중복 제목을 제거",
      confidence: newsConfidence(items, positive, negative)
    };
    return supplementalWrite(cacheKey, result);
  } catch {
    return null;
  }
}

async function enrichDetail(meta, rows, scored) {
  const isKr = meta.market === "kr" || meta.yf_symbol.endsWith(".KS") || meta.yf_symbol.endsWith(".KQ");
  const isEtf = meta.asset_type === "etf";
  const canUseStockFundamentals = !isKr && !isEtf;
  const [fmp, overview, earnings, dart] = await Promise.all([
    canUseStockFundamentals ? fmpBundle(meta.ticker).catch(() => null) : null,
    canUseStockFundamentals ? alphaOverview(meta.ticker).catch(() => null) : null,
    canUseStockFundamentals ? alphaEarnings(meta.ticker).catch(() => null) : null,
    isKr ? dartFinance(meta.ticker).catch(() => null) : null
  ]);
  const cik = canUseStockFundamentals ? cikFromSources(meta, overview, fmp) : "";
  const [filings, form4, fmpInsight, finraShort, newsInsight] = await Promise.all([
    canUseStockFundamentals ? secFilings(meta.ticker, cik) : { items: [], source: sourceStatus("sec", "unavailable") },
    canUseStockFundamentals ? secForm4Insight(meta.ticker, cik) : null,
    canUseStockFundamentals ? fmpUsInsightBundle(meta.ticker).catch(() => null) : null,
    canUseStockFundamentals ? finraShortInterest(meta.ticker).catch(() => null) : null,
    canUseStockFundamentals ? koreanNewsInsight(meta).catch(() => null) : null
  ]);
  const dartStatus = dartSourceStatus(isKr, dart);
  if (fmp?.quote) {
    const quotePrice = numberField(fmp.quote.price);
    const quoteChange = numberField(fmp.quote.changePercentage);
    if (quotePrice) {
      scored.price = Number(quotePrice.toFixed(2));
      scored.tradePlan.buy = Number(quotePrice.toFixed(2));
      scored.dataSource = "fmp";
    }
    if (quoteChange !== null) scored.change = Number(quoteChange.toFixed(2));
  }
  if (canUseStockFundamentals && overview) {
    applyAlphaCanslim(scored, overview, earnings);
  }
  let payload = indicatorPayload(meta, rows, scored);
  if (canUseStockFundamentals && fmp) {
    applyFmpCanslim(scored, fmp);
    payload = indicatorPayload(meta, rows, scored);
    const fmpFinance = fmpFinanceIndicators(fmp, payload.financeIndicators);
    const alphaFinance = overview ? alphaFinanceIndicators(overview, payload.financeIndicators) : [];
    payload.financeIndicators = hasRealFinanceIndicator(fmpFinance)
      ? mergeFinanceIndicators(fmpFinance, alphaFinance)
      : overview
        ? alphaFinance
        : fmpFinance;
    const target = fmpTargetPrice(fmp);
    if (target) {
      scored.finance.target = Number(target.toFixed(2));
      scored.finance.targetGap = Number(((target / scored.price - 1) * 100).toFixed(1));
      scored.tradePlan.analystTarget = Number(target.toFixed(2));
    }
  } else if (canUseStockFundamentals && overview) {
    payload.financeIndicators = alphaFinanceIndicators(overview, payload.financeIndicators);
    const target = numberField(overview.AnalystTargetPrice);
    if (target) {
      scored.finance.target = Number(target.toFixed(2));
      scored.finance.targetGap = Number(((target / scored.price - 1) * 100).toFixed(1));
      scored.tradePlan.analystTarget = Number(target.toFixed(2));
    }
  }
  if (dart) {
    payload.financeIndicators = dartFinanceIndicators(dart, payload.financeIndicators);
  }
  payload.quantFactors = buildQuantMathFactors(meta, rows, scored);
  const dataCrossChecks = buildDataCrossChecks({ meta, rows, scored, fmp, overview });
  const anomalyWarnings = buildAnomalyWarnings({ meta, rows, scored, fmp, overview });
  const issueCount = dataCrossChecks.warnCount + anomalyWarnings.filter((item) => item.level !== "info").length;
  const fmpRows = fmp ? fmpEarningsRows(fmp) : [];
  const earningsRows = fmpRows.length ? fmpRows : alphaEarningsRows(earnings);
  const sources = {
    price: sourceStatus(scored.dataSource || "price", "ok"),
    fmp: sourceStatus("fmp", canUseStockFundamentals ? fmpSourceStatus(fmp) : "unavailable"),
    alphaVantage: sourceStatus("alphaVantage", canUseStockFundamentals ? alphaSourceStatus(overview, earnings) : "unavailable"),
    dart: sourceStatus("dart", dartStatus),
    sec: sourceStatus("sec", secSourceStatus(isKr, filings)),
    finra: sourceStatus("finra", canUseStockFundamentals ? (finraShort ? "ok" : "partial") : "unavailable")
  };
  const hasFmpEarnings = fmpRows.length > 0;
  const hasAlphaEarnings = !hasFmpEarnings && alphaEarningsRows(earnings).length > 0;
  const earningsSourceText = hasFmpEarnings ? "FMP 어닝 데이터" : hasAlphaEarnings ? "Alpha Vantage 어닝 데이터" : "어닝 데이터 없음";
  return {
    ...scored,
    ...payload,
    sourceStatus: sources,
    trust: trustSummary(sources, { issueCount }),
    dataCrossChecks,
    anomalyWarnings,
    chart: chartRows(rows, 120, scored.price).map((row) => row.close),
    chartRows: chartRows(rows, 120, scored.price),
    usInsight: isKr ? null : {
      earningsDate: "API 연결 필요",
      earnings: earningsRows.length ? earningsRows : [
        ["최근", scored.entry >= 45, scored.finance.targetGap >= 0 ? `+${scored.finance.targetGap}%` : `${scored.finance.targetGap}%`, `현재가 ${scored.price}`, `목표가 ${scored.finance.target}`]
      ],
      ownership: usOwnershipInsight(meta.ticker, overview, fmp, form4 || { value: "-", sub: "Form 4 없음", url: secSearchUrl(meta.ticker, "4") }, fmpInsight, finraShort),
      sentiment: {
        label: newsInsight?.label || (scored.entry >= 45 ? "중립" : "주의"),
        positive: newsInsight?.positive ?? (scored.entry >= 60 ? 6 : 3),
        neutral: newsInsight?.neutral ?? 4,
        negative: newsInsight?.negative ?? (scored.entry < 40 ? 3 : 1),
        method: newsInsight?.method || "가격/거래량 기반 대체 감성 추정",
        confidence: newsInsight?.confidence || (newsInsight?.items?.length ? "낮음" : "대체 계산"),
        source: newsInsight?.source || "모델 대체값",
        summary: `${meta.ticker}는 가격과 거래량 기준으로 TotalScore ${scored.score}, EntryScore ${scored.entry}입니다. ${newsInsight?.source ? `대표 한글 뉴스 ${newsInsight.items.length}건을 함께 확인했습니다.` : canUseStockFundamentals ? earningsSourceText : "ETF는 가격·추세 중심으로 평가합니다."}${fmp ? " FMP 무료 API로 재무·목표가 데이터를 보강했습니다." : overview ? " Alpha Vantage 무료 API로 재무 데이터를 보강했습니다." : ""}`,
        items: newsInsight?.items?.length ? newsInsight.items : [
          { title: `${meta.ticker} 가격 추세와 어닝 일정 확인`, tone: "neutral", url: `https://news.google.com/search?q=${encodeURIComponent(`${meta.ticker} 주가 어닝`)}` },
          { title: `${meta.ticker} 목표가 괴리율 ${scored.finance.targetGap}%`, tone: scored.finance.targetGap > 5 ? "good" : "neutral", url: `https://news.google.com/search?q=${encodeURIComponent(`${meta.ticker} 목표가`)}` },
          { title: `${meta.ticker} RSI ${scored.finance.rsi}`, tone: scored.finance.rsi > 70 ? "bad" : "neutral", url: `https://news.google.com/search?q=${encodeURIComponent(`${meta.ticker} RSI`)}` }
        ]
      },
      analysts: [
        [fmp ? "FMP 컨센서스" : overview ? "Alpha Vantage" : "ATR 모델", scored.entry >= 45 ? "관망" : "주의", `${scored.price} -> ${scored.finance.target}`],
        ["추세 모델", scored.score >= 70 ? "시장 상회" : "중립", `RS ${scored.rsRating}`],
        ["진입 모델", scored.entry >= 60 && scored.entry < 75 ? "눌림 후보" : scored.entry >= 75 ? "강세 확인" : "대기", `진입점수 ${scored.entry}`]
      ],
      institutionalHolders: fmpInstitutionalHolders(fmpInsight, meta.ticker),
      insiderFilings: fmpInsiderFilings(fmpInsight, form4?.filings || []),
      filingSummary: secStructureSummary({ ticker: meta.ticker, filings, form4, fmpInsight }),
      filings
    },
    krInsight: isKr ? {
      sentiment: {
        label: "중립",
        positive: scored.entry >= 60 ? 5 : 3,
        neutral: 8,
        negative: scored.entry < 40 ? 3 : 1,
        summary: `${meta.company}는 가격과 거래량 기준으로 TotalScore ${scored.score}, EntryScore ${scored.entry}입니다.${dart ? " OpenDART 무료 API로 공시·재무 데이터를 보강했습니다." : ""}`,
        items: [
          [`${meta.company} 실적과 수급 뉴스 확인`, "neutral"],
          [`${meta.company} 최근 공시 DART에서 확인`, "good"],
          [`${meta.company} RSI ${scored.finance.rsi}`, scored.finance.rsi > 70 ? "bad" : "neutral"]
        ]
      },
      earnings: [
        ["최근", scored.entry >= 45, scored.finance.targetGap >= 0 ? `+${scored.finance.targetGap}%` : `${scored.finance.targetGap}%`, `현재가 ${scored.price}`, `목표가 ${scored.finance.target}`]
      ],
      filings: {
        items: [{ date: "DART", form: "\uacf5\uc2dc\uac80\uc0c9", title: "\ucd5c\uadfc \uacf5\uc2dc \ubcf4\uae30", url: dartDisclosureLink(meta.company) }],
        source: sourceStatus("dart", dartStatus)
      }
    } : null
  };
}

async function enrichListSummary(scored) {
  const baseSources = {
    price: sourceStatus(scored.dataSource || "price", Number.isFinite(Number(scored.price)) ? "ok" : "missing"),
    fmp: sourceStatus("fmp", "unavailable"),
    alphaVantage: sourceStatus("alphaVantage", "unavailable"),
    dart: sourceStatus("dart", scored.market === "kr" ? "fallback" : "unavailable"),
    sec: sourceStatus("sec", scored.market === "kr" ? "unavailable" : "fallback")
  };
  scored.sourceStatus = baseSources;
  scored.trust = trustSummary(baseSources);
  if (scored.market !== "us" || scored.asset_type === "etf") return scored;
  const symbol = scored.ticker.toUpperCase();
  const bundle = await supplementalRead(`fmp_bundle_${symbol}`, DAY_MS).catch(() => null);
  const overview = await supplementalRead(`alpha_overview_${symbol}`, 7 * DAY_MS).catch(() => null);
  const earnings = await supplementalRead(`alpha_earnings_${symbol}`, 7 * DAY_MS).catch(() => null);
  const quoteCache = await supplementalRead(`fmp_quote_${symbol}`, DAY_MS).catch(() => null);
  const quote = bundle?.quote || (Array.isArray(quoteCache) ? quoteCache[0] : quoteCache);
  const target = fmpTargetPrice(bundle);

  if (quote) {
    const quotePrice = numberField(quote.price);
    const quoteChange = numberField(quote.changePercentage);
    if (quotePrice) {
      scored.price = Number(quotePrice.toFixed(2));
      scored.tradePlan.buy = Number(quotePrice.toFixed(2));
      scored.dataSource = "fmp";
    }
    if (quoteChange !== null) scored.change = Number(quoteChange.toFixed(2));
  }
  if (overview || earnings?.quarterlyEarnings?.length) {
    applyAlphaCanslim(scored, overview, earnings);
  }
  if (bundle) {
    applyFmpCanslim(scored, bundle);
  }
  if (target) {
    scored.finance.target = Number(target.toFixed(2));
    scored.finance.targetGap = Number(((target / scored.price - 1) * 100).toFixed(1));
    scored.tradePlan.analystTarget = Number(target.toFixed(2));
  }
  const listSources = {
    price: sourceStatus(scored.dataSource || "price", Number.isFinite(Number(scored.price)) ? "ok" : "missing"),
    fmp: sourceStatus("fmp", fmpSourceStatus(bundle)),
    alphaVantage: sourceStatus("alphaVantage", alphaSourceStatus(overview, earnings)),
    dart: sourceStatus("dart", "unavailable"),
    sec: sourceStatus("sec", "fallback")
  };
  scored.sourceStatus = listSources;
  scored.trust = trustSummary(listSources);
  return scored;
}

async function cacheRead(key, minRows = 1) {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  if (!raw.rows?.length) return null;
  if (raw.rows.length < minRows) return null;
  if (Date.now() - raw.savedAt > PRICE_CACHE_MS) return null;
  const rows = raw.rows;
  if (raw.source) rows.source = raw.source;
  return rows;
}

async function cacheWrite(key, rows, source = "cache") {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify({ savedAt: Date.now(), source, rows }));
  } catch (error) {
    if (error?.code === "EROFS" || error?.code === "EACCES" || error?.code === "EPERM") return;
    throw error;
  }
}

async function fetchText(url, userAgent = SEC_USER_AGENT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "application/json,text/plain,*/*" },
      signal: controller.signal,
      redirect: "follow"
    });
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, userAgent = SEC_USER_AGENT) {
  const text = await fetchText(url, userAgent);
  return JSON.parse(text);
}

async function supplementalRead(key, maxAgeMs = DAY_MS) {
  try {
    const raw = JSON.parse((await readFile(join(CACHE_DIR, `${key}.json`), "utf8")).replace(/^\uFEFF/, ""));
    if (!raw.savedAt || Date.now() - raw.savedAt > maxAgeMs) return null;
    return raw.data;
  } catch {
    return null;
  }
}

async function supplementalWrite(key, data) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify({ savedAt: Date.now(), data }));
  } catch (error) {
    if (error?.code !== "EROFS" && error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
  }
  return data;
}

function yahooRows(data) {
  const result = data.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote || !timestamps.length) throw new Error("No Yahoo data");
  return timestamps.map((time, index) => ({
    date: new Date(time * 1000).toISOString().slice(0, 10),
    open: quote.open[index],
    high: quote.high[index],
    low: quote.low[index],
    close: quote.close[index],
    volume: quote.volume[index]
  })).filter((row) => [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite));
}

async function rawYahooRows(key) {
  const path = join(CACHE_DIR, `raw_${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    const rows = yahooRows(data);
    if (rows.length >= MIN_US_HISTORY_ROWS) await cacheWrite(key, rows, "yahoo");
    return rows;
  } catch {
    return null;
  }
}

async function loadAlphaDaily(symbol) {
  if (!ALPHA_VANTAGE_API_KEY) return [];
  const upper = normalizeTickerInput(symbol).replace(/\.(US|NYSE|NASDAQ)$/i, "");
  const cacheKey = `alpha_daily_${upper.replace(/[^A-Z0-9.]/g, "_")}`;
  const cached = await supplementalRead(cacheKey, DAY_MS);
  if (cached?.length) return cached;

  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(upper)}&outputsize=compact&apikey=${encodeURIComponent(ALPHA_VANTAGE_API_KEY)}`;
    const data = await fetchJson(url);
    const series = data?.["Time Series (Daily)"];
    if (!series || typeof series !== "object") return [];
    const rows = Object.entries(series)
      .map(([date, item]) => {
        const close = Number(item["4. close"]);
        return {
          date,
          open: Number(item["1. open"] ?? close),
          high: Number(item["2. high"] ?? close),
          low: Number(item["3. low"] ?? close),
          close,
          volume: Number(item["5. volume"] ?? 0)
        };
      })
      .filter((row) => Number.isFinite(row.close) && row.close > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-800);
    if (rows.length) await supplementalWrite(cacheKey, rows);
    return rows;
  } catch {
    return [];
  }
}

function naverRows(text) {
  const rows = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.startsWith("[") || line.includes("?占쎌쭨")) continue;
    const parts = line.replace(/[\[\]']/g, "").split(",").map((part) => part.trim());
    if (parts.length < 6) continue;
    rows.push({
      date: `${parts[0].slice(0, 4)}-${parts[0].slice(4, 6)}-${parts[0].slice(6, 8)}`,
      open: Number(parts[1]),
      high: Number(parts[2]),
      low: Number(parts[3]),
      close: Number(parts[4]),
      volume: Number(parts[5])
    });
  }
  return rows;
}

async function rawNaverRows(code) {
  const path = join(CACHE_DIR, `raw_${code}.txt`);
  if (!existsSync(path)) return null;
  const rows = naverRows(await readFile(path, "utf8"));
  if (rows.length) await cacheWrite(code, rows, "naver");
  return rows;
}

async function loadYahoo(symbol) {
  const key = symbol.replace(/[^A-Z0-9]/gi, "_");
  const cached = await cacheRead(key, MIN_US_HISTORY_ROWS);
  if (cached) return cached;
  const rawRows = await rawYahooRows(key);
  if (rawRows?.length >= MIN_US_HISTORY_ROWS) return rawRows;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1d`;
    const data = await fetchJson(url);
    const rows = yahooRows(data);
    if (rows.length >= MIN_US_HISTORY_ROWS) {
      await cacheWrite(key, rows, "yahoo");
      return rows;
    }
  } catch {
    // Yahoo can rate-limit local usage. Try query2 with a browser-like user agent before Alpha Vantage.
  }
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
    const data = await fetchJson(url, "Mozilla/5.0");
    const rows = yahooRows(data);
    if (rows.length >= MIN_US_HISTORY_ROWS) {
      await cacheWrite(key, rows, "yahooQuery2");
      return rows;
    }
  } catch {
    // Alpha Vantage is the final configured fallback.
  }
  const alphaRows = await loadAlphaDaily(symbol);
  if (alphaRows.length >= MIN_US_HISTORY_ROWS) {
    await cacheWrite(key, alphaRows, "alphaVantage");
    return alphaRows;
  }
  throw new Error(`No Yahoo or Alpha Vantage data for ${symbol}`);
}

async function loadNaver(symbol) {
  const code = symbol.split(".")[0];
  const cached = await cacheRead(code);
  if (cached) return cached;
  const rawRows = await rawNaverRows(code);
  if (rawRows?.length) return rawRows;
  const url = `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&timeframe=day&count=800&requestType=0`;
  const text = await fetchText(url);
  const rows = naverRows(text);
  if (!rows.length) throw new Error(`No Naver data for ${code}`);
  await cacheWrite(code, rows, "naver");
  return rows;
}

async function loadHistory(security) {
  if (/^\d{6}/.test(security.yf_symbol)) return loadNaver(security.yf_symbol);
  return loadYahoo(security.yf_symbol);
}

function scoreSecurity(meta, rows) {
  const closes = rows.map((row) => row.close);
  const latest = rows.at(-1);
  const close = latest.close;
  const rsiValue = rsi(closes);
  const atrValue = atr(rows);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const high52 = Math.max(...closes.slice(-252));
  const volume50 = average(rows.slice(-50).map((row) => row.volume));
  const momentum3m = pctChange(closes, 63);
  const momentum6m = pctChange(closes, 126);
  const highDistance = high52 ? (close / high52 - 1) * 100 : 0;
  const rsRating = clamp(50 + momentum6m * 1.2);
  const macdValue = macd(closes);
  const vwapValue = vwap(rows);
  const volumeRatio = volume50 ? latest.volume / volume50 : 1;
  const mfiValue = moneyFlowIndex(rows);

  let trendScore = 0;
  if (close > sma(closes, 20)) trendScore += 10;
  if (close > sma50) trendScore += 12;
  if (close > sma200) trendScore += 14;
  if (sma50 > sma200) trendScore += 10;
  const momentumScore = clamp(50 + momentum3m + momentum6m * 0.5);
  const volumeScore = clamp(50 + (volumeRatio - 1) * 30);
  const qualityProxy = meta.asset_type === "etf" ? 70 : clamp(55 + momentum6m * 0.3);
  const adxProxy = clampFloat(18 + Math.abs(momentum3m) * .55 + (close > sma50 ? 8 : 0), 0, 60);
  const marketDirection = close > sma50 && sma50 > sma200 ? "STRONG_BULL" : close > sma50 ? "BULL" : close < sma200 ? "BEAR" : "NEUTRAL";
  const canslimFormula = buildCanslimFactors({ close, high52, highDistance, volumeRatio, rsRating, mfiValue, momentum3m, momentum6m, marketDirection, adxProxy });
  const canSlim = canslimFormula.weightedScore;
  const totalScore = clamp(canSlim * .48 + momentumScore * .18 + rsRating * .18 + qualityProxy * .10 + volumeScore * .06);

  const entryModel = calculateEntryScoreV2({ closes, close, rsiValue, atrValue, sma50, sma200, momentum3m, momentum6m, rsRating, macdValue, vwapValue, volumeRatio, highDistance, marketDirection });
  const entry = entryModel.value;

  const tradeSetup = calculateTradeSetup({ rows, closes, close, atrValue, volumeRatio, highDistance, entry });
  const stop = tradeSetup.stop;
  return {
    ...meta,
    dataSource: rows.source || (/^\d{6}/.test(meta.yf_symbol) ? "naver" : "yahoo"),
    price: Number(close.toFixed(2)),
    change: Number((((close / closes.at(-2)) - 1) * 100).toFixed(2)),
    score: totalScore,
    entry,
    verdict: entry >= 60 && entry < 75 ? "매수" : entry < 40 ? "주의" : "관망",
    canSlimScore: canSlim,
    conviction: totalScore >= 75 && entry >= 60 ? "높음" : totalScore >= 60 && entry >= 45 ? "보통" : "낮음",
    rsRating,
    mainPoint: entry >= 60 && entry < 75 ? "눌림 또는 재돌파 후보 구간입니다" : entry >= 75 ? "강하지만 추격 위험 확인이 필요합니다" : totalScore >= 75 && entry < 55 ? "종목 자체는 좋지만 지금 타점은 부담입니다" : entry < 40 ? "리스크가 커서 확인이 필요합니다" : "데이터 기준 관찰 후보입니다",
    subPoint: `TotalScore ${totalScore} · EntryScore ${entry} · RSRating ${rsRating}`,
    finance: { pe: null, peGap: 0, target: tradeSetup.target1, targetGap: Number(((tradeSetup.target1 / close - 1) * 100).toFixed(1)), rsi: Number(rsiValue.toFixed(1)), vwapGap: Number(((close / vwapValue - 1) * 100).toFixed(1)) },
    volumeRatio: Number(volumeRatio.toFixed(2)),
    momentum12m: Number(pctChange(closes, 252).toFixed(1)),
    adx: Number(adxProxy.toFixed(1)),
    chart: closes.slice(-10).map((value) => Number(value.toFixed(2))),
    tradePlan: { ...tradeSetup, entryModel },
    canslim: canslimFormula.factors.slice(0, 6).map((item) => [item.code, item.body, item.status === "good" ? true : item.status === "bad" ? false : null]),
    support: canslimFormula.factors.slice(6).map((item) => [item.code, item.body, item.status === "good" ? true : item.status === "bad" ? false : null]).concat([["MATH", `RSI ${rsiValue.toFixed(1)} · ATR ${atrValue.toFixed(2)}`, true], ["SP", `6개월 모멘텀 ${momentum6m.toFixed(1)}%`, momentum6m > 0]]),
    technical: [["RSI", `RSI ${rsiValue.toFixed(1)}`, rsiValue <= 70], ["VWAP", "VWAP 거리 확인", Math.abs(close / vwapValue - 1) < .025], ["MACD", macdValue.line > macdValue.signal ? "MACD 강세" : "MACD 약세", macdValue.line > macdValue.signal], ["ATR", "ATR 기준 위험 범위 계산", true]],
    financeRows: meta.asset_type === "etf" ? [["구성", meta.industry, true], ["분산도", "높음", true], ["변동성", "가격 기반", true], ["주의", "ETF는 추세 중심으로 평가합니다", false]] : [["재무", "외부 재무 데이터 보강이 필요합니다", false], ["모멘텀", "추세와 상대강도를 반영했습니다", true], ["밸류", "목표가는 ATR 기반입니다", false], ["주의", "상세 재무 API 연결이 필요합니다", false]],
    canslimFactors: canslimFormula.factors,
    insight: [["데이터", `${meta.company} 가격 데이터는 ${/^\d{6}/.test(meta.yf_symbol) ? "네이버" : rows.source === "alphaVantage" ? "Alpha Vantage" : "Yahoo"}에서 불러왔습니다.`], ["진입", `${entryModel.version} ${entry}점 · ${entryModel.notes.slice(0, 3).join(" · ") || "중립 조건"}`], ["리스크", `손절폭 ${tradeSetup.riskPct}% · ${tradeSetup.setupState} · 1회 리스크 ${tradeSetup.positionSizing.riskPct}% 기준 ${tradeSetup.positionSizing.shares}주입니다.`], ["출처", "로컬 실데이터 계산 결과입니다."]]
  };
}
function marketItems(market) {
  if (market === "all") return UNIVERSE;
  if (market === "us") return UNIVERSE.filter((item) => item.market === "us" || item.sector === "US ETF");
  if (market === "kr") return UNIVERSE.filter((item) => item.market === "kr" || item.sector === "Korea ETF");
  return UNIVERSE.filter((item) => item.market === market);
}

function fallbackScoredSecurity(meta) {
  const isKr = meta.market === "kr";
  const sources = {
    price: sourceStatus(meta.dataSource || "price", "missing"),
    alphaVantage: sourceStatus("alphaVantage", "missing"),
    dart: sourceStatus("dart", isKr ? "fallback" : "unavailable"),
    sec: sourceStatus("sec", isKr ? "unavailable" : "fallback")
  };
  return {
    ...meta,
    dataSource: "missing",
    price: null,
    change: null,
    score: 0,
    entry: 0,
    verdict: "데이터 없음",
    canSlimScore: 0,
    conviction: "낮음",
    rsRating: 0,
    mainPoint: `${meta.ticker} 데이터 연결 대기`,
    subPoint: "가격 데이터가 없어서 점수와 타점을 계산하지 않았습니다.",
    finance: { pe: null, peGap: 0, target: null, targetGap: null, rsi: null },
    chart: [],
    tradePlan: { buy: null, stop: null, target1: null, target2: null, atr: null },
    canslim: [["C", "실데이터 연결 후 계산됩니다", false], ["A", "실데이터 연결 후 계산됩니다", false], ["N", "실데이터 연결 후 계산됩니다", false], ["S", "실데이터 연결 후 계산됩니다", false], ["L", "실데이터 연결 후 계산됩니다", false], ["I", "실데이터 연결 후 계산됩니다", false]],
    support: [["M", "시장 방향은 서버에서 계산됩니다", null], ["MATH", "수학 지표는 서버에서 계산됩니다", null]],
    technical: [["RSI", "실데이터 연결 후 계산됩니다", null], ["VWAP", "실데이터 연결 후 계산됩니다", null], ["MACD", "실데이터 연결 후 계산됩니다", null]],
    financeRows: meta.asset_type === "etf" ? [["유형", "ETF", true], ["상태", "가격 데이터 대기", null]] : [["유형", "개별종목", true], ["상태", "가격 데이터 대기", null]],
    sourceStatus: sources,
    trust: trustSummary(sources)
  };
}

async function apiStocks(req, res, url) {
  const market = url.searchParams.get("market") || "all";
  const query = String(url.searchParams.get("query") || "").trim();
  const items = [];
  const errors = [];
  let securities = [...marketItems(market)];
  let resolvedQuery = null;
  if (query) {
    try {
      resolvedQuery = await resolveSecurity(query);
      const resolved = resolvedQuery;
      const marketMatches = resolved && (market === "all" || resolved.market === market || (market === "us" && resolved.sector === "US ETF") || (market === "kr" && resolved.sector === "Korea ETF"));
      if (resolved && marketMatches) {
        securities = [{ ...resolved, searchMatched: true, searchOriginal: query }];
      }
    } catch (error) {
      errors.push({ ticker: query, error: error.message });
    }
  }
  for (const security of securities) {
    try {
      const rows = await loadHistory(security);
      items.push(await enrichListSummary(scoreSecurity(security, rows)));
    } catch (error) {
      const isResolvedQuery = resolvedQuery && (
        security.ticker.toUpperCase() === resolvedQuery.ticker.toUpperCase() ||
        security.yf_symbol.toUpperCase() === resolvedQuery.yf_symbol.toUpperCase()
      );
      if (query && isResolvedQuery) {
        items.push(fallbackScoredSecurity(security));
      }
      errors.push({ ticker: security.ticker, error: error.message });
    }
  }
  const mergedItems = query ? items : mergeServerStocks(items, await readScannedStocks());
  json(res, 200, { items: mergedItems, errors, generatedAt: new Date().toISOString() });
}

async function apiScannedStocks(req, res, url) {
  if (req.method === "OPTIONS") return cors(res);
  if (req.method === "GET") return json(res, 200, { ok: true, items: await readScannedStocks() });
  if (req.method === "DELETE") {
    const items = await deleteScannedStocks(url.searchParams.get("ticker") || "");
    return json(res, 200, { ok: true, items, count: items.length });
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readRequestJson(req);
  const items = await rememberServerScannedStocks(body.items || []);
  return json(res, 200, { ok: true, items, count: items.length });
}

async function apiHealth(req, res) {
  json(res, 200, {
    ok: true,
    port: PORT,
    generatedAt: new Date().toISOString(),
    keys: {
      fmp: FMP_API_KEYS.length,
      alphaVantage: Boolean(ALPHA_VANTAGE_API_KEY),
      dart: Boolean(DART_API_KEY),
      secUserAgent: Boolean(SEC_USER_AGENT),
      supabase: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
    }
  });
}

async function apiExchangeRate(req, res) {
  const cacheKey = "exchange_usd_krw";
  const cached = await supplementalRead(cacheKey, 6 * 60 * 60 * 1000).catch(() => null);
  if (cached?.rate) return json(res, 200, cached);
  try {
    const data = await fetchJson("https://open.er-api.com/v6/latest/USD", "StockLens local scanner");
    const rate = Number(data?.rates?.KRW);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("KRW rate missing");
    const payload = {
      base: "USD",
      quote: "KRW",
      rate: Number(rate.toFixed(4)),
      source: "open.er-api.com",
      updatedAt: data.time_last_update_utc || new Date().toISOString(),
      fallback: false
    };
    await supplementalWrite(cacheKey, payload);
    return json(res, 200, payload);
  } catch (error) {
    return json(res, 200, {
      base: "USD",
      quote: "KRW",
      rate: 1350,
      source: "fallback",
      updatedAt: new Date().toISOString(),
      fallback: true,
      error: error.message
    });
  }
}

async function supabaseRest(pathname, { method = "GET", body, headers = {} } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { configured: false, status: 503, payload: { error: "Supabase 환경변수가 설정되지 않았습니다." } };
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { configured: true, ok: response.ok, status: response.status, payload };
}

async function apiPortfolio(req, res, url) {
  if (req.method === "OPTIONS") return cors(res);
  if (req.method === "GET") {
    const clientId = url.searchParams.get("clientId");
    if (!validPortfolioClientId(clientId)) return json(res, 400, { error: "clientId가 올바르지 않습니다." });
    const result = await supabaseRest(`${SUPABASE_PORTFOLIO_TABLE}?client_id=eq.${encodeURIComponent(clientId)}&select=client_id,payload,updated_at&limit=1`);
    if (!result.configured) return json(res, 200, { ok: false, configured: false, error: result.payload.error });
    if (!result.ok) return json(res, result.status, { ok: false, configured: true, error: result.payload });
    const row = Array.isArray(result.payload) ? result.payload[0] : null;
    if (row?.payload && !portfolioAuthMatches(clientId, row.payload, portfolioTokenFromRequest(req))) {
      return json(res, 403, { ok: false, configured: true, error: "포트폴리오 접근 토큰이 일치하지 않습니다." });
    }
    return json(res, 200, { ok: true, configured: true, portfolio: stripPortfolioAuth(row?.payload), updatedAt: row?.updated_at || null });
  }
  if (req.method === "POST" || req.method === "PUT") {
    const body = await readRequestJson(req);
    const clientId = body.clientId;
    if (!validPortfolioClientId(clientId)) return json(res, 400, { error: "clientId가 올바르지 않습니다." });
    const portfolioPayload = body.portfolio;
    if (!portfolioPayload || typeof portfolioPayload !== "object" || Array.isArray(portfolioPayload)) {
      return json(res, 400, { error: "portfolio payload가 필요합니다." });
    }
    const token = portfolioTokenFromRequest(req, body);
    const securedPayload = attachPortfolioAuth(clientId, portfolioPayload, token);
    if (!securedPayload) return json(res, 401, { ok: false, configured: true, error: "포트폴리오 접근 토큰이 필요합니다." });
    const existing = await supabaseRest(`${SUPABASE_PORTFOLIO_TABLE}?client_id=eq.${encodeURIComponent(clientId)}&select=payload&limit=1`);
    if (existing.configured && existing.ok) {
      const existingRow = Array.isArray(existing.payload) ? existing.payload[0] : null;
      if (existingRow?.payload && !portfolioAuthMatches(clientId, existingRow.payload, token)) {
        return json(res, 403, { ok: false, configured: true, error: "포트폴리오 접근 토큰이 일치하지 않습니다." });
      }
    } else if (existing.configured && !existing.ok) {
      return json(res, existing.status, { ok: false, configured: true, error: existing.payload });
    }
    const result = await supabaseRest(`${SUPABASE_PORTFOLIO_TABLE}?on_conflict=client_id`, {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: [{
        client_id: clientId,
        payload: securedPayload,
        updated_at: new Date().toISOString()
      }]
    });
    if (!result.configured) return json(res, 200, { ok: false, configured: false, error: result.payload.error });
    if (!result.ok) return json(res, result.status, { ok: false, configured: true, error: result.payload });
    const row = Array.isArray(result.payload) ? result.payload[0] : null;
    return json(res, 200, { ok: true, configured: true, updatedAt: row?.updated_at || null });
  }
  return json(res, 405, { error: "Method not allowed" });
}

async function apiWatchlist(req, res, url) {
  if (req.method === "OPTIONS") return cors(res);
  if (req.method === "GET") {
    const result = await readCloudWatchlist(url.searchParams.get("clientId"), portfolioTokenFromRequest(req));
    return json(res, result.status || 200, result.ok ? result : { ok: false, configured: result.configured ?? true, error: result.error });
  }
  if (req.method === "POST" || req.method === "PUT") {
    const body = await readRequestJson(req);
    const result = await writeCloudWatchlist(body.clientId, body.tickers || [], portfolioTokenFromRequest(req, body));
    return json(res, result.status || 200, result.ok ? result : { ok: false, configured: result.configured ?? true, error: result.error });
  }
  if (req.method === "DELETE") {
    const clientId = url.searchParams.get("clientId");
    const result = await writeCloudWatchlist(clientId, [], portfolioTokenFromRequest(req));
    return json(res, result.status || 200, result.ok ? result : { ok: false, configured: result.configured ?? true, error: result.error });
  }
  return json(res, 405, { error: "Method not allowed" });
}

async function auditWatchlistTickers(tickers) {
  const cleanTickers = cleanWatchlistTickers(tickers, 12);
  const items = [];
  const errors = [];
  for (const ticker of cleanTickers) {
    try {
      const security = await resolveSecurity(ticker);
      if (!security) throw new Error("unknown ticker");
      const rows = await loadHistory(security);
      const scored = await enrichListSummary(scoreSecurity(security, rows));
      const weakSources = Object.entries(scored.sourceStatus || {})
        .filter(([, item]) => ["missing", "missing_key", "fallback", "partial"].includes(item?.status))
        .map(([key]) => key);
      items.push({
        ticker: scored.ticker,
        company: scored.company,
        market: scored.market,
        price: scored.price,
        score: scored.score,
        entry: scored.entry,
        trust: scored.trust,
        sourceStatus: scored.sourceStatus,
        weakSources,
        needsEnrichment: scored.trust?.label !== "높음" || weakSources.length > 0
      });
    } catch (error) {
      items.push({
        ticker,
        trust: { label: "낮음", note: "가격/출처 점검에 실패했습니다." },
        sourceStatus: { price: sourceStatus("price", "missing") },
        weakSources: ["price"],
        needsEnrichment: true
      });
      errors.push({ ticker, error: error.message });
    }
  }
  const needsEnrichment = items.filter((item) => item.needsEnrichment).map((item) => item.ticker);
  const high = items.filter((item) => item.trust?.label === "높음").length;
  const medium = items.filter((item) => item.trust?.label === "보통").length;
  const low = items.filter((item) => item.trust?.label === "낮음").length;
  const label = low ? "낮음" : medium ? "보통" : high ? "높음" : "준비중";
  return {
    label,
    total: items.length,
    high,
    medium,
    low,
    needsEnrichment,
    items,
    errors,
    generatedAt: new Date().toISOString()
  };
}

async function apiWatchlistAudit(req, res, url) {
  if (req.method === "OPTIONS") return cors(res);
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  let tickers = [];
  const clientId = url.searchParams.get("clientId");
  if (clientId) {
    const cloud = await readCloudWatchlist(clientId, portfolioTokenFromRequest(req));
    if (!cloud.ok) return json(res, cloud.status || 200, { ok: false, configured: cloud.configured ?? true, error: cloud.error });
    tickers = cloud.tickers || [];
  } else {
    tickers = String(url.searchParams.get("tickers") || "").split(",");
  }
  const audit = await auditWatchlistTickers(tickers);
  if (audit.needsEnrichment.length) {
    prioritizeEnrichmentQueue(audit.needsEnrichment);
    setTimeout(processEnrichmentQueue, 0);
  }
  return json(res, 200, { ok: true, configured: true, ...audit });
}

function snapshotPayload(stock) {
  return {
    ticker: stock.ticker,
    market: stock.market,
    asset_type: stock.asset_type,
    price: stock.price,
    change: stock.change,
    score: stock.score,
    entry: stock.entry,
    verdict: stock.verdict,
    canSlimScore: stock.canSlimScore,
    rsRating: stock.rsRating,
    dataSource: stock.dataSource,
    trust: stock.trust || null,
    sourceStatus: stock.sourceStatus || null,
    dataCrossChecks: stock.dataCrossChecks || null,
    anomalyWarnings: stock.anomalyWarnings || [],
    tradePlan: stock.tradePlan ? {
      buy: stock.tradePlan.buy,
      stop: stock.tradePlan.stop,
      stopBasis: stock.tradePlan.stopBasis,
      atrStop: stock.tradePlan.atrStop,
      vcpStop: stock.tradePlan.vcpStop,
      target1: stock.tradePlan.target1,
      target2: stock.tradePlan.target2,
      riskPct: stock.tradePlan.riskPct,
      setupState: stock.tradePlan.setupState
    } : null
  };
}

function snapshotMetric(payload = {}) {
  return {
    price: Number(payload.price),
    score: Number(payload.score),
    entry: Number(payload.entry),
    stop: Number(payload.tradePlan?.stop)
  };
}

function metricDelta(current, previous, key) {
  const left = Number(current?.[key]);
  const right = Number(previous?.[key]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Number((left - right).toFixed(2));
}

function enrichSnapshotDeltas(items) {
  const groups = new Map();
  for (const item of items || []) {
    const ticker = String(item.ticker || item.payload?.ticker || "").toUpperCase();
    if (!ticker) continue;
    if (!groups.has(ticker)) groups.set(ticker, []);
    groups.get(ticker).push(item);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (let index = 0; index < rows.length; index += 1) {
      const current = snapshotMetric(rows[index].payload);
      const previous = index > 0 ? snapshotMetric(rows[index - 1].payload) : null;
      rows[index].delta = previous ? {
        price: metricDelta(current, previous, "price"),
        score: metricDelta(current, previous, "score"),
        entry: metricDelta(current, previous, "entry"),
        stop: metricDelta(current, previous, "stop")
      } : null;
    }
  }
  return items;
}

function defaultSnapshotTickers() {
  const envTickers = (ENV.SNAPSHOT_TICKERS || ENV.CRON_TICKERS || "")
    .split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);
  if (envTickers.length) return envTickers;
  return BASE_UNIVERSE
    .filter((item) => item[3] === "us" || item[3] === "kr")
    .map((item) => item[0])
    .slice(0, 30);
}

function cleanSnapshotTickers(tickers, limit = 50) {
  return [...new Set((tickers || [])
    .map((ticker) => String(ticker || "").trim().toUpperCase())
    .filter(Boolean))]
    .slice(0, limit);
}

function cleanEnrichmentTickers(tickers, limit = ENRICHMENT_BATCH_LIMIT) {
  return [...new Set((tickers || [])
    .map((ticker) => String(ticker || "").trim().toUpperCase())
    .filter((ticker) => /^[A-Z0-9.-]{1,16}$/.test(ticker)))]
    .slice(0, limit);
}

function prioritizeEnrichmentQueue(tickers) {
  const priority = cleanEnrichmentTickers(tickers, ENRICHMENT_BATCH_LIMIT);
  if (!priority.length) return [];
  for (let index = enrichmentQueue.length - 1; index >= 0; index -= 1) {
    if (priority.includes(enrichmentQueue[index])) enrichmentQueue.splice(index, 1);
  }
  enrichmentQueue.unshift(...priority.filter((ticker) => {
    const current = enrichmentStatus.get(ticker);
    return current?.state !== "running";
  }));
  for (const ticker of priority) {
    const current = enrichmentStatus.get(ticker);
    if (current?.state === "running") continue;
    enrichmentStatus.set(ticker, {
      state: "queued",
      label: "관심 종목 우선 보강 대기",
      priority: true,
      sourcePlan: ["price", "fmp", "alphaVantage", "sec", "finra"],
      updatedAt: new Date().toISOString()
    });
  }
  return priority;
}

function enrichmentSnapshot(limit = 30) {
  const items = [...enrichmentStatus.entries()]
    .map(([ticker, status]) => ({ ticker, ...status }))
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, limit);
  return {
    running: enrichmentRunning,
    queued: enrichmentQueue.length,
    items,
    updatedAt: new Date().toISOString()
  };
}

function enqueueEnrichment(tickers, options = {}) {
  const accepted = [];
  for (const ticker of cleanEnrichmentTickers(tickers)) {
    const current = enrichmentStatus.get(ticker);
    if (current?.state === "queued" || current?.state === "running") continue;
    if (enrichmentQueue.length >= ENRICHMENT_QUEUE_LIMIT) break;
    enrichmentQueue.push(ticker);
    enrichmentStatus.set(ticker, {
      state: "queued",
      label: "보강 대기",
      sourcePlan: ["price", "fmp", "alphaVantage", "sec", "finra"],
      updatedAt: new Date().toISOString()
    });
    accepted.push(ticker);
  }
  if (accepted.length && options.start !== false) setTimeout(processEnrichmentQueue, 0);
  return accepted;
}

async function processEnrichmentQueue() {
  if (enrichmentRunning) return;
  enrichmentRunning = true;
  while (enrichmentQueue.length) {
    const ticker = enrichmentQueue.shift();
    enrichmentStatus.set(ticker, {
      state: "running",
      label: "데이터 보강 중",
      sourcePlan: ["price", "fmp", "alphaVantage", "sec", "finra"],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    try {
      const security = await resolveSecurity(ticker);
      if (!security) throw new Error("unknown ticker");
      const rows = await loadHistory(security);
      const detail = await enrichDetail(security, rows, scoreSecurity(security, rows));
      enrichmentStatus.set(ticker, {
        state: "done",
        label: detail.trust?.label === "높음" ? "보강 완료" : "부분 보강",
        trust: detail.trust?.label || "보통",
        sourceStatus: detail.sourceStatus || null,
        priceRows: rows.length,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      enrichmentStatus.set(ticker, {
        state: "error",
        label: "보강 실패",
        error: error.message,
        updatedAt: new Date().toISOString()
      });
    }
  }
  enrichmentRunning = false;
}

async function apiEnrichment(req, res) {
  if (req.method === "OPTIONS") return cors(res);
  if (req.method === "GET") return json(res, 200, enrichmentSnapshot());
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readRequestJson(req);
  const priority = prioritizeEnrichmentQueue(body.priorityTickers || []);
  const accepted = enqueueEnrichment(body.tickers || [], { start: false });
  if ((priority.length || accepted.length) && body.start !== false) setTimeout(processEnrichmentQueue, 0);
  return json(res, 200, {
    ok: true,
    priority,
    accepted,
    ...enrichmentSnapshot()
  });
}

async function buildSnapshotRows(tickers, limit = 50) {
  const cleanTickers = cleanSnapshotTickers(tickers, limit);
  const rows = [];
  const errors = [];
  for (const ticker of cleanTickers) {
    try {
      const security = await resolveSecurity(ticker);
      if (!security) throw new Error("unknown ticker");
      const history = await loadHistory(security);
      const detail = await enrichDetail(security, history, scoreSecurity(security, history));
      rows.push({
        ticker: detail.ticker,
        market: detail.market,
        payload: snapshotPayload(detail),
        created_at: new Date().toISOString()
      });
    } catch (error) {
      errors.push({ ticker, error: error.message });
    }
  }
  return { rows, errors, requested: cleanTickers.length };
}

async function saveSnapshotRows(rows, errors = []) {
  if (!rows.length) {
    return {
      ok: false,
      configured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
      saved: 0,
      errors
    };
  }
  const result = await supabaseRest(SUPABASE_SNAPSHOT_TABLE, {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: rows
  });
  if (!result.configured) return { ok: false, configured: false, saved: 0, errors, error: result.payload.error };
  if (!result.ok) return { ok: false, configured: true, saved: 0, errors, error: result.payload, status: result.status };
  return { ok: true, configured: true, saved: rows.length, errors, items: result.payload };
}

async function apiSnapshots(req, res, url) {
  if (req.method === "OPTIONS") return cors(res);
  if (req.method === "GET") {
    const ticker = String(url.searchParams.get("ticker") || "").trim().toUpperCase();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
    const filter = ticker ? `ticker=eq.${encodeURIComponent(ticker)}&` : "";
    const result = await supabaseRest(`${SUPABASE_SNAPSHOT_TABLE}?${filter}select=ticker,market,payload,created_at&order=created_at.desc&limit=${limit}`);
    if (!result.configured) return json(res, 200, { ok: false, configured: false, items: [], error: result.payload.error });
    if (!result.ok) return json(res, result.status, { ok: false, configured: true, items: [], error: result.payload });
    const items = Array.isArray(result.payload) ? result.payload : [];
    return json(res, 200, { ok: true, configured: true, items: enrichSnapshotDeltas(items) });
  }
  if (req.method === "POST") {
    const body = await readRequestJson(req);
    const tickers = Array.isArray(body.tickers) ? body.tickers : [];
    const built = await buildSnapshotRows(tickers, 50);
    if (!built.requested) return json(res, 400, { error: "tickers 배열이 필요합니다." });
    const saved = await saveSnapshotRows(built.rows, built.errors);
    return json(res, saved.status || 200, saved);
  }
  return json(res, 405, { error: "Method not allowed" });
}

async function readBacktestHistory() {
  try {
    const raw = JSON.parse((await readFile(join(CACHE_DIR, "backtest_runs.json"), "utf8")).replace(/^\uFEFF/, ""));
    return Array.isArray(raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

async function writeBacktestHistory(items) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, "backtest_runs.json"), JSON.stringify({ savedAt: Date.now(), items: items.slice(-BACKTEST_HISTORY_LIMIT) }));
}

function backtestRunSummary(payload) {
  const best = payload.entryCalibration || null;
  const hybrid = (payload.results || []).find((row) => row.name === "V4_HYBRID") || null;
  return {
    generatedAt: payload.generatedAt,
    market: payload.market,
    status: payload.status,
    params: payload.params,
    coverage: payload.coverage,
    reliability: payload.backtestReliability,
    recommendedBand: best?.recommendedBand || null,
    recommendedEdge: best?.edge ?? null,
    recommendedSamples: best?.samples ?? null,
    hybridEdge: hybrid?.edge ?? null,
    hybridSamples: hybrid?.samples ?? null
  };
}

function attachBacktestHistoryDelta(history) {
  return history.map((item, index) => {
    const previous = index > 0 ? history[index - 1] : null;
    return {
      ...item,
      delta: previous ? {
        recommendedEdge: metricDelta({ value: item.recommendedEdge }, { value: previous.recommendedEdge }, "value"),
        hybridEdge: metricDelta({ value: item.hybridEdge }, { value: previous.hybridEdge }, "value"),
        evaluatedPoints: metricDelta({ value: item.coverage?.evaluatedPoints }, { value: previous.coverage?.evaluatedPoints }, "value")
      } : null
    };
  });
}

async function saveBacktestRun(payload) {
  const history = await readBacktestHistory();
  const next = [...history, backtestRunSummary(payload)].slice(-BACKTEST_HISTORY_LIMIT);
  await writeBacktestHistory(next);
  return attachBacktestHistoryDelta(next);
}

async function apiBacktestHistory(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  const history = attachBacktestHistoryDelta(await readBacktestHistory());
  return json(res, 200, { ok: true, items: history.slice().reverse(), limit: BACKTEST_HISTORY_LIMIT });
}

async function apiCronDailySnapshot(req, res, url) {
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (CRON_SECRET) {
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const provided = auth || url.searchParams.get("secret") || "";
    if (provided !== CRON_SECRET) return json(res, 401, { ok: false, error: "Unauthorized cron request" });
  }
  const queryTickers = url.searchParams.get("tickers");
  const tickers = queryTickers ? queryTickers.split(",") : defaultSnapshotTickers();
  const built = await buildSnapshotRows(tickers, Math.min(50, Number(url.searchParams.get("limit") || 30)));
  const saved = await saveSnapshotRows(built.rows, built.errors);
  return json(res, saved.status || 200, {
    ...saved,
    cron: true,
    requested: built.requested,
    generatedAt: new Date().toISOString()
  });
}

async function apiCacheStatus(req, res) {
  await mkdir(CACHE_DIR, { recursive: true });
  const files = await readdir(CACHE_DIR);
  const priceFiles = [];
  const overviewSymbols = [];
  const earningsSymbols = [];
  const fmpSymbols = [];
  const fmpCompleteSymbols = [];
  const fmpPartialSymbols = [];
  let alphaQuota = null;
  for (const file of files.filter((name) => /^[A-Z0-9_]+\.json$/i.test(name))) {
    try {
      const raw = JSON.parse((await readFile(join(CACHE_DIR, file), "utf8")).replace(/^\uFEFF/, ""));
      if (!Array.isArray(raw.rows)) continue;
      const ageMs = Date.now() - Number(raw.savedAt || 0);
      priceFiles.push({
        symbol: file.replace(/\.json$/i, ""),
        rows: raw.rows.length,
        source: raw.source || "unknown",
        stale: ageMs > PRICE_CACHE_MS,
        ageMinutes: Number((ageMs / 60000).toFixed(1))
      });
    } catch {
      // Ignore non-price JSON cache files.
    }
  }
  for (const file of files) {
    const overview = file.match(/^alpha_overview_([A-Z0-9.]+)\.json$/i);
    const earnings = file.match(/^alpha_earnings_([A-Z0-9.]+)\.json$/i);
    const fmp = file.match(/^fmp_bundle_([A-Z0-9.]+)\.json$/i);
    if (overview) overviewSymbols.push(overview[1].toUpperCase());
    if (earnings) earningsSymbols.push(earnings[1].toUpperCase());
    if (fmp) {
      const symbol = fmp[1].toUpperCase();
      fmpSymbols.push(symbol);
      try {
        const raw = JSON.parse((await readFile(join(CACHE_DIR, file), "utf8")).replace(/^\uFEFF/, ""));
        const data = raw?.data || {};
        const coverage = [
          data.profile,
          data.quote,
          data.ratios,
          data.keyMetrics,
          data.targetConsensus,
          data.income?.length,
          data.balance?.length,
          data.cashflow?.length,
          data.estimates?.length
        ].filter(Boolean).length;
        if (coverage >= 6) fmpCompleteSymbols.push(symbol);
        else if (coverage > 0) fmpPartialSymbols.push(symbol);
      } catch {
        // Ignore malformed supplemental cache files.
      }
    }
    if (file === "alpha_quota.json") {
      try {
        alphaQuota = JSON.parse((await readFile(join(CACHE_DIR, file), "utf8")).replace(/^\uFEFF/, ""));
      } catch {
        alphaQuota = null;
      }
    }
  }
  const usStockSymbols = UNIVERSE
    .filter((item) => item.market === "us" && item.asset_type !== "etf")
    .map((item) => item.ticker.toUpperCase());
  const coverageSets = {
    fmpComplete: new Set(fmpCompleteSymbols),
    fmpPartial: new Set(fmpPartialSymbols),
    overview: new Set(overviewSymbols),
    earnings: new Set(earningsSymbols)
  };
  const fundamentalCoverage = usStockSymbols.map((symbol) => fundamentalCoverageForSymbol(symbol, coverageSets));
  const dataQuality = dataQualitySummary({
    priceFiles,
    fmpCompleteSymbols,
    fmpPartialSymbols,
    overviewSymbols,
    earningsSymbols,
    alphaQuota,
    usStockSymbols
  });
  json(res, 200, {
    cacheDir: CACHE_DIR,
    files: files.length,
    priceFiles: priceFiles.length,
    freshPriceFiles: priceFiles.filter((item) => !item.stale).length,
    stalePriceFiles: priceFiles.filter((item) => item.stale).length,
    fundamentalFiles: {
      fmp: fmpSymbols.length,
      fmpComplete: fmpCompleteSymbols.length,
      fmpPartial: fmpPartialSymbols.length,
      overview: overviewSymbols.length,
      earnings: earningsSymbols.length,
      both: usStockSymbols.filter((symbol) => fmpCompleteSymbols.includes(symbol) || (overviewSymbols.includes(symbol) && earningsSymbols.includes(symbol))).length
    },
    fundamentalCoverage,
    nextFundamentalPlan: {
      command: "node preload_fundamentals.mjs --limit=80 --alpha",
      prioritySymbols: fundamentalCoverage.filter((item) => !item.complete).slice(0, 20).map((item) => item.symbol),
      note: "FMP 한도 초과 시 Alpha overview/earnings와 기존 FMP 부분 캐시를 먼저 사용합니다."
    },
    alphaQuota,
    priceSources: priceFiles.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {}),
    dataQuality,
    watchedSymbols: UNIVERSE.map((item) => item.ticker),
    missingWatchedSymbols: UNIVERSE
      .map((item) => item.yf_symbol.replace(/[^A-Z0-9]/gi, "_"))
      .filter((key) => !priceFiles.some((file) => file.symbol.toUpperCase() === key.toUpperCase())),
    missingFundamentalSymbols: usStockSymbols.filter((symbol) => !fmpCompleteSymbols.includes(symbol) && (!overviewSymbols.includes(symbol) || !earningsSymbols.includes(symbol))),
    generatedAt: new Date().toISOString()
  });
}

async function apiBacktest(req, res, url) {
  const market = url.searchParams.get("market") || "all";
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(60, Math.floor(requestedLimit)) : 25;
  const mode = url.searchParams.get("mode") === "long" || url.searchParams.get("long") === "1" ? "long" : "recent";
  const requestedYears = Number(url.searchParams.get("years"));
  const years = Number.isFinite(requestedYears) && requestedYears > 0 ? Math.min(10, Math.max(1, Math.floor(requestedYears))) : 3;
  const requestedStep = Number(url.searchParams.get("step"));
  const step = Number.isFinite(requestedStep) && requestedStep > 0 ? Math.min(20, Math.max(1, Math.floor(requestedStep))) : 5;
  const requestedHorizon = Number(url.searchParams.get("horizon"));
  const horizon = Number.isFinite(requestedHorizon) && requestedHorizon > 0 ? Math.min(60, Math.max(1, Math.floor(requestedHorizon))) : 10;
  const requestedMddHorizon = Number(url.searchParams.get("mdd"));
  const mddHorizon = Number.isFinite(requestedMddHorizon) && requestedMddHorizon > 0 ? Math.min(90, Math.max(horizon, Math.floor(requestedMddHorizon))) : Math.max(20, horizon);
  const maxWindowRows = mode === "long" ? Math.floor(years * 252) : 380;
  const securities = marketItems(market).slice(0, limit);
  const variants = [
    { name: "V4_HYBRID", high: 75, low: 60, match: (score) => score.score >= 75 && score.entry >= 60 },
    { name: "Score80", high: 80, low: 50, match: (score) => score.score >= 80 },
    { name: "Entry60_74", high: 60, low: 74, match: (score) => score.entry >= 60 && score.entry < 75 },
    { name: "Balanced65", high: 65, low: 55, match: (score) => score.score >= 65 && score.entry >= 55 }
  ];
  const stats = variants.map((variant) => ({ ...variant, returns: [], baselineReturns: [], drawdowns: [], evaluated: 0 }));
  const entryBuckets = [
    { name: "Entry 75+", high: 75, low: 100, test: (entry) => entry >= 75, returns: [], baselineReturns: [], drawdowns: [], evaluated: 0 },
    { name: "Entry 60-74", high: 60, low: 74, test: (entry) => entry >= 60 && entry < 75, returns: [], baselineReturns: [], drawdowns: [], evaluated: 0 },
    { name: "Entry 40-59", high: 40, low: 59, test: (entry) => entry >= 40 && entry < 60, returns: [], baselineReturns: [], drawdowns: [], evaluated: 0 },
    { name: "Entry <40", high: 0, low: 39, test: (entry) => entry < 40, returns: [], baselineReturns: [], drawdowns: [], evaluated: 0 }
  ];
  const errors = [];
  let loaded = 0;
  let evaluatedPoints = 0;
  let skippedPoints = 0;

  for (const security of securities) {
    try {
      const rows = await loadHistory(security);
      const requiredRows = Math.max(230, 200 + Math.max(horizon, mddHorizon) + 1);
      if (rows.length < requiredRows) {
        errors.push({ ticker: security.ticker, error: `insufficient history: ${rows.length} rows` });
        continue;
      }
      loaded += 1;
      const start = Math.max(200, rows.length - maxWindowRows);
      const end = rows.length - Math.max(horizon, mddHorizon) - 1;
      for (let i = start; i < end; i += step) {
        const pastRows = rows.slice(0, i + 1);
        const scored = scoreSecurity(security, pastRows);
        const close = rows[i].close;
        const futureClose = rows[i + horizon]?.close;
        if (!Number.isFinite(close) || !Number.isFinite(futureClose) || close <= 0) {
          skippedPoints += 1;
          continue;
        }
        evaluatedPoints += 1;
        const forwardReturn = ((futureClose / close) - 1) * 100;
        const futureMddRows = rows.slice(i + 1, Math.min(i + 1 + mddHorizon, rows.length)).map((row) => row.close);
        const forwardMdd = recentMaxDrawdown([close, ...futureMddRows], mddHorizon);
        for (const variant of stats) {
          variant.evaluated += 1;
          variant.baselineReturns.push(forwardReturn);
          if (!variant.match(scored)) continue;
          variant.returns.push(forwardReturn);
          if (Number.isFinite(forwardMdd)) variant.drawdowns.push(forwardMdd);
        }
        for (const bucket of entryBuckets) {
          bucket.evaluated += 1;
          bucket.baselineReturns.push(forwardReturn);
          if (!bucket.test(scored.entry)) continue;
          bucket.returns.push(forwardReturn);
          if (Number.isFinite(forwardMdd)) bucket.drawdowns.push(forwardMdd);
        }
      }
    } catch (error) {
      errors.push({ ticker: security.ticker, error: error.message });
    }
  }

  if (!loaded) {
    return json(res, 200, {
      market,
      status: "not_ready",
      source: "local",
      method: `scoreSecurity walk-forward; ${mode} window; lookahead blocked`,
      params: { market, limit, mode, years, step, horizon, mddHorizon, maxWindowRows },
      coverage: {
        requested: securities.length,
        loaded,
        evaluatedPoints,
        skippedPoints,
        errorCount: errors.length
      },
      results: [],
      entryBuckets: [],
      errors,
      message: "백테스트에 사용할 로컬 가격 데이터를 불러오지 못했습니다.",
      generatedAt: new Date().toISOString()
    });
  }

  const results = stats.map((variant) => {
    const avgReturn = average(variant.returns);
    const avgBaseline = average(variant.baselineReturns);
    return {
      name: variant.name,
      high: variant.high,
      low: variant.low,
      samples: variant.returns.length,
      green_ratio: variant.evaluated ? Number((variant.returns.length / variant.evaluated * 100).toFixed(1)) : 0,
      green_return_10d: variant.returns.length ? Number(avgReturn.toFixed(2)) : null,
      forward_return: variant.returns.length ? Number(avgReturn.toFixed(2)) : null,
      edge: variant.returns.length ? Number((avgReturn - avgBaseline).toFixed(2)) : null,
      win_rate: variant.returns.length ? Number((variant.returns.filter((value) => value > 0).length / variant.returns.length * 100).toFixed(1)) : null,
      mdd_20d: variant.drawdowns.length ? Number(average(variant.drawdowns).toFixed(2)) : null,
      forward_mdd: variant.drawdowns.length ? Number(average(variant.drawdowns).toFixed(2)) : null
    };
  });
  const entryResults = entryBuckets.map((bucket) => {
    const avgReturn = average(bucket.returns);
    const avgBaseline = average(bucket.baselineReturns);
    return {
      name: bucket.name,
      high: bucket.high,
      low: bucket.low,
      samples: bucket.returns.length,
      green_ratio: bucket.evaluated ? Number((bucket.returns.length / bucket.evaluated * 100).toFixed(1)) : 0,
      green_return_10d: bucket.returns.length ? Number(avgReturn.toFixed(2)) : null,
      forward_return: bucket.returns.length ? Number(avgReturn.toFixed(2)) : null,
      edge: bucket.returns.length ? Number((avgReturn - avgBaseline).toFixed(2)) : null,
      win_rate: bucket.returns.length ? Number((bucket.returns.filter((value) => value > 0).length / bucket.returns.length * 100).toFixed(1)) : null,
      mdd_20d: bucket.drawdowns.length ? Number(average(bucket.drawdowns).toFixed(2)) : null,
      forward_mdd: bucket.drawdowns.length ? Number(average(bucket.drawdowns).toFixed(2)) : null
    };
  });
  const rankedEntryBuckets = entryResults
    .filter((row) => row.name !== "Entry <40" && row.samples >= 30 && Number.isFinite(row.edge))
    .sort((a, b) => b.edge - a.edge || b.win_rate - a.win_rate);
  const recommendedEntryBucket = rankedEntryBuckets[0] || entryResults.find((row) => row.name === "Entry 60-74") || null;
  const calibrationConfidence = !recommendedEntryBucket
    ? "낮음"
    : recommendedEntryBucket.samples >= 200 && recommendedEntryBucket.edge > 0
      ? "보통"
      : recommendedEntryBucket.samples >= 50 && recommendedEntryBucket.edge > 0
        ? "낮음"
        : "주의";
  const entryCalibration = recommendedEntryBucket ? {
    recommendedBand: recommendedEntryBucket.name,
    samples: recommendedEntryBucket.samples,
    edge: recommendedEntryBucket.edge,
    winRate: recommendedEntryBucket.win_rate,
    confidence: calibrationConfidence,
    note: calibrationConfidence === "보통"
      ? `${recommendedEntryBucket.name} 구간이 현재 샘플에서 가장 안정적인 후보입니다.`
      : `${recommendedEntryBucket.name} 구간이 우위지만 샘플/edge 검증을 계속해야 합니다.`
  } : null;
  const totalSamples = results.reduce((sum, row) => sum + row.samples, 0);
  const entrySamples = entryResults.reduce((sum, row) => sum + row.samples, 0);
  const requiredSecurities = 10;
  const requiredEvaluatedPoints = 500;
  const meetsSampleRule = loaded >= requiredSecurities && evaluatedPoints >= requiredEvaluatedPoints;
  const backtestReliability = {
    label: meetsSampleRule && entryCalibration?.edge > 0 ? "보통" : evaluatedPoints >= 100 ? "낮음" : "준비중",
    sampleRule: "최소 10종목·500평가시점 이상이면 베타 검증에 사용",
    requiredSecurities,
    requiredEvaluatedPoints,
    meetsSampleRule,
    lookaheadBlocked: true,
    caveat: "거래비용, 슬리피지, 세금은 아직 반영하지 않았습니다."
  };

  const responsePayload = {
    market,
    status: totalSamples || entrySamples ? (errors.length ? "partial" : "ok") : "no_samples",
    source: "local",
    method: `scoreSecurity walk-forward; rows.slice(0, i + 1); ${loaded}/${securities.length} securities; ${mode} window; +${horizon}d return; ${mddHorizon}d MDD`,
    params: { market, limit, mode, years, step, horizon, mddHorizon, maxWindowRows },
    coverage: {
      requested: securities.length,
      loaded,
      evaluatedPoints,
      skippedPoints,
      errorCount: errors.length
    },
    results: totalSamples ? results : [],
    entryBuckets: entrySamples ? entryResults : [],
    entryCalibration,
    backtestReliability,
    errors,
    message: totalSamples || entrySamples ? "실제 로컬 가격 데이터로 계산한 샘플링 백테스트입니다." : "가격 데이터는 로드됐지만 조건에 맞는 백테스트 샘플이 없습니다.",
    generatedAt: new Date().toISOString()
  };
  const history = await saveBacktestRun(responsePayload).catch(() => []);
  responsePayload.backtestHistory = history.slice(-5).reverse();
  json(res, 200, responsePayload);
}

async function apiStockDetail(req, res, ticker) {
  const security = await resolveSecurity(ticker);
  if (!security) return json(res, 404, { error: "unknown ticker" });
  try {
    const rows = await loadHistory(security);
    const scored = scoreSecurity(security, rows);
    json(res, 200, await enrichDetail(security, rows, scored));
  } catch (error) {
    json(res, 200, { ...fallbackScoredSecurity(security), errors: [{ ticker: security.ticker, error: error.message }] });
  }
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = resolve(join(ROOT, decodeURIComponent(safePath)));
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(fullPath);
    const ext = extname(fullPath);
    const headers = { "content-type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html" || ext === ".js" || ext === ".css") {
      headers["cache-control"] = "no-store";
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname === "/api/health") return apiHealth(req, res);
    if (url.pathname === "/api/exchange/usd-krw") return apiExchangeRate(req, res);
    if (url.pathname === "/api/cache/status") return apiCacheStatus(req, res);
    if (url.pathname === "/api/enrichment") return apiEnrichment(req, res);
    if (url.pathname === "/api/portfolio") return apiPortfolio(req, res, url);
    if (url.pathname === "/api/watchlist/audit") return apiWatchlistAudit(req, res, url);
    if (url.pathname === "/api/watchlist") return apiWatchlist(req, res, url);
    if (url.pathname === "/api/snapshots") return apiSnapshots(req, res, url);
    if (url.pathname === "/api/cron/daily-snapshot") return apiCronDailySnapshot(req, res, url);
    if (url.pathname === "/api/backtest/history") return apiBacktestHistory(req, res);
    if (url.pathname === "/api/backtest") return apiBacktest(req, res, url);
    if (url.pathname === "/api/scanned") return apiScannedStocks(req, res, url);
    if (url.pathname === "/api/stocks") return apiStocks(req, res, url);
    const detail = url.pathname.match(/^\/api\/stocks\/([^/]+)$/);
    if (detail) return apiStockDetail(req, res, detail[1]);
    return serveStatic(res, url.pathname);
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}

export function createAppServer() {
  return createServer(handleRequest);
}

export function startServer(port = PORT) {
  const server = createAppServer();
  return server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Stock scanner real-data server: http://127.0.0.1:${actualPort}/`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === SERVER_FILE) {
  startServer();
}





