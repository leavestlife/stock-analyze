import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, "data", "cache", "node");

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

async function importFile(symbol, filePath, source = "yahooQuery2") {
  const data = JSON.parse(await readFile(filePath, "utf8"));
  const rows = yahooRows(data);
  if (!rows.length) {
    return { symbol, rows: 0, reason: data.chart?.error?.description || "no daily rows" };
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${symbol}.json`), JSON.stringify({ savedAt: Date.now(), source, rows }));
  return { symbol, rows: rows.length, source };
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
    console.log(`OK ${result.symbol} ${result.source} rows=${result.rows}`);
  } else {
    console.log(`FAIL ${result.symbol} rows=0 - ${result.reason}`);
    failures += 1;
  }
}

if (failures) process.exitCode = 1;
