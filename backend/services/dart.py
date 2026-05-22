from __future__ import annotations

import os
from datetime import datetime

import requests


DART_BASE_URL = "https://opendart.fss.or.kr/api"


def fetch_basic_financials(corp_code: str | None) -> dict:
    api_key = os.getenv("DART_API_KEY")
    if not api_key or not corp_code:
        return {"available": False, "reason": "DART_API_KEY 또는 corp_code가 없습니다."}

    current_year = datetime.now().year
    for year in range(current_year - 1, current_year - 4, -1):
        params = {
            "crtfc_key": api_key,
            "corp_code": corp_code,
            "bsns_year": str(year),
            "reprt_code": "11011",
            "fs_div": "CFS",
        }
        response = requests.get(f"{DART_BASE_URL}/fnlttSinglAcntAll.json", params=params, timeout=12)
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("list") or []
        if rows:
            return {"available": True, "year": year, "summary": summarize_rows(rows), "rows": rows[:40]}
    return {"available": False, "reason": "최근 3년 사업보고서 재무 데이터를 찾지 못했습니다."}


def summarize_rows(rows: list[dict]) -> dict:
    wanted = {
        "revenue": ["매출액", "수익(매출액)"],
        "operating_income": ["영업이익"],
        "net_income": ["당기순이익"],
        "assets": ["자산총계"],
        "equity": ["자본총계"],
    }
    summary = {}
    for key, names in wanted.items():
        for row in rows:
            if row.get("account_nm") in names and row.get("thstrm_amount"):
                summary[key] = parse_amount(row["thstrm_amount"])
                break
    if summary.get("equity") and summary.get("net_income"):
        summary["roe"] = round(summary["net_income"] / summary["equity"] * 100, 2)
    return summary


def parse_amount(value: str) -> int:
    return int(value.replace(",", "").strip())
