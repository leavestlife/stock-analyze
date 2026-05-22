# 실사용 실데이터 검색/분석 설계

## 목표

검색창에 티커나 회사명 별칭을 넣었을 때 임시 후보가 아니라 실제 종목으로 확정하고, 가능한 범위에서 가격 히스토리와 보조 데이터를 연결해 실제 점수와 상세 팝업을 보여준다.

우선순위는 사용자가 승인한 순서대로 진행한다.

1. 미국 개별주
2. 미국 ETF
3. 한국 주식/ETF

## 성공 기준

- `google`, `googl`, `alphabet` 입력 시 `GOOGL` 개별종목으로 확정된다.
- `mu`, `micron` 입력 시 `MU` 개별종목으로 확정된다.
- `nvidia`, `nvda` 입력 시 `NVDA` 개별종목으로 확정된다.
- `voo`, `spy`, `qqq` 입력 시 ETF로 확정되고 ETF임이 표시된다.
- `005930`, `삼성전자` 입력 시 한국 개별종목으로 확정된다.
- 실제 가격 히스토리를 가져오지 못하면 fallback 점수를 만들되, 실패 원인과 필요한 조치가 화면에 표시된다.
- 검색 결과에 임시 후보를 추가하는 기존 프론트 fallback은 API 서버 모드에서는 사용하지 않는다.

## 1단계: 미국 개별주

### 검색어 해석

서버에 검색어 해석 레이어를 추가한다.

- 입력값을 정규화한다: 공백 제거, 대문자 변환, 한글/영문 별칭 처리
- 로컬 별칭 사전을 먼저 본다
- Yahoo Search API를 두 번째로 본다
- Yahoo가 실패하면 티커 패턴 기반으로 개별주 후보를 만든다

초기 별칭 사전에는 최소 다음 항목을 넣는다.

- `google`, `alphabet` -> `GOOGL`
- `nvidia`, `엔비디아` -> `NVDA`
- `micron`, `마이크론` -> `MU`
- `apple`, `애플` -> `AAPL`
- `tesla`, `테슬라` -> `TSLA`
- `microsoft`, `msft` -> `MSFT`
- `amazon`, `amzn` -> `AMZN`
- `meta`, `facebook` -> `META`

### 가격 데이터

가격 히스토리는 기존 Yahoo chart API를 사용한다. 성공하면 `data/cache/node/{SYMBOL}.json`에 저장한다.

실패 시에는 다음 순서로 처리한다.

1. 기존 캐시 사용
2. raw cache 사용
3. Yahoo chart API 재시도
4. fallback detail 반환

fallback인 경우에도 `classification`, `sourceStatus`, `trust`, `errors`를 함께 내려서 사용자가 왜 실제 점수가 아닌지 알 수 있게 한다.

## 2단계: 미국 ETF

ETF는 개별주와 같은 CAN SLIM 재무 점수로 해석하면 오해가 생기므로 분리한다.

- `KNOWN_US_ETFS`와 Yahoo quote metadata로 ETF를 판별한다.
- ETF는 `classification.label = ETF`로 표시한다.
- ETF 상세에서는 CAN SLIM 재무 요소보다 추세, 변동성, 구성/유동성, MDD 중심으로 설명한다.
- ETF도 가격 히스토리와 차트는 동일한 Yahoo chart API를 사용한다.

초기 ETF allowlist:

- `VOO`, `SPY`, `QQQ`, `IWM`, `DIA`, `TLT`, `GLD`, `IVV`, `VTI`, `XLK`, `XLF`, `XLE`, `ARKK`

## 3단계: 한국 주식/ETF

한국장은 검색어 해석과 공시 연결을 별도로 처리한다.

- 6자리 숫자는 한국 종목 코드로 본다.
- `.KS`, `.KQ` suffix를 허용한다.
- 주요 별칭을 로컬 사전에 둔다: `삼성전자`, `하이닉스`, `네이버`, `카카오`, `현대차`
- 가격은 기존 Naver chart 경로를 사용한다.
- 공시는 DART corp code가 있는 경우 DART API를 사용한다.
- corp code가 없으면 DART 검색 링크를 제공하고 source status를 `fallback`으로 둔다.

## 데이터 상태 표시

상세 팝업에는 다음 상태를 명확히 보여준다.

- 분류 근거: 개별종목/ETF, 출처, 신뢰도, 이유
- 데이터 신뢰도: 가격/Alpha Vantage/DART/SEC 연결 상태
- 점수 참고 경고: 가격 히스토리 fallback 또는 신뢰도 낮음일 때 표시
- 실패 원인: API 연결 실패, 캐시 없음, 히스토리 부족, 키 없음

## 프론트 동작

서버 모드에서는 검색어를 서버에 넘기고 서버 결과만 표시한다.

- API 결과가 비어 있으면 임시 후보를 만들지 않는다.
- 대신 “실데이터를 불러오지 못했습니다” 행을 표시한다.
- 종목 클릭 시 상세 API가 fallback을 반환하더라도 팝업은 열리며, 이유를 표시한다.
- file:// 모드에서는 기존 샘플 fallback을 유지한다.

## 테스트

서버 계약 테스트를 추가한다.

- `google` -> `GOOGL`, 개별종목
- `mu` -> `MU`, 개별종목
- `voo` -> ETF
- `005930` -> 한국 개별종목
- API 실패 시에도 classification/trust/errors shape 유지

프론트 문법 검사는 기존처럼 `node --check app.js`로 확인한다.

## 제외 범위

- 유료 실시간 시세
- 초단타 호가/틱 데이터
- 모든 한국 종목명 전체 검색 DB
- 투자 추천 확정 문구

이번 단계는 “실제 후보군 압축기”로 사용할 수 있는 안정적인 검색/데이터 연결을 목표로 한다.
