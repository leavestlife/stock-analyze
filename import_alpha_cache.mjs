import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, "data", "cache", "node");

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

async function importFile(symbol, filePath) {
  const data = JSON.parse(await readFile(filePath, "utf8"));
  const rows = alphaRows(data);
  if (!rows.length) {
    const reason = data.Note || data.Information || data["Error Message"] || "no daily rows";
    return { symbol, rows: 0, reason };
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${symbol}.json`), JSON.stringify({ savedAt: Date.now(), source: "alphaVantage", rows }));
  await writeFile(join(CACHE_DIR, `alpha_daily_${symbol}.json`), JSON.stringify({ savedAt: Date.now(), data: rows }));
  return { symbol, rows: rows.length };
}

const args = process.argv.slice(2);
const pairs = [];
for (let index = 0; index < args.length; index += 2) {
  if (!args[index] || !args[index + 1]) break;
  pairs.push([args[index].toUpperCase(), args[index + 1]]);
}

let failures = 0;
for (const [symbol, filePath] of pairs) {
  const result = await importFile(symbol, filePath);
  if (result.rows) {
    console.log(`OK ${result.symbol} alphaVantage rows=${result.rows}`);
  } else {
    console.log(`FAIL ${result.symbol} rows=0 - ${result.reason}`);
    failures += 1;
  }
}

if (failures) process.exitCode = 1;
