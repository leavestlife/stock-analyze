import { readFile, writeFile } from "node:fs/promises";

const us = JSON.parse(await readFile("data/cache/node/api_us.json", "utf8"));
const kr = JSON.parse(await readFile("data/cache/node/api_kr.json", "utf8"));
const items = [...(us.items || []), ...(kr.items || [])];
const generatedAt = new Date().toISOString();

await writeFile(
  "real_data.js",
  `window.REAL_STOCKS = ${JSON.stringify({ items, generatedAt })};\n`,
  "utf8"
);

console.log(`real_data.js generated: ${items.length} items`);
