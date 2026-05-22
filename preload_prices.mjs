import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, "data", "cache", "node");
const ENV = loadEnv();
const ALPHA_VANTAGE_API_KEY = ENV.ALPHA_VANTAGE_API_KEY || "";
const SEC_USER_AGENT = ENV.SEC_USER_AGENT || "StockLens local scanner contact@example.com";

const CORE_SYMBOLS = [
  "AAPL",
  "GOOGL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "TSLA",
  "MU",
  "AMD",
  "AVGO",
  "HWM",
  "TXN",
  "NXPI",
  "WDC",
  "VOO",
  "SPY",
  "QQQ"
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

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": SEC_USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function yahooRows(data) {
  const result = data.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote || !timestamps.length) return [];
  return timestamps.map((time, index) => ({
    date: new Date(time * 1000).toISOString().slice(0, 10),
    open: quote.open[index],
    high: quote.high[index],
    low: quote.low[index],
    close: quote.close[index],
    volume: quote.volume[index]
  })).filter((row) => [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite));
}

function alphaRows(data) {
  const series = data["Time Series (Daily)"];
  if (!series) return [];
  return Object.entries(series)
    .map(([date, row]) => ({
      date,
      open: Number(row["1. open"]),
      high: Number(row["2. high"]),
      low: Number(row["3. low"]),
      close: Number(row["4. close"]),
      volume: Number(row["5. volume"])
    }))
    .filter((row) => [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function writePriceCache(symbol, rows, source) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${symbol}.json`), JSON.stringify({ savedAt: Date.now(), source, rows }));
}

async function writeSupplementalCache(key, data) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify({ savedAt: Date.now(), data }));
}

async function preloadSymbol(symbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1d`;
  try {
    const yahooData = await fetchJson(yahooUrl);
    const rows = yahooRows(yahooData);
    if (rows.length >= 40) {
      await writePriceCache(symbol, rows, "yahoo");
      return { symbol, source: "yahoo", rows: rows.length };
    }
  } catch {
    // Try Yahoo query2 before Alpha Vantage.
  }

  const yahoo2Url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  try {
    const yahoo2Data = await fetchJson(yahoo2Url);
    const rows = yahooRows(yahoo2Data);
    if (rows.length >= 40) {
      await writePriceCache(symbol, rows, "yahooQuery2");
      return { symbol, source: "yahooQuery2", rows: rows.length };
    }
  } catch {
    // Fall through to Alpha Vantage.
  }

  if (!ALPHA_VANTAGE_API_KEY) {
    return { symbol, source: "none", rows: 0, error: "Yahoo failed and Alpha Vantage key is missing" };
  }

  let alphaData;
  try {
    const alphaUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${ALPHA_VANTAGE_API_KEY}`;
    alphaData = await fetchJson(alphaUrl);
  } catch (error) {
    return { symbol, source: "none", rows: 0, error: `Alpha Vantage request failed: ${error.message}` };
  }

  const rows = alphaRows(alphaData);
  if (!rows.length) {
    return {
      symbol,
      source: "none",
      rows: 0,
      error: alphaData.Note || alphaData.Information || alphaData["Error Message"] || "Alpha Vantage response has no daily rows"
    };
  }
  await writePriceCache(symbol, rows, "alphaVantage");
  await writeSupplementalCache(`alpha_daily_${symbol}`, rows);
  return { symbol, source: "alphaVantage", rows: rows.length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestedSymbols() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
  return args.length ? args.map((item) => item.toUpperCase()) : CORE_SYMBOLS;
}

async function main() {
  const symbols = requestedSymbols();
  if (process.argv.includes("--dry-run")) {
    console.log(`Targets ${symbols.length}: ${symbols.join(", ")}`);
    console.log(`Alpha Vantage key: ${ALPHA_VANTAGE_API_KEY ? "present" : "missing"}`);
    return;
  }

  let failures = 0;
  for (const [index, symbol] of symbols.entries()) {
    const result = await preloadSymbol(symbol);
    const status = result.rows ? "OK" : "FAIL";
    const suffix = result.error ? ` - ${result.error}` : "";
    console.log(`${status} ${result.symbol} ${result.source} rows=${result.rows}${suffix}`);
    if (!result.rows) failures += 1;
    if (index < symbols.length - 1 && result.source === "alphaVantage") await sleep(1300);
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
