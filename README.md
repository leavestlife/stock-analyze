# CAN SLIM Quant Scanner

지인에게 공유 가능한 베타 버전의 종목 분석기입니다.  
종목의 품질 점수(`TotalScore`)와 지금 들어갈 만한 자리인지 보는 진입 점수(`EntryScore`)를 분리해서 보여줍니다.

## 실행

프로젝트 폴더에서 아래 파일 하나만 실행하면 됩니다.

```text
start_app.cmd
```

브라우저에서 접속:

```text
http://127.0.0.1:5050/
```

서버 상태:

```text
http://127.0.0.1:5050/api/health
```

## 베타 사용 기준

- 이 앱은 매수/매도 확답 도구가 아니라 후보군 압축 도구입니다.
- 가격, 재무, 뉴스, 공시, 목표가는 무료 API 지연/누락이 있을 수 있습니다.
- 상세 팝업의 데이터 신뢰도와 출처 라인을 확인한 뒤 원자료를 다시 확인하세요.
- 베타 공유 전에는 `/api/health`, `/api/cache/status`, 대표 종목 상세 팝업을 확인하는 것을 권장합니다.

## 데이터 갱신

가격 캐시 갱신:

```powershell
node preload_prices.mjs
```

미국 재무/목표가 캐시 갱신:

```powershell
node preload_fundamentals.mjs --limit=23
```

처음 채울 때는 FMP 무료 한도를 아끼기 위해 핵심 데이터만 먼저 받는 것을 권장합니다.

```powershell
node preload_fundamentals.mjs --essentials-only
```

실행 전 계획만 확인:

```powershell
node preload_fundamentals.mjs --dry-run
```

관심 종목 목록은 `data/watchlist.json`에서 관리합니다.

## 무료 API 키

`.env` 또는 Vercel 환경변수에 아래 값을 넣으면 연결됩니다.

```text
FMP_API_KEY=
FMP_API_KEY_BACKUP=
ALPHA_VANTAGE_API_KEY=
DART_API_KEY=
SEC_USER_AGENT=StockLens local scanner your-email@example.com
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PORTFOLIO_TABLE=stocklens_portfolios
SUPABASE_SNAPSHOT_TABLE=stocklens_analysis_snapshots
SNAPSHOT_TICKERS=NVDA,AAPL,MSFT,GOOGL,AMZN,META,TSLA,MU
CRON_SECRET=
```

현재 우선순위는 `FMP -> Alpha Vantage -> Yahoo/Naver 가격 기반 대체 계산`입니다.

`SUPABASE_SERVICE_ROLE_KEY`는 서버 전용입니다. 브라우저 코드나 공개 저장소에 넣지 마세요.

## Supabase

1. Supabase SQL Editor에서 `supabase/schema.sql`을 실행합니다.
2. Vercel 환경변수에 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`를 넣습니다.
3. 포트폴리오 클라우드 저장/복원과 분석 스냅샷 저장이 활성화됩니다.

스냅샷 조회:

```text
/api/snapshots?ticker=NVDA&limit=10
```

수동 스냅샷 저장:

```text
POST /api/snapshots
{ "tickers": ["NVDA", "AAPL"] }
```

## Vercel 배포

정적 파일은 루트에서 제공하고, API는 `api/[...path].mjs`가 기존 `server.mjs` 로직을 재사용합니다.

Vercel Cron은 평일마다 아래 엔드포인트를 호출해 Supabase에 스냅샷을 저장합니다.

```text
/api/cron/daily-snapshot?limit=30
```

`CRON_SECRET`을 설정했다면 아래처럼 호출해야 합니다.

```text
/api/cron/daily-snapshot?secret=YOUR_SECRET
```

## 배포 주소

```text
https://stock-analyze-delta.vercel.app
```
