from __future__ import annotations

from dataclasses import asdict

import pandas as pd

from backend.backtest.variants import VARIANTS, score_variant
from backend.services.cache import load_price_history
from backend.universe import get_universe


def _max_drawdown(values: pd.Series) -> float:
    if values.empty:
        return 0.0
    running_max = values.cummax()
    drawdown = values / running_max - 1
    return float(drawdown.min() * 100)


def backtest_variant(history: pd.DataFrame, variant, min_window: int = 260, step: int = 5) -> dict:
    rows = []
    close = history["close"].reset_index(drop=True)
    frame = history.reset_index(drop=True)
    for end in range(min_window, len(frame) - 20, step):
        window = frame.iloc[:end].copy()
        score = score_variant(window, variant)
        base = float(close.iloc[end - 1])
        future_10 = float(close.iloc[end + 9])
        future_20 = close.iloc[end : end + 20]
        if not base:
            continue
        rows.append(
            {
                "score": score,
                "return_10d": (future_10 / base - 1) * 100,
                "mdd_20d": _max_drawdown(future_20 / base),
            }
        )

    if not rows:
        return {**asdict(variant), "samples": 0, "green_ratio": 0, "green_return_10d": 0, "edge": 0, "win_rate": 0, "mdd_20d": 0}

    result = pd.DataFrame(rows)
    green = result[result["score"] >= variant.high]
    baseline = float(result["return_10d"].mean())
    if green.empty:
        green_return = 0.0
        edge = 0.0
        win_rate = 0.0
        mdd = 0.0
    else:
        green_return = float(green["return_10d"].mean())
        edge = green_return - baseline
        win_rate = float((green["return_10d"] > 0).mean() * 100)
        mdd = float(green["mdd_20d"].mean())

    return {
        **asdict(variant),
        "samples": int(len(result)),
        "green_ratio": round(len(green) / len(result) * 100, 2),
        "green_return_10d": round(green_return, 2),
        "edge": round(edge, 2),
        "win_rate": round(win_rate, 2),
        "mdd_20d": round(mdd, 2),
    }


def run_backtest(market: str = "all") -> dict:
    securities = get_universe(market)
    combined = {variant.name: [] for variant in VARIANTS}
    errors = []

    for security in securities:
        try:
            history = load_price_history(security["yf_symbol"])
            if len(history) < 300:
                errors.append({"ticker": security["ticker"], "error": "not enough history"})
                continue
            for variant in VARIANTS:
                combined[variant.name].append(backtest_variant(history, variant))
        except Exception as exc:
            errors.append({"ticker": security["ticker"], "error": str(exc)})

    results = []
    for variant in VARIANTS:
        rows = combined[variant.name]
        if not rows:
            results.append({**asdict(variant), "samples": 0, "green_ratio": 0, "green_return_10d": 0, "edge": 0, "win_rate": 0, "mdd_20d": 0})
            continue
        total_samples = sum(row["samples"] for row in rows)
        results.append(
            {
                **asdict(variant),
                "samples": total_samples,
                "green_ratio": round(sum(row["green_ratio"] for row in rows) / len(rows), 2),
                "green_return_10d": round(sum(row["green_return_10d"] for row in rows) / len(rows), 2),
                "edge": round(sum(row["edge"] for row in rows) / len(rows), 2),
                "win_rate": round(sum(row["win_rate"] for row in rows) / len(rows), 2),
                "mdd_20d": round(sum(row["mdd_20d"] for row in rows) / len(rows), 2),
            }
        )

    return {"market": market, "results": results, "errors": errors}
