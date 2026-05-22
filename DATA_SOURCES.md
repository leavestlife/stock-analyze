# Data Sources

## No-key free sources already wired

These work without an API key.

- Yahoo chart data
  - Used for US stocks and ETFs price history.
  - Feeds price, change, RSI, ATR, VWAP, moving averages, chart, EntryScore, TotalScore proxies.
  - Can be preloaded into the local cache with `node preload_prices.mjs`.
  - Primary route is `query1.finance.yahoo.com`; if that is rate-limited, the backend retries `query2.finance.yahoo.com` with a browser-like user agent.

### 가격 데이터 fallback 의미

`fallback`은 가짜 투자 성과를 만들었다는 뜻이 아니라, 주 데이터 소스가 실패했거나 키가 없어서 제한된 대체 경로를 썼다는 표시입니다.

- 가격 fallback
  - Yahoo chart 요청이 실패하면 로컬 캐시 또는 Alpha Vantage 일봉 데이터가 가능한 범위에서 사용됩니다.
  - Alpha Vantage 무료 daily endpoint는 최근 compact 구간 중심이라 3년 전체 백테스트에는 부족할 수 있습니다.
  - 그래도 가격, RSI, ATR, 이동평균 등은 실제 가격 row가 있을 때만 계산됩니다.
- 재무/공시 fallback
  - Alpha Vantage, DART, SEC 보강 데이터가 없으면 `missing_key`, `fallback`, `unavailable` 상태로 표시됩니다.
  - 이 경우 점수는 가격/거래량 기반으로 유지되고, 재무/공시 설명은 보수적인 안내 문구로 대체됩니다.
- 해석 기준
  - `ok`: 해당 소스에서 데이터를 정상 사용했습니다.
  - `fallback`: 대체 경로 또는 보수적 기본 설명을 사용했습니다.
  - `missing_key`: API 키가 없어 보강 데이터를 가져오지 않았습니다.
  - `unavailable`: 해당 시장/자산에는 그 소스를 적용하지 않습니다.

- Nasdaq-100 membership list
  - Used as a local search/watchlist universe for US Nasdaq-100 companies.
  - Feeds symbol and company-name lookup only; prices still come from Yahoo or the local cache.
  - Current list includes Alphabet's two tickers, `GOOGL` and `GOOG`, so the universe has 101 symbols for 100 companies.
  - Refresh trigger: Nasdaq annual reconstitution, special index replacements, or major corporate actions.
  - Current notable replacement reflected in the local list: Sandisk (`SNDK`) joined before market open on 2026-04-20, replacing Atlassian (`TEAM`).
  - Latest quality check on 2026-05-20 found one likely pending update: Nasdaq announced Lumentum (`LITE`) would replace CoStar Group (`CSGP`) before market open on 2026-05-18. The current local code still has `CSGP` and does not have `LITE`.
  - Reference sources:
    - https://stockanalysis.com/list/nasdaq-100-stocks/
    - https://ir.nasdaq.com/news-releases/news-release-details/sandisk-corporation-join-nasdaq-100-indexr-beginning-april-20
    - https://www.nasdaq.com/press-release/lumentum-holdings-inc-join-nasdaq-100-indexr-beginning-may-18-2026-2026-05-09

## Nasdaq-100 data quality check

Checked on 2026-05-20 against the local `NASDAQ100_COMPANIES` array in `server.mjs`.

- Local count: 101 tickers.
- Duplicate tickers: none found.
- ETF contamination: none found. All entries are mapped as `stock`; ETF universe entries live separately in `US_REPRESENTATIVE_ETFS`.
- Known valid 101-count reason: Alphabet has both `GOOG` and `GOOGL`.
- Official-update mismatch to review:
  - Missing candidate: `LITE` (Lumentum Holdings).
  - Extra candidate: `CSGP` (CoStar Group), because Nasdaq announced `LITE` replacing `CSGP` effective before market open on 2026-05-18.
- Third-party list disagreement:
  - Some public lists still show older combinations such as `TEAM` or `CSGP`; treat those as secondary evidence.
  - Nasdaq official press releases should win when they conflict with list aggregators.

- Naver chart data
  - Used for Korea stocks and Korea ETFs price history.
  - Feeds price, change, RSI, ATR, VWAP, moving averages, chart, EntryScore, TotalScore proxies.

- SEC EDGAR links
  - Used for US filing navigation.
  - The app links directly to SEC search/filing pages.
  - SEC automated metadata requests may require a proper `SEC_USER_AGENT`; without that, the app still shows direct SEC links.

- DART public search links
  - Used for Korea filing navigation.
  - The app links directly to DART company filing search.

- Naver News search links
  - Used for Korea/US news navigation until a news API key is added.

## Free key recommended

These are free-tier APIs, but require a key.

### 1. Alpha Vantage

Environment variable:

```text
ALPHA_VANTAGE_API_KEY=
```

Use in this app:

- US company overview
- PER/PBR/ROE/EPS
- profit margin
- market cap
- analyst target price
- quarterly earnings and EPS surprise
- Price fallback when Yahoo blocks a symbol request. The free daily endpoint currently provides compact recent daily data, not a full 3-year history.

Get key:

```text
https://www.alphavantage.co/support/#api-key
```

### 2. OpenDART

Environment variable:

```text
DART_API_KEY=
```

Use in this app:

- Korea company financial statements
- revenue
- operating profit
- net income
- debt ratio
- ROE
- operating margin

Get key:

```text
https://opendart.fss.or.kr/
```

### 3. SEC User-Agent

Environment variable:

```text
SEC_USER_AGENT=StockLens local scanner your-email@example.com
```

This is not an API key, but SEC asks automated tools to identify themselves.

Use in this app:

- More reliable SEC EDGAR metadata requests
- Filing list enrichment when SEC accepts the request

## Optional later keys

These are not required now. Add only if the free sources above are not enough.

- Finnhub
  - Analyst recommendation trends, earnings calendar, company news, ownership data.
  - Usually needs a free API token.

- Financial Modeling Prep
  - Analyst estimates, earnings, ratios, company profile.
  - Free tier exists, but limits and available endpoints vary.

- News API or GDELT
  - Better news sentiment input.
  - The current app uses news search links and price-based sentiment proxies instead.
