from __future__ import annotations

import numpy as np
import pandas as pd


def sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window).mean()


def rsi(close: pd.Series, window: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(window).mean()
    loss = (-delta.clip(upper=0)).rolling(window).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def atr(frame: pd.DataFrame, window: int = 14) -> pd.Series:
    high_low = frame["high"] - frame["low"]
    high_close = (frame["high"] - frame["close"].shift()).abs()
    low_close = (frame["low"] - frame["close"].shift()).abs()
    true_range = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    return true_range.rolling(window).mean()


def macd(close: pd.Series) -> pd.DataFrame:
    fast = close.ewm(span=12, adjust=False).mean()
    slow = close.ewm(span=26, adjust=False).mean()
    line = fast - slow
    signal = line.ewm(span=9, adjust=False).mean()
    return pd.DataFrame({"macd": line, "signal": signal, "hist": line - signal})


def bollinger(close: pd.Series, window: int = 20) -> pd.DataFrame:
    middle = sma(close, window)
    stdev = close.rolling(window).std()
    return pd.DataFrame({"middle": middle, "upper": middle + stdev * 2, "lower": middle - stdev * 2})


def vwap(frame: pd.DataFrame) -> pd.Series:
    typical = (frame["high"] + frame["low"] + frame["close"]) / 3
    volume = frame["volume"].replace(0, np.nan)
    return (typical * volume).cumsum() / volume.cumsum()


def pct_change(close: pd.Series, periods: int) -> float:
    if len(close) <= periods:
        return 0.0
    start = close.iloc[-periods]
    end = close.iloc[-1]
    if not start:
        return 0.0
    return float((end / start - 1) * 100)
