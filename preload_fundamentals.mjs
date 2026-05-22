import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, "data", "cache", "node");
const WATCHLIST_PATH = join(ROOT, "data", "watchlist.json");
const ENV = loadEnv();
const FMP_API_KEYS = [
  ENV.FMP_API_KEY,
  ENV.FMP_API_KEY_BACKUP,
  ...(ENV.FMP_API_KEYS || "").split(",")
].map((key) => String(key || "").trim()).filter(Boolean);
const ALPHA_VANTAGE_API_KEY = ENV.ALPHA_VANTAGE_API_KEY || "";
const DEFAULT_DAILY_LIMIT = 80;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const FMP_ENDPOINTS = [
  ["profile", "profile", 7],
  ["quote", "quote", 1],
  ["ratios_ttm", "ratios-ttm", 7],
  ["target", "price-target-consensus", 1],
  ["financial_scores", "financial-scores", 7],
  ["income_q", "income-statement", 7, { period: "quarter", limit: "6" }]
];

function loadEnv() {
  const env = { ...process.env };
  try {
    const text = readFileSync(join(ROOT, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#") || !clean.includes("=")) continue;
      const [key, ...value] = clean.split("=");
      env[key.trim()] = value.join("=").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional.
  }
  return env;
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function loadWatchlist() {
  const data = loadJson(WATCHLIST_PATH, { symbols: [] });
  return [...new Set((data.symbols || []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const explicitSymbols = args.filter((arg) => !arg.startsWith("--")).map((arg) => arg.toUpperCase());
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : DEFAULT_DAILY_LIMIT;
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    alpha: args.includes("--alpha"),
    essentialsOnly: args.includes("--essentials-only"),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(250, Math.floor(limit)) : DEFAULT_DAILY_LIMIT,
    symbols: explicitSymbols.length ? explicitSymbols : loadWatchlist()
  };
}

function isUsStockSymbol(symbol) {
  return /^[A-Z]{1,5}$/.test(symbol) && !["VOO", "SPY", "QQQ", "DIA", "IWM", "VTI", "IVV", "SMH"].includes(symbol);
}

function cachePath(key) {
  return join(CACHE_DIR, `${key}.json`);
}

function cacheIsFresh(key, maxAgeMs = CACHE_MAX_AGE_MS) {
  const path = cachePath(key);
  if (!existsSync(path)) return false;
  const raw = loadJson(path, null);
  if (!raw?.savedAt || Date.now() - Number(raw.savedAt) > maxAgeMs || raw.data === undefined) return false;
  if (Array.isArray(raw.data) && !raw.data.length) return false;
  return true;
}

async function writeSupplementalCache(key, data) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(key), JSON.stringify({ savedAt: Date.now(), data }));
}

function isFmpError(data) {
  const text = JSON.stringify(data || {});
  return !data || /limit|invalid api key|not available|upgrade|premium|error/i.test(text);
}

async function fetchFmp(endpoint, symbol, extra = {}) {
  for (const key of FMP_API_KEYS) {
    const params = new URLSearchParams({ symbol, ...extra, apikey: key });
    const response = await fetch(`https://financialmodelingprep.com/stable/${endpoint}?${params.toString()}`, {
      headers: { "User-Agent": "StockLens local scanner" }
    });
    if (!response.ok) continue;
    const data = await response.json();
    if (!isFmpError(data)) return data;
  }
  return null;
}

async function fetchAlpha(functionName, symbol) {
  if (!ALPHA_VANTAGE_API_KEY) return null;
  const url = `https://www.alphavantage.co/query?function=${encodeURIComponent(functionName)}&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(ALPHA_VANTAGE_API_KEY)}`;
  const response = await fetch(url, { headers: { "User-Agent": "StockLens local scanner" } });
  if (!response.ok) return null;
  const data = await response.json();
  const text = `${data?.Note || ""} ${data?.Information || ""}`;
  if (/limit|sparingly|premium|25 requests/i.test(text)) return null;
  return data;
}

function buildFmpBundle(symbol) {
  const read = (key) => loadJson(cachePath(key), null)?.data ?? null;
  return {
    profile: Array.isArray(read(`fmp_profile_${symbol}`)) ? read(`fmp_profile_${symbol}`)[0] || null : read(`fmp_profile_${symbol}`),
    quote: Array.isArray(read(`fmp_quote_${symbol}`)) ? read(`fmp_quote_${symbol}`)[0] || null : read(`fmp_quote_${symbol}`),
    income: Array.isArray(read(`fmp_income_q_${symbol}`)) ? read(`fmp_income_q_${symbol}`) : [],
    ratios: Array.isArray(read(`fmp_ratios_ttm_${symbol}`)) ? read(`fmp_ratios_ttm_${symbol}`)[0] || null : read(`fmp_ratios_ttm_${symbol}`),
    estimates: [],
    targetConsensus: Array.isArray(read(`fmp_target_${symbol}`)) ? read(`fmp_target_${symbol}`)[0] || null : read(`fmp_target_${symbol}`),
    financialScores: Array.isArray(read(`fmp_financial_scores_${symbol}`)) ? read(`fmp_financial_scores_${symbol}`)[0] || null : read(`fmp_financial_scores_${symbol}`),
    source: { source: "fmp", status: "ok", updatedAt: new Date().toISOString() }
  };
}

async function main() {
  const options = parseArgs();
  const symbols = options.symbols.filter(isUsStockSymbol);
  const plan = [];

  for (const symbol of symbols) {
    for (const [kind, endpoint, days, extra = {}] of FMP_ENDPOINTS) {
      if (options.essentialsOnly && !["profile", "quote", "ratios_ttm", "target"].includes(kind)) continue;
      const key = `fmp_${kind}_${symbol}`;
      if (options.force || !cacheIsFresh(key, days * 24 * 60 * 60 * 1000)) plan.push({ symbol, kind, endpoint, extra, source: "fmp" });
    }
    if (options.alpha) {
      if (options.force || !cacheIsFresh(`alpha_overview_${symbol}`)) plan.push({ symbol, kind: "overview", source: "alpha", functionName: "OVERVIEW" });
      if (options.force || !cacheIsFresh(`alpha_earnings_${symbol}`)) plan.push({ symbol, kind: "earnings", source: "alpha", functionName: "EARNINGS" });
    }
  }

  const limitedPlan = plan.slice(0, options.limit);
  if (options.dryRun) {
    console.log(JSON.stringify({
      fmpKeys: FMP_API_KEYS.length,
      alphaKeyPresent: Boolean(ALPHA_VANTAGE_API_KEY),
      limit: options.limit,
      targetSymbols: symbols.length,
      plannedCalls: limitedPlan.length,
      skippedAsNonUsStock: options.symbols.filter((symbol) => !isUsStockSymbol(symbol)),
      firstCalls: limitedPlan.slice(0, 12)
    }, null, 2));
    return;
  }

  if (!FMP_API_KEYS.length && !options.alpha) throw new Error("FMP_API_KEY is missing");

  const results = [];
  for (const item of limitedPlan) {
    if (item.source === "fmp") {
      const data = await fetchFmp(item.endpoint, item.symbol, item.extra);
      if (data === null || (Array.isArray(data) && !data.length)) {
        results.push({ symbol: item.symbol, kind: item.kind, source: "fmp", status: "empty" });
        continue;
      }
      await writeSupplementalCache(`fmp_${item.kind}_${item.symbol}`, data);
      results.push({ symbol: item.symbol, kind: item.kind, source: "fmp", status: "ok" });
      continue;
    }

    const data = await fetchAlpha(item.functionName, item.symbol);
    if (!data) {
      results.push({ symbol: item.symbol, kind: item.kind, source: "alpha", status: "empty_or_limited" });
      continue;
    }
    await writeSupplementalCache(`alpha_${item.kind}_${item.symbol}`, data);
    results.push({ symbol: item.symbol, kind: item.kind, source: "alpha", status: "ok" });
  }

  const bundled = [];
  for (const symbol of symbols) {
    const bundle = buildFmpBundle(symbol);
    if (bundle.profile || bundle.quote || bundle.income.length || bundle.ratios || bundle.targetConsensus) {
      await writeSupplementalCache(`fmp_bundle_${symbol}`, bundle);
      bundled.push(symbol);
    }
  }

  console.log(JSON.stringify({
    requested: results.length,
    ok: results.filter((item) => item.status === "ok").length,
    empty: results.filter((item) => item.status !== "ok").length,
    bundled: bundled.length,
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
