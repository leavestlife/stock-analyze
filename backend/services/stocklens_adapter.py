from __future__ import annotations

import asyncio
import ast
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import requests


ROOT = Path(__file__).resolve().parents[2]
STOCKLENS_CACHE_DIR = ROOT / "data" / "cache" / "stocklens"
STOCKLENS_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def is_korean_symbol(symbol: str) -> bool:
    code = symbol.split(".")[0]
    return len(code) == 6 and code.isdigit()


def normalize_kr_code(symbol: str) -> str:
    return symbol.split(".")[0]


def _cache_path(code: str) -> Path:
    return STOCKLENS_CACHE_DIR / f"{code}.csv"


def _is_fresh(path: Path, ttl_hours: int) -> bool:
    if not path.exists():
        return False
    modified = datetime.fromtimestamp(path.stat().st_mtime)
    return datetime.now() - modified < timedelta(hours=ttl_hours)


def load_stocklens_history(symbol: str, count: int = 800, ttl_hours: int = 6) -> pd.DataFrame:
    code = normalize_kr_code(symbol)
    path = _cache_path(code)
    if _is_fresh(path, ttl_hours):
        cached = pd.read_csv(path, parse_dates=["date"])
        if len(cached) >= min(count, 300):
            return cached

    frame = _load_from_installed_stocklens(code, count)
    if frame is None or frame.empty:
        frame = _load_from_naver_fchart(code, count)

    if frame.empty:
        if path.exists():
            return pd.read_csv(path, parse_dates=["date"])
        raise ValueError(f"StockLens/Naver returned no price data for {code}")

    frame.to_csv(path, index=False)
    return frame


def _load_from_installed_stocklens(code: str, count: int) -> pd.DataFrame | None:
    try:
        from stock_mcp_server.naver import get_ohlcv
    except Exception:
        return None

    try:
        rows = asyncio.run(get_ohlcv(code, "day", count))
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            rows = loop.run_until_complete(get_ohlcv(code, "day", count))
        finally:
            loop.close()
    except Exception:
        return None

    return _rows_to_frame(rows)


def _load_from_naver_fchart(code: str, count: int) -> pd.DataFrame:
    response = requests.get(
        "https://fchart.stock.naver.com/siseJson.nhn",
        params={"symbol": code, "timeframe": "day", "count": count, "requestType": "0"},
        timeout=15,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    response.raise_for_status()
    rows = []
    for raw_line in response.text.strip().splitlines():
        line = raw_line.strip().rstrip(",")
        if not line or "날짜" in line or line == "]":
            continue
        try:
            parsed = ast.literal_eval(line)
        except (SyntaxError, ValueError):
            continue
        if len(parsed) < 6:
            continue
        rows.append(
            {
                "date": parsed[0],
                "open": parsed[1],
                "high": parsed[2],
                "low": parsed[3],
                "close": parsed[4],
                "volume": parsed[5],
            }
        )
    return _rows_to_frame(rows)


def _rows_to_frame(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume"])
    frame = pd.DataFrame(rows)
    frame["date"] = pd.to_datetime(frame["date"].astype(str), errors="coerce")
    for column in ["open", "high", "low", "close", "volume"]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame[["date", "open", "high", "low", "close", "volume"]].dropna()
