import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.mjs";

const OPERATIONAL_TICKERS = ["NVDA", "COST", "SNDK", "GOOG", "GOOGL"];

test("operational detail API smoke for watched US stock tickers", { timeout: 90_000 }, async () => {
  const server = createAppServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const results = await Promise.all(OPERATIONAL_TICKERS.map(async (ticker) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/stocks/${ticker}`);
      assert.equal(response.status, 200, `${ticker} detail API should return 200`);
      return [ticker, await response.json()];
    }));

    for (const [ticker, payload] of results) {
      assert.equal(payload.ticker, ticker);
      assert.equal(payload.classification?.assetType, "stock");
      assert.equal(payload.classification?.label, "개별종목");
      assert.ok(payload.classification?.reason);
      assert.ok(payload.sourceStatus?.price);
      assert.ok(payload.trust?.label);
      assert.equal(typeof payload.generatedAt, "undefined");
      assert.ok(Object.hasOwn(payload, "score"));
      assert.ok(Object.hasOwn(payload, "entry"));
    }
  } finally {
    server.close();
  }
});
