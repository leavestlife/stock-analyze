# CAN SLIM Quant Scanner

## 실행

프로젝트 폴더에서 아래 파일 하나만 실행하면 됩니다.

```text
start_app.cmd
```

서버 창이 열린 상태로 유지되어야 브라우저에서 앱이 동작합니다.

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

실행 전에 계획만 확인:

```powershell
node preload_fundamentals.mjs --dry-run
```

관심 종목 목록은 `data/watchlist.json`에서 관리합니다.

## 무료 API 키

`.env`에 아래 키를 넣으면 연결됩니다.

```text
FMP_API_KEY=
FMP_API_KEY_BACKUP=
ALPHA_VANTAGE_API_KEY=
DART_API_KEY=
SEC_USER_AGENT=StockLens local scanner your-email@example.com
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PORTFOLIO_TABLE=stocklens_portfolios
```

현재 우선순위는 `FMP -> Alpha Vantage -> Yahoo/Naver 가격 기반 대체 계산`입니다.

FMP 무료 플랜도 종목과 엔드포인트에 따라 일부 값이 제한될 수 있습니다. 이 경우 앱은 `부분 연결`로 표시하고 가능한 값만 사용합니다.

## Supabase 포트폴리오 백업

1. Supabase SQL Editor에서 `supabase/schema.sql`을 실행합니다.
2. `.env` 또는 Vercel 환경변수에 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`를 넣습니다.
3. 앱의 포트폴리오 영역에서 `클라우드 저장` / `클라우드 불러오기`를 사용합니다.

`SUPABASE_SERVICE_ROLE_KEY`는 서버 전용입니다. 브라우저 코드나 공개 저장소에 넣지 마세요.

## Vercel 배포

정적 파일은 루트에서 제공하고, API는 `api/[...path].mjs`가 기존 `server.mjs` 로직을 재사용합니다.

필수 환경변수는 Vercel 프로젝트 설정의 Environment Variables에 넣습니다. 로컬 서버처럼 `.env`를 배포하지 않습니다.

## 상태 확인

앱:

```text
http://127.0.0.1:5050/
```

서버 상태:

```text
http://127.0.0.1:5050/api/health
```

캐시 상태:

```text
http://127.0.0.1:5050/api/cache/status
```
