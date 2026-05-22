from __future__ import annotations

import math

import pandas as pd

from .indicators import atr, bollinger, macd, pct_change, rsi, sma, vwap


def clamp(value: float, low: int = 0, high: int = 100) -> int:
    if math.isnan(value):
        return low
    return int(max(low, min(high, round(value))))


def _signal(entry_score: int) -> str:
    if entry_score >= 75:
        return "매수"
    if entry_score < 40:
        return "주의"
    return "관망"


def _conviction(total_score: int, entry_score: int) -> str:
    if total_score >= 75 and entry_score >= 60:
        return "높음"
    if total_score >= 60 and entry_score >= 45:
        return "보통"
    return "낮음"


def score_security(meta: dict, history: pd.DataFrame) -> dict:
    frame = history.copy()
    close = frame["close"]
    latest = frame.iloc[-1]
    latest_close = float(latest["close"])
    latest_volume = float(latest["volume"])

    sma20 = sma(close, 20).iloc[-1]
    sma50 = sma(close, 50).iloc[-1]
    sma200 = sma(close, 200).iloc[-1]
    latest_rsi = float(rsi(close).iloc[-1])
    latest_atr = float(atr(frame).iloc[-1])
    latest_vwap = float(vwap(frame).iloc[-1])
    macd_frame = macd(close)
    latest_macd = float(macd_frame["macd"].iloc[-1])
    latest_signal = float(macd_frame["signal"].iloc[-1])
    bands = bollinger(close)
    bb_lower = float(bands["lower"].iloc[-1])
    high_52w = float(close.tail(252).max())
    avg_volume = float(frame["volume"].tail(50).mean())

    momentum_3m = pct_change(close, 63)
    momentum_6m = pct_change(close, 126)
    high_distance = (latest_close / high_52w - 1) * 100 if high_52w else 0
    rs_rating = clamp(50 + momentum_6m * 1.2)

    trend_score = 0
    if latest_close > sma20:
        trend_score += 10
    if latest_close > sma50:
        trend_score += 12
    if latest_close > sma200:
        trend_score += 14
    if sma50 > sma200:
        trend_score += 10

    momentum_score = clamp(50 + momentum_3m + momentum_6m * 0.5)
    new_high_score = clamp(100 + high_distance * 4)
    volume_score = clamp(50 + ((latest_volume / avg_volume) - 1) * 30) if avg_volume else 50
    quality_proxy = 70 if meta["asset_type"] == "etf" else clamp(55 + momentum_6m * 0.3)
    market_score = 62

    canslim_score = clamp(
        trend_score * 0.85
        + momentum_score * 0.24
        + new_high_score * 0.18
        + volume_score * 0.12
        + quality_proxy * 0.16
        + market_score * 0.18
    )
    total_score = clamp(
        canslim_score * 0.48
        + momentum_score * 0.18
        + rs_rating * 0.18
        + quality_proxy * 0.10
        + volume_score * 0.06
    )

    entry_score = 50
    if latest_rsi < 30:
        entry_score += 14
    elif latest_rsi < 40:
        entry_score += 8
    elif latest_rsi > 70:
        entry_score -= 12
    elif latest_rsi > 65:
        entry_score -= 6

    if latest_close <= bb_lower * 1.03:
        entry_score += 10
    if abs(latest_close / latest_vwap - 1) < 0.025:
        entry_score += 5
    if latest_close > sma50 > sma200 and latest_volume > avg_volume * 1.5:
        entry_score += 14
    if latest_close > sma50 > sma200 and latest_atr / latest_close < 0.035:
        entry_score += 6
    if high_distance > -3 and latest_volume > avg_volume * 1.3:
        entry_score += 10
    if latest_macd > latest_signal:
        entry_score += 6
    if momentum_3m > 25 and latest_rsi > 68:
        entry_score -= 10

    entry_score = clamp(entry_score)
    stop = latest_close - latest_atr * 1.8
    target_1 = latest_close + latest_atr * 2.4
    target_2 = latest_close + latest_atr * 3.8

    return {
        **meta,
        "dataSource": "stocklens/naver" if meta.get("yf_symbol", "").split(".")[0].isdigit() else "yfinance",
        "price": round(latest_close, 2),
        "change": round(float(close.pct_change().iloc[-1] * 100), 2),
        "score": total_score,
        "entry": entry_score,
        "verdict": _signal(entry_score),
        "canSlim": canslim_score,
        "canSlimScore": canslim_score,
        "conviction": _conviction(total_score, entry_score),
        "rsRating": rs_rating,
        "mainPoint": build_headline(total_score, entry_score, latest_rsi, meta),
        "subPoint": f"TotalScore {total_score} · EntryScore {entry_score} · RSRating {rs_rating}",
        "finance": {
            "pe": None,
            "peGap": 0,
            "target": round(target_1, 2),
            "targetGap": round((target_1 / latest_close - 1) * 100, 1),
            "rsi": round(latest_rsi, 1),
            "conviction": _conviction(total_score, entry_score),
        },
        "chart": [round(float(value), 2) for value in close.tail(10).tolist()],
        "tradePlan": {
            "buy": round(latest_close, 2),
            "stop": round(stop, 2),
            "target1": round(target_1, 2),
            "target2": round(target_2, 2),
            "atr": round(latest_atr, 2),
        },
        "canslim": [
            ["C", "가격 기준 모멘텀이 최근 분기 실적 가속의 대용 신호로 양호해요", momentum_3m > 5],
            ["A", "장기 추세가 살아 있어 연간 성장 기대가 유지돼요", latest_close > sma200],
            ["N", "52주 신고가권에 가까운 새 추세 후보예요", high_distance > -10],
            ["S", "거래량이 평소보다 강하게 붙었어요", latest_volume > avg_volume * 1.2],
            ["L", f"상대강도 {rs_rating}점으로 시장 대비 강한 편이에요", rs_rating >= 70],
            ["I", "기관 수급 대용 지표인 거래대금 흐름이 양호해요", volume_score >= 60],
        ],
        "support": [
            ["M", "시장 방향은 우호적인 기본값으로 반영했어요", True],
            ["MATH", f"RSI {latest_rsi:.1f} · ATR {latest_atr:.2f} · MACD {'강세' if latest_macd > latest_signal else '약세'}", latest_macd > latest_signal],
            ["SP", f"3개월 모멘텀 {momentum_3m:.1f}%", momentum_3m > 0],
        ],
        "technical": [
            ["RSI", f"RSI {latest_rsi:.1f} 기준으로 {'과열' if latest_rsi > 70 else '중립 또는 눌림'} 구간입니다.", latest_rsi <= 70],
            ["VWAP", "현재가가 VWAP 근처면 눌림 진입 후보로 봅니다.", abs(latest_close / latest_vwap - 1) < 0.025],
            ["MACD", f"MACD는 {'강세' if latest_macd > latest_signal else '약세'} 흐름입니다.", latest_macd > latest_signal],
            ["ATR", "ATR 기반으로 손절/익절 구간을 자동 계산했습니다.", True],
        ],
        "financeRows": build_finance_rows(meta),
        "insight": build_insights(meta, total_score, entry_score, latest_rsi),
    }


def build_headline(total_score: int, entry_score: int, rsi_value: float, meta: dict) -> str:
    if total_score >= 75 and entry_score < 55:
        return "종목 자체는 좋은데\n지금 타점은 조금 비쌉니다"
    if total_score >= 70 and entry_score >= 60:
        return "강한 종목이고\n진입 자리도 나쁘지 않습니다"
    if entry_score < 40:
        return "추격 위험이 커서\n지금은 조심할 자리입니다"
    if meta["asset_type"] == "etf":
        return "개별주 리스크를 줄이고\n시장 방향에 베팅하는 후보입니다"
    return "후보군에는 들어오지만\n확인 신호가 더 필요합니다"


def build_finance_rows(meta: dict) -> list:
    if meta["asset_type"] == "etf":
        return [
            ["구성", meta["industry"], True],
            ["분산도", "높음", True],
            ["유동성", "가격/거래량 기준 확인", True],
            ["주의", "ETF는 EPS/ROE 대신 추세 중심으로 평가", False],
        ]
    return [
        ["매출 성장", "DART/재무 API 연결 예정", False],
        ["이익 성장", "DART/재무 API 연결 예정", False],
        ["품질", "가격·추세 대용 점수 우선 적용", True],
        ["밸류", "yfinance fundamentals 연결 예정", False],
    ]


def build_insights(meta: dict, total_score: int, entry_score: int, rsi_value: float) -> list:
    return [
        ["좋은 점", f"{meta['company']}의 TotalScore는 {total_score}점입니다. 현재 후보군 안에서 상대적인 우선순위를 보여줍니다."],
        ["주의점", f"EntryScore는 {entry_score}점입니다. 좋은 종목이어도 타점이 나쁘면 관망 또는 주의로 내려갑니다."],
        ["전략", "분할 진입 전 RSI, VWAP, 거래량, 손절 가능 폭을 같이 확인하는 구조입니다."],
        ["한줄평", "이 화면은 매수 버튼이 아니라 후보군 압축기입니다."],
    ]
