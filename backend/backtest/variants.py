from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from backend.services.indicators import atr, bollinger, macd, rsi, sma, vwap


@dataclass(frozen=True)
class Variant:
    name: str
    high: int
    low: int
    style: str


VARIANTS = [
    Variant("V1_OLD", 75, 30, "reversion"),
    Variant("V2_NEW", 90, 70, "trend"),
    Variant("V3_PURE_REVERSION", 75, 60, "pure_reversion"),
    Variant("V4_HYBRID", 75, 30, "hybrid"),
    Variant("V5_MOMENTUM_PIVOT", 75, 35, "pivot"),
    Variant("V6_PULLBACK", 70, 40, "pullback"),
]


def score_variant(history: pd.DataFrame, variant: Variant) -> int:
    close = history["close"]
    latest_close = float(close.iloc[-1])
    latest_volume = float(history["volume"].iloc[-1])
    avg_volume = float(history["volume"].tail(50).mean())
    latest_rsi = float(rsi(close).iloc[-1])
    latest_atr = float(atr(history).iloc[-1])
    latest_vwap = float(vwap(history).iloc[-1])
    sma20 = float(sma(close, 20).iloc[-1])
    sma50 = float(sma(close, 50).iloc[-1])
    sma200 = float(sma(close, 200).iloc[-1])
    bands = bollinger(close)
    bb_lower = float(bands["lower"].iloc[-1])
    macd_frame = macd(close)
    macd_near_cross = float(macd_frame["hist"].iloc[-1]) > float(macd_frame["hist"].iloc[-2])
    high_52w = float(close.tail(252).max())
    is_uptrend = latest_close > sma50 > sma200
    volume_surge = avg_volume > 0 and latest_volume > avg_volume * 1.5
    near_high = high_52w > 0 and latest_close > high_52w * 0.97
    atr_contracted = latest_atr / latest_close < 0.035 if latest_close else False

    score = 50 if variant.name != "V2_NEW" else 55

    if variant.style in {"reversion", "pure_reversion", "hybrid", "pullback"}:
        if latest_rsi < 30:
            score += 14 if variant.style != "pure_reversion" else 18
        elif latest_rsi < 40:
            score += 8 if variant.style != "pure_reversion" else 12
        if latest_close <= bb_lower * 1.03:
            score += 10
        if abs(latest_close / latest_vwap - 1) < 0.025:
            score += 5

    if variant.style in {"trend", "hybrid", "pivot"}:
        if is_uptrend and volume_surge:
            score += 14
        if is_uptrend and atr_contracted:
            score += 6
        if near_high and volume_surge:
            score += 10
        if macd_near_cross:
            score += 6

    if variant.style == "pullback" and latest_close > sma50 and latest_close <= sma20 * 1.02:
        score += 10

    if latest_rsi > 70:
        score -= 12
    if latest_rsi > 78:
        score -= 8
    if close.pct_change(20).iloc[-1] > 0.25 and latest_rsi > 68:
        score -= 10

    return max(0, min(100, round(score)))
