from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

from .stocklens_adapter import is_korean_symbol, load_stocklens_history


ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT / "data" / "cache" / "prices"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _cache_path(symbol: str) -> Path:
    safe_symbol = symbol.replace(".", "_").replace("^", "")
    return CACHE_DIR / f"{safe_symbol}.csv"


def _is_fresh(path: Path, ttl_hours: int) -> bool:
    if not path.exists():
        return False
    modified = datetime.fromtimestamp(path.stat().st_mtime)
    return datetime.now() - modified < timedelta(hours=ttl_hours)


def load_price_history(symbol: str, period: str = "3y", ttl_hours: int = 6) -> pd.DataFrame:
    if is_korean_symbol(symbol):
        return load_stocklens_history(symbol, ttl_hours=ttl_hours)

    path = _cache_path(symbol)
    if _is_fresh(path, ttl_hours):
        return pd.read_csv(path, parse_dates=["date"])

    frame = yf.download(symbol, period=period, interval="1d", auto_adjust=True, progress=False)
    if frame.empty:
        if path.exists():
            return pd.read_csv(path, parse_dates=["date"])
        raise ValueError(f"No price data returned for {symbol}")

    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = frame.columns.get_level_values(0)

    frame = frame.reset_index()
    frame.columns = [str(column).lower().replace(" ", "_") for column in frame.columns]
    frame = frame.rename(columns={"adj_close": "close"})
    required = ["date", "open", "high", "low", "close", "volume"]
    frame = frame[[column for column in required if column in frame.columns]].dropna()
    frame.to_csv(path, index=False)
    return frame
