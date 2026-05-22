UNIVERSE = [
    {
        "ticker": "HWM",
        "yf_symbol": "HWM",
        "company": "하우멧 에어로",
        "market": "us",
        "sector": "Aerospace & Defense",
        "industry": "항공 부품 · 금속 가공",
        "asset_type": "stock",
    },
    {
        "ticker": "TXN",
        "yf_symbol": "TXN",
        "company": "텍사스 인스트루먼트",
        "market": "us",
        "sector": "Semiconductors",
        "industry": "아날로그 반도체",
        "asset_type": "stock",
    },
    {
        "ticker": "NXPI",
        "yf_symbol": "NXPI",
        "company": "NXP 반도체",
        "market": "us",
        "sector": "Semiconductors",
        "industry": "차량용 반도체",
        "asset_type": "stock",
    },
    {
        "ticker": "AAPL",
        "yf_symbol": "AAPL",
        "company": "애플",
        "market": "us",
        "sector": "Consumer Electronics",
        "industry": "스마트폰 · 서비스",
        "asset_type": "stock",
    },
    {
        "ticker": "WDC",
        "yf_symbol": "WDC",
        "company": "웨스턴 디지털",
        "market": "us",
        "sector": "Computer Hardware",
        "industry": "스토리지 · 메모리",
        "asset_type": "stock",
    },
    {
        "ticker": "005930",
        "yf_symbol": "005930.KS",
        "company": "삼성전자",
        "market": "kr",
        "sector": "반도체",
        "industry": "메모리 · 파운드리",
        "asset_type": "stock",
        "dart_code": "00126380",
    },
    {
        "ticker": "000660",
        "yf_symbol": "000660.KS",
        "company": "SK하이닉스",
        "market": "kr",
        "sector": "반도체",
        "industry": "HBM · 메모리",
        "asset_type": "stock",
        "dart_code": "00164779",
    },
    {
        "ticker": "KODEX200",
        "yf_symbol": "069500.KS",
        "company": "KODEX 200",
        "market": "etf",
        "sector": "Korea ETF",
        "industry": "코스피200 추종",
        "asset_type": "etf",
    },
    {
        "ticker": "QQQ",
        "yf_symbol": "QQQ",
        "company": "Invesco QQQ Trust",
        "market": "etf",
        "sector": "US ETF",
        "industry": "나스닥100 추종",
        "asset_type": "etf",
    },
    {
        "ticker": "VOO",
        "yf_symbol": "VOO",
        "company": "Vanguard S&P 500 ETF",
        "market": "etf",
        "sector": "US ETF",
        "industry": "S&P 500 추종",
        "asset_type": "etf",
    },
]


def get_universe(market="all"):
    if market == "all":
        return UNIVERSE
    return [item for item in UNIVERSE if item["market"] == market]


def find_security(ticker):
    normalized = ticker.upper()
    for item in UNIVERSE:
        if item["ticker"].upper() == normalized or item["yf_symbol"].upper() == normalized:
            return item
    return None
