from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from backend.backtest.engine import backtest_variant
from backend.backtest.variants import VARIANTS
from backend.services.scoring import score_security


def make_history(rows: int = 420) -> pd.DataFrame:
    dates = pd.date_range("2023-01-01", periods=rows, freq="B")
    base = np.linspace(100, 170, rows)
    wave = np.sin(np.linspace(0, 18, rows)) * 4
    close = base + wave
    high = close * 1.015
    low = close * 0.985
    open_ = close * 0.995
    volume = np.linspace(1_000_000, 1_800_000, rows)
    return pd.DataFrame(
        {
            "date": dates,
            "open": open_,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
    )


class ScoringTest(unittest.TestCase):
    def test_score_security_returns_required_fields(self):
        meta = {
            "ticker": "TEST",
            "yf_symbol": "TEST",
            "company": "테스트",
            "market": "us",
            "sector": "Test",
            "industry": "Test",
            "asset_type": "stock",
        }
        result = score_security(meta, make_history())
        for key in ["score", "entry", "verdict", "canSlimScore", "rsRating", "tradePlan", "canslim", "technical"]:
            self.assertIn(key, result)
        self.assertGreaterEqual(result["score"], 0)
        self.assertLessEqual(result["score"], 100)
        self.assertGreaterEqual(result["entry"], 0)
        self.assertLessEqual(result["entry"], 100)

    def test_backtest_variant_returns_metrics(self):
        result = backtest_variant(make_history(), VARIANTS[3])
        self.assertEqual(result["name"], "V4_HYBRID")
        self.assertGreater(result["samples"], 0)
        self.assertIn("edge", result)


if __name__ == "__main__":
    unittest.main()
