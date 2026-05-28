const fallbackStocks = [];

const stockRows = document.querySelector("#stockRows");
const searchInput = document.querySelector("#searchInput");
const sectorRail = document.querySelector("#sectorRail");
const modalBackdrop = document.querySelector("#modalBackdrop");
const closeModal = document.querySelector("#closeModal");
const tabContent = document.querySelector("#tabContent");
const cacheStatus = document.querySelector("#cacheStatus");

const sampleUniverse = Array.isArray(window.REAL_STOCKS?.items) ? window.REAL_STOCKS.items : fallbackStocks;
const canUseApi = window.location?.protocol !== "file:";
let stocks = [];
let activeMarket = "us";
let activeView = "scanner";
let activeSector = "__watchlist";
let selectedTicker = "";
let selectedTab = "canslim";
let scanCount = 0;
let apiMode = false;
let modalChartInstance = null;
let searchResultTickers = new Set();
let activeQuickFilter = "all";
let scanHistory = [];
let scanScoreChanges = new Map();
let watchlistAuditCache = null;
const STOCK_LOAD_TIMEOUT_MS = 45000;
const ENRICHMENT_POLL_MS = 8000;
let portfolio = {
  accountSize: 10000,
  holdings: [],
  exchangeRate: null,
  history: []
};
const portfolioQuotes = new Map();
const PORTFOLIO_STORAGE_KEY = "canslimPortfolio.v1";
const PORTFOLIO_CLIENT_ID_KEY = "canslimPortfolio.clientId.v1";
const PORTFOLIO_ACCESS_TOKEN_KEY = "canslimPortfolio.accessToken.v1";
const WATCHLIST_STORAGE_KEY = "canslimWatchlist.v1";
const SCAN_HISTORY_STORAGE_KEY = "canslimScanHistory.v1";
const SCANNED_STOCKS_STORAGE_KEY = "canslimScannedStocks.v1";
const WATCHLIST_SECTOR = "__watchlist";
let watchlist = new Set();
let enrichmentPollTimer = null;
let enrichmentPollCount = 0;

const usInsights = {
  earningsDate: "-",
  earnings: [],
  ownership: [],
  sentiment: { label: "중립", positive: 0, neutral: 0, negative: 0, summary: "데이터를 불러오는 중입니다.", items: [] },
  analysts: [],
  filings: []
};

const krInsights = {
  sentiment: { label: "중립", positive: 0, neutral: 0, negative: 0, summary: "데이터를 불러오는 중입니다.", items: [] },
  earnings: [],
  filings: []
};

const usSectorOrder = [
  "Information Technology (정보통신기술주)",
  "Financial Services (금융)",
  "Health Care (헬스 케어)",
  "Consumer Discretionary/Cyclical (자유/경기 소비재)",
  "Industrial (산업재)",
  "Communication Service (통신 서비스)",
  "Consumer Staples/Defensive (필수 소비재)",
  "Energy (에너지)",
  "Real Estate (부동산)",
  "Materials (소재)",
  "Utility (유틸리티)"
];
function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function priceText(stock, value = stock.price) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  if (stock.market === "kr" || stock.ticker === "KODEX200") {
    return `${Math.round(Number(value)).toLocaleString("ko-KR")}원`;
  }
  return `$${money(value)}`;
}

function isMissingData(stock) {
  return stock?.dataSource === "missing" || stock?.verdict === "데이터 없음" || !Number.isFinite(Number(stock?.price));
}

function percentText(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function visibleStocks() {
  return stocks.filter((stock) => {
    if (activeSector === WATCHLIST_SECTOR) return isWatchedTicker(stock.ticker);
    const marketMatch = activeMarket === "all"
      || stock.market === activeMarket
      || (activeMarket === "us" && stock.sector === "US ETF")
      || (activeMarket === "kr" && stock.sector === "Korea ETF");
    const sectorMatch = activeSector === "all" || stock.sector === activeSector;
    return marketMatch && sectorMatch;
  });
}

function loadWatchlist() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY) || "[]");
    watchlist = new Set(Array.isArray(parsed) ? parsed.map((ticker) => String(ticker).toUpperCase()).filter(Boolean) : []);
  } catch {
    watchlist = new Set();
  }
}

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify([...watchlist].sort()));
  persistCloudWatchlist();
}

function watchlistCloudHeaders(extra = {}) {
  return portfolioCloudHeaders(extra);
}

async function persistCloudWatchlist() {
  if (!canUseApi) return;
  try {
    await fetch("/api/watchlist", {
      method: "POST",
      headers: watchlistCloudHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ clientId: portfolioClientId(), tickers: [...watchlist].sort() })
    });
  } catch {
    // 로컬 관심 목록은 유지합니다.
  }
}

async function loadCloudWatchlist() {
  if (!canUseApi) return;
  try {
    const response = await fetch(`/api/watchlist?clientId=${encodeURIComponent(portfolioClientId())}`, {
      headers: watchlistCloudHeaders()
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    const incoming = Array.isArray(payload.tickers) ? payload.tickers.map((ticker) => String(ticker).toUpperCase()) : [];
    if (!incoming.length) {
      await persistCloudWatchlist();
      return;
    }
    watchlist = new Set([...watchlist, ...incoming]);
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify([...watchlist].sort()));
  } catch {
    // 서버 저장소가 없어도 로컬 관심 목록으로 계속 진행합니다.
  }
}

async function refreshWatchlistReliability() {
  if (!canUseApi || !watchlist.size) {
    setWatchlistStatus(watchlist.size ? "관심 종목 신뢰도 점검 대기" : "첫 화면은 관심 종목부터 보여줍니다.");
    return;
  }
  try {
    const response = await fetch(`/api/watchlist/audit?clientId=${encodeURIComponent(portfolioClientId())}`, {
      headers: watchlistCloudHeaders()
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "audit failed");
    watchlistAuditCache = payload;
    const needs = Array.isArray(payload.needsEnrichment) ? payload.needsEnrichment : [];
    setWatchlistStatus(
      `신뢰도 ${payload.label} · 높음 ${payload.high || 0} · 보강필요 ${needs.length}`,
      payload.label === "높음" ? "good" : needs.length ? "bad" : "neutral"
    );
    renderWatchlistAuditDetails(payload);
    if (needs.length) {
      requestDataEnrichment(needs.map((ticker) => ({ ticker })));
    }
  } catch {
    renderWatchlistAuditDetails();
    setWatchlistStatus("관심 종목 신뢰도 점검 실패 · 로컬 목록은 유지됩니다.", "bad");
  }
}

function loadScanHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCAN_HISTORY_STORAGE_KEY) || "[]");
    scanHistory = Array.isArray(parsed) ? parsed.slice(-30) : [];
  } catch {
    scanHistory = [];
  }
}

function saveScanHistory() {
  localStorage.setItem(SCAN_HISTORY_STORAGE_KEY, JSON.stringify(scanHistory.slice(-30)));
}

function loadScannedStocks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCANNED_STOCKS_STORAGE_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((stock) => stock?.ticker).map(normalizeApiStock).slice(0, 80)
      : [];
  } catch {
    return [];
  }
}

function rememberScannedStocks(items) {
  const incoming = (items || []).filter((stock) => stock?.ticker).map((stock) => ({
    ...normalizeApiStock(stock),
    savedAt: new Date().toISOString()
  }));
  if (!incoming.length) return;
  const merged = mergeStockResults(loadScannedStocks(), incoming).slice(0, 80);
  localStorage.setItem(SCANNED_STOCKS_STORAGE_KEY, JSON.stringify(merged));
  if (canUseApi) {
    fetch("/api/scanned", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: incoming })
    }).catch(() => {});
  }
}

function enrichmentTickersFrom(items) {
  return [...new Set((items || [])
    .map((stock) => String(stock?.ticker || "").trim().toUpperCase())
    .filter((ticker) => /^[A-Z0-9.-]{1,16}$/.test(ticker)))]
    .slice(0, 12);
}

function renderEnrichmentStatus(payload = {}) {
  const statusEl = document.querySelector("#enrichmentStatus");
  if (!statusEl) return;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const active = items.filter((item) => item.state === "queued" || item.state === "running").length;
  const done = items.filter((item) => item.state === "done").length;
  const errors = items.filter((item) => item.state === "error").length;
  if (!items.length && !payload.queued && !payload.running) {
    statusEl.textContent = "자동 보강 대기";
    statusEl.className = "enrichment-status neutral";
    return;
  }
  const latest = items[0];
  const logItems = items.slice(0, 4).map((item) => `
    <li>
      <b>${escapeHtml(item.ticker || "-")}</b>
      <span>${escapeHtml(item.label || item.state || "-")}</span>
      <em>${escapeHtml(item.startedAt ? "실제 보강 중" : item.completedAt ? "보강 완료" : item.priority ? "우선 대기" : "대기")}</em>
    </li>
  `).join("");
  statusEl.innerHTML = `
    <strong>${payload.running || active ? "데이터 보강 중" : "자동 보강 완료"}</strong>
    <span>대기 ${payload.queued || 0} · 완료 ${done} · 실패 ${errors}${latest ? ` · 최근 ${escapeHtml(latest.ticker)} ${escapeHtml(latest.label || latest.state)}` : ""}</span>
    ${logItems ? `<ul class="enrichment-log">${logItems}</ul>` : ""}
  `;
  statusEl.className = `enrichment-status ${errors ? "warn" : payload.running || active ? "active" : "good"}`;
}

async function fetchEnrichmentStatus() {
  if (!canUseApi) return;
  try {
    const response = await fetch("/api/enrichment");
    if (!response.ok) throw new Error(`API ${response.status}`);
    renderEnrichmentStatus(await response.json());
  } catch {
    renderEnrichmentStatus({ items: [{ ticker: "SERVER", state: "error", label: "상태 확인 실패" }] });
  }
}

function startEnrichmentPolling() {
  if (enrichmentPollTimer) return;
  enrichmentPollCount = 0;
  enrichmentPollTimer = setInterval(async () => {
    enrichmentPollCount += 1;
    await fetchEnrichmentStatus();
    if (enrichmentPollCount >= 15) {
      clearInterval(enrichmentPollTimer);
      enrichmentPollTimer = null;
    }
  }, ENRICHMENT_POLL_MS);
}

async function requestDataEnrichment(items) {
  if (!canUseApi) return;
  const tickers = enrichmentTickersFrom(items);
  const priorityTickers = [...watchlist].slice(0, 12);
  const orderedTickers = [...new Set([...priorityTickers, ...tickers])];
  if (!orderedTickers.length) return;
  try {
    const response = await fetch("/api/enrichment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickers: orderedTickers, priorityTickers })
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    renderEnrichmentStatus(await response.json());
    startEnrichmentPolling();
  } catch {
    renderEnrichmentStatus({ items: [{ ticker: orderedTickers[0], state: "error", label: "자동 보강 시작 실패" }] });
  }
}

function mergeSavedScannedStocks(list) {
  const saved = loadScannedStocks();
  return saved.length ? mergeStockResults(list, saved) : list;
}

async function mergeServerScannedStocks() {
  if (!canUseApi) return;
  try {
    const response = await fetch("/api/scanned");
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    const incoming = Array.isArray(payload.items) ? payload.items.map(normalizeApiStock) : [];
    if (!incoming.length) return;
    incoming.forEach((stock) => searchResultTickers.add(stock.ticker));
    stocks = mergeStockResults(stocks, incoming);
    renderMarketChips();
    renderRows();
  } catch {
    // 로컬 저장 목록만으로 계속 표시합니다.
  }
}

async function clearScannedStocks() {
  localStorage.removeItem(SCANNED_STOCKS_STORAGE_KEY);
  searchResultTickers = new Set();
  searchInput.value = "";
  if (canUseApi) {
    try {
      await fetch("/api/scanned", { method: "DELETE" });
    } catch {
      // 서버 삭제가 실패해도 로컬 화면은 비워 둡니다.
    }
  }
  await loadStocks();
}

function ensureClearScannedButton() {
  if (document.querySelector("#clearScannedButton")) return;
  const scanButton = document.querySelector("#scanButton");
  if (!scanButton) return;
  const button = document.createElement("button");
  button.id = "clearScannedButton";
  button.className = "header-action";
  button.type = "button";
  button.textContent = "스캔 기록 삭제";
  scanButton.insertAdjacentElement("afterend", button);
}

function recordScanHistory(items) {
  const snapshotItems = (items || [])
    .filter((stock) => stock?.ticker && Number.isFinite(Number(stock.score)))
    .map((stock) => ({
      ticker: stock.ticker,
      score: Number(stock.score),
      entry: Number.isFinite(Number(stock.entry)) ? Number(stock.entry) : null,
      price: Number.isFinite(Number(stock.price)) ? Number(stock.price) : null
    }));
  if (!snapshotItems.length) return;

  const previous = scanHistory.at(-1);
  const previousScores = new Map((previous?.items || []).map((item) => [item.ticker, Number(item.score)]));
  scanScoreChanges = new Map();
  for (const item of snapshotItems) {
    const before = previousScores.get(item.ticker);
    if (Number.isFinite(before)) {
      const delta = item.score - before;
      if (Math.abs(delta) >= 0.1) scanScoreChanges.set(item.ticker, delta);
    }
  }

  scanHistory = [...scanHistory, {
    generatedAt: new Date().toISOString(),
    market: activeMarket,
    tickers: snapshotItems.map((item) => item.ticker),
    items: snapshotItems
  }].slice(-30);
  saveScanHistory();
}

function isWatchedTicker(ticker) {
  return watchlist.has(String(ticker || "").toUpperCase());
}

function toggleWatchlist(ticker) {
  const normalized = String(ticker || "").trim().toUpperCase();
  if (!normalized) return false;
  if (watchlist.has(normalized)) {
    watchlist.delete(normalized);
  } else {
    watchlist.add(normalized);
  }
  saveWatchlist();
  updateWatchButton();
  renderMarketChips();
  renderRows();
  return watchlist.has(normalized);
}

function setWatchlistStatus(message, tone = "neutral") {
  const status = document.querySelector("#watchlistStatus");
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function sourceShortLabel(key) {
  return ({
    price: "가격",
    fmp: "FMP",
    alphaVantage: "Alpha",
    dart: "DART",
    sec: "SEC",
    finra: "FINRA"
  })[key] || key;
}

function renderWatchlistAuditDetails(payload = watchlistAuditCache) {
  const box = document.querySelector("#watchlistAuditDetails");
  if (!box) return;
  const items = Array.isArray(payload?.items) ? payload.items.slice(0, 6) : [];
  if (!items.length) {
    box.innerHTML = `<span>관심 종목을 추가하면 출처별 신뢰도를 점검합니다.</span>`;
    return;
  }
  box.innerHTML = items.map((item) => {
    const label = item.trust?.label || "확인중";
    const weak = (item.weakSources || []).slice(0, 3).map(sourceShortLabel).join(", ") || "핵심 출처 양호";
    const tone = label === "높음" ? "good" : label === "낮음" ? "bad" : "neutral";
    return `
      <button class="watchlist-audit-row ${tone}" data-ticker="${escapeHtml(item.ticker)}" type="button">
        <b>${escapeHtml(item.ticker)}</b>
        <span>${escapeHtml(label)}</span>
        <small>${escapeHtml(weak)}</small>
      </button>
    `;
  }).join("");
}

async function fetchWatchlistStocks(tickers) {
  if (!canUseApi) {
    return tickers.map(buildAdHocTicker);
  }
  const settled = await Promise.allSettled(tickers.map((ticker) => fetch(`/api/stocks/${encodeURIComponent(ticker)}`).then((res) => {
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  })));
  const incoming = settled
    .filter((item) => item.status === "fulfilled")
    .map((item) => normalizeApiStock(item.value));
  if (incoming.length) {
    incoming.forEach((stock) => searchResultTickers.add(stock.ticker));
    stocks = mergeStockResults(stocks, incoming);
    rememberScannedStocks(incoming);
    requestDataEnrichment(incoming);
  }
  return incoming;
}

async function ensureWatchlistStocks() {
  const missing = [...watchlist].filter((ticker) => !stocks.some((stock) => stock.ticker === ticker || String(stock.yf_symbol || "").toUpperCase() === ticker));
  if (!missing.length) return;
  await fetchWatchlistStocks(missing.slice(0, 20));
}

async function addWatchlistTickers(value) {
  const tickers = parseTickerList(value);
  if (!tickers.length) {
    setWatchlistStatus("티커를 입력해 주세요.", "bad");
    return;
  }
  tickers.forEach((ticker) => watchlist.add(ticker));
  saveWatchlist();
  activeSector = WATCHLIST_SECTOR;
  activeQuickFilter = "all";
  setWatchlistStatus(`${tickers.join(", ")} 실데이터 확인 중...`, "neutral");
  const incoming = await fetchWatchlistStocks(tickers);
  renderMarketChips();
  renderRows();
  refreshWatchlistReliability();
  setWatchlistStatus(
    incoming.length ? `${incoming.map((stock) => stock.ticker).join(", ")} 추가 완료` : "추가했지만 가격 데이터를 확인하지 못했습니다.",
    incoming.length ? "good" : "bad"
  );
}

function updateWatchButton() {
  const button = document.querySelector("#watchButton");
  if (!button) return;
  const watched = isWatchedTicker(selectedTicker);
  button.classList.toggle("active", watched);
  button.textContent = watched ? "관심 해제" : "관심";
  button.setAttribute("aria-pressed", String(watched));
}

function passesQuickFilter(stock) {
  if (activeQuickFilter === "watchlist") return isWatchedTicker(stock.ticker);
  if (activeQuickFilter === "entry") return stock.entry >= 60 && stock.entry < 75;
  if (activeQuickFilter === "strong") return stock.score >= 70 || stock.verdict === "매수";
  if (activeQuickFilter === "newHigh") {
    const text = `${stock.mainPoint || ""} ${stock.subPoint || ""} ${reasonTags(stock)}`;
    return /신고가|52주|돌파/i.test(text);
  }
  if (activeQuickFilter === "rsi30") return Number(stock.finance?.rsi) < 30;
  if (activeQuickFilter === "swing") return stock.score >= 60 && stock.entry >= 50 && stock.entry < 75;
  return true;
}

function signalFromEntry(entry) {
  if (entry >= 60 && entry < 75) return "매수";
  if (entry < 40) return "주의";
  return "관망";
}

function setActiveView(view) {
  activeView = view === "portfolio" ? "portfolio" : "scanner";
  document.body.dataset.view = activeView;
  document.querySelectorAll(".market-switch button").forEach((item) => {
    const isPortfolio = item.dataset.view === "portfolio";
    item.classList.toggle("active", activeView === "portfolio" ? isPortfolio : item.dataset.market === activeMarket);
  });
  if (activeView === "portfolio") {
    renderPortfolio({ refresh: true });
    document.querySelector("#portfolio")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function cloneFallbackWithDrift() {
  scanCount += 1;
  const base = ensureSearchTicker([...sampleUniverse]);
  return base.map((stock, index) => {
    const drift = ((scanCount + index) % 5 - 2) * 3;
    const entry = Math.max(18, Math.min(88, stock.entry + drift));
    const score = Math.max(20, Math.min(98, stock.score + Math.round(drift / 2)));
    return {
      ...stock,
      score,
      entry,
      verdict: signalFromEntry(entry),
      subPoint: `샘플 스캔 ${scanCount}회 · 서버 실행 시 실제 데이터로 전환`,
    };
  });
}

function realStocks() {
  return Array.isArray(window.REAL_STOCKS?.items) && window.REAL_STOCKS.items.length
    ? window.REAL_STOCKS.items
    : null;
}

function compactTarget(stock, value) {
  if (isMissingData(stock)) return `<strong class="muted">데이터 없음</strong>`;
  if (value === null || value === undefined || Number.isNaN(Number(value))) return `<strong class="muted">컨센서스 없음</strong>`;
  const gap = ((Number(value) - Number(stock.price)) / Number(stock.price)) * 100;
  return `
    <strong>${priceText(stock, value)}</strong>
    <small class="${gap >= 0 ? "up" : "down"}">${gap >= 0 ? "+" : ""}${money(gap)}%</small>
  `;
}

function scoreDelta(stock, index) {
  if (isMissingData(stock)) return `<span class="score-delta flat">-</span>`;
  const delta = scanScoreChanges.get(stock.ticker);
  if (!Number.isFinite(delta) || Math.abs(delta) < .1) return `<span class="score-delta flat">-</span>`;
  return `<span class="score-delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : "-"}${Math.abs(delta).toFixed(1)}</span>`;
}

function reasonTags(stock) {
  if (isMissingData(stock)) {
    return `<span class="reason-tag danger">가격 데이터 없음</span><span class="reason-tag">캐시 적재 필요</span>`;
  }
  const tags = [
    stock.mainPoint,
    stock.rsRating >= 80 ? `RS ${stock.rsRating} 주도` : "",
    stock.finance?.rsi >= 75 ? "RSI 과열" : "",
    stock.score >= 70 ? "52주 신고가 근접" : "",
    stock.canSlim >= 65 ? "EPS 가속" : ""
  ].filter(Boolean).slice(0, 3);
  return tags.map((tag) => `<span class="reason-tag ${String(tag).includes("과열") ? "danger" : ""}">${escapeHtml(tag)}</span>`).join("");
}

function stockTrustTone(stock) {
  const label = stock.trust?.label;
  if (label === "높음") return "good";
  if (label === "낮음") return "bad";
  return "neutral";
}

function stockSourceSummary(stock) {
  const sources = stock.sourceStatus || {};
  const labels = [];
  if (sources.price?.status === "ok") labels.push(`가격 ${sources.price.source || stock.dataSource || "연결"}`);
  if (sources.fmp?.status === "ok" || sources.fmp?.status === "partial") labels.push(`FMP ${sourceStatusLabel(sources.fmp.status)}`);
  if (sources.alphaVantage?.status === "ok") labels.push("Alpha 연결");
  if (sources.dart?.status === "ok" || sources.dart?.status === "partial") labels.push("DART 연결");
  if (!labels.length) labels.push(isMissingData(stock) ? "실데이터 없음" : stock.dataSource || "가격 기반");
  return labels.slice(0, 3).join(" · ");
}

function trustBadge(stock) {
  const tone = stockTrustTone(stock);
  const label = stock.trust?.label || (isMissingData(stock) ? "낮음" : "보통");
  const title = stock.trust?.note || stockSourceSummary(stock);
  return `
    <span class="trust-badge ${tone}" title="${escapeHtml(title)}">
      신뢰도 ${escapeHtml(label)}
    </span>
  `;
}

function signalBadge(stock) {
  if (isMissingData(stock)) {
    return `
      <div class="signal-stack missing">
        <span class="signal-dot neutral" title="가격 데이터가 없어 신호를 계산하지 못했습니다."></span>
        <strong class="risk">데이터 없음</strong>
        <small>캐시 필요</small>
      </div>
    `;
  }
  const sweetSpot = stock.entry >= 60 && stock.entry < 75;
  const overheated = stock.entry >= 75;
  const cls = sweetSpot ? "buy" : stock.entry < 40 ? "risk" : "observe";
  const label = sweetSpot ? "진입 후보" : stock.entry < 40 ? "주의" : overheated ? "강세 관찰" : "관심 LIST";
  const dotTitle = sweetSpot
    ? "초록: EntryScore 60~74, 백테스트상 눌림/재돌파 후보 구간입니다."
    : stock.entry < 40
      ? "빨강: EntryScore 40 미만, 변동성과 반등 착시를 반드시 확인해야 합니다."
      : overheated
        ? "노랑: EntryScore 75 이상, 강하지만 추격 위험을 확인해야 합니다."
        : "노랑: EntryScore 40~59, 아직 관망/매집 관찰 구간입니다.";
  return `
    <div class="signal-stack">
      <span class="signal-dot ${cls}" title="${escapeHtml(dotTitle)}"></span>
      <strong class="${cls}">★ ${label}</strong>
      <small>${sweetSpot ? "눌림 후보" : stock.entry < 40 ? "리스크 확인" : overheated ? "추격 확인" : "매집 관찰"}</small>
    </div>
  `;
}

function renderQuickFilters() {
  const wrapper = document.querySelector(".quick-filters");
  if (!wrapper) return;
  const list = visibleStocks();
  const filters = [
    ["all", "전체", list.length],
    ["watchlist", "관심 리스트", list.filter((stock) => isWatchedTicker(stock.ticker)).length],
    ["entry", "진입 좋음", list.filter((stock) => stock.entry >= 60 && stock.entry < 75).length],
    ["strong", "강력 매수", list.filter((stock) => stock.score >= 70 || stock.verdict === "매수").length],
    ["newHigh", "신고가", list.filter((stock) => /신고가|52주|돌파/i.test(`${stock.mainPoint || ""} ${stock.subPoint || ""} ${reasonTags(stock)}`)).length],
    ["rsi30", "RSI<30", list.filter((stock) => Number(stock.finance?.rsi) < 30).length],
    ["swing", "단타 신호", list.filter((stock) => stock.score >= 60 && stock.entry >= 50 && stock.entry < 75).length]
  ];
  wrapper.innerHTML = filters.map(([key, label, count]) => `
    <button class="${activeQuickFilter === key ? "active" : ""}" data-filter="${key}" type="button">
      ${escapeHtml(label)} <b>${count}</b>
    </button>
  `).join("");
}

function renderSectorRail() {
  if (!sectorRail) return;
  const watchedCount = [...watchlist].length;
  const source = stocks.filter((stock) => activeMarket === "all"
    || stock.market === activeMarket
    || (activeMarket === "us" && stock.sector === "US ETF")
    || (activeMarket === "kr" && stock.sector === "Korea ETF"));
  const groups = source.reduce((acc, stock) => {
    if (!acc[stock.sector]) acc[stock.sector] = [];
    acc[stock.sector].push(stock);
    return acc;
  }, {});
  const entries = Object.entries(groups)
    .map(([sector, items]) => [sector, items.reduce((sum, item) => sum + item.score, 0) / items.length])
    .sort((a, b) => {
      const aIndex = usSectorOrder.indexOf(a[0]);
      const bIndex = usSectorOrder.indexOf(b[0]);
      if (aIndex >= 0 || bIndex >= 0) return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex);
      return b[1] - a[1];
    });
  sectorRail.innerHTML = `
    <div class="watchlist-rail-card">
      <button class="watchlist-sector ${activeSector === WATCHLIST_SECTOR ? "active" : ""}" data-sector="${WATCHLIST_SECTOR}" type="button">
        <span>관심 종목</span>
        <strong>${watchedCount}</strong>
      </button>
      <form id="watchlistAddForm" class="watchlist-add-form">
        <input id="watchlistTickerInput" type="text" inputmode="latin" autocomplete="off" placeholder="AAPL, NVDA, 005930">
        <button type="submit">추가</button>
      </form>
      <div class="watchlist-starter-chips" aria-label="관심 종목 빠른 추가">
        ${["AAPL", "NVDA", "GOOGL", "QQQM"].map((ticker) => `<button data-watch-ticker="${ticker}" type="button">${ticker}</button>`).join("")}
      </div>
      <div class="trust-help-line">
        신뢰도 기준
        <span class="term-help" title="높음: 가격과 핵심 재무/공시 출처 대부분 연결. 보통: 일부 대체값 또는 부분 연결. 낮음: 가격 외 핵심 출처가 부족하거나 교차검증 경고가 있음.">?</span>
      </div>
      <small id="watchlistStatus">첫 화면은 관심 종목부터 보여줍니다.</small>
      <div id="watchlistAuditDetails" class="watchlist-audit-details">
        <span>관심 종목을 추가하면 출처별 신뢰도를 점검합니다.</span>
      </div>
    </div>
    <button class="${activeSector === "all" ? "active" : ""}" data-sector="all" type="button">
      <span>전체</span>
      <strong>${source.length}</strong>
    </button>
  ` + entries.map(([sector, average]) => `
    <button class="${activeSector === sector ? "active" : ""}" data-sector="${escapeHtml(sector)}" type="button">
      <span>${escapeHtml(sector)}</span>
      <strong>${average.toFixed(1)}</strong>
    </button>
  `).join("");
}

function buildAdHocTicker(ticker) {
  const upper = ticker.toUpperCase();
  const isKr = /^\d{6}(\.KS|\.KQ)?$/.test(upper);
  const isKnownEtf = new Set(["VOO", "QQQ", "SPY", "IWM", "DIA", "TLT", "GLD", "KODEX200", "069500"]).has(upper.replace(/\.(KS|KQ)$/, ""));
  const assetType = isKnownEtf ? "etf" : "stock";
  return {
    ticker: upper,
    yf_symbol: isKr ? (upper.includes(".") ? upper : `${upper}.KS`) : upper,
    company: isKr ? `${upper} 한국주식` : `${upper} ${assetType === "etf" ? "ETF" : "주식"}`,
    market: isKr ? "kr" : assetType === "etf" ? "etf" : "us",
    sector: isKr ? "한국주식" : assetType === "etf" ? "US ETF" : "Information Technology (정보통신기술주)",
    industry: isKr ? "사용자 입력 종목" : "사용자 입력 티커",
    asset_type: assetType,
    price: isKr ? 50000 : 100,
    change: 0,
    mainPoint: `${upper} 임시 후보를 추가했습니다`,
    subPoint: "서버 API에서 실제 데이터를 불러오면 이 값은 교체됩니다.",
    score: 60,
    entry: 50,
    verdict: "관망",
    canSlim: 55,
    conviction: "보통",
    rsRating: 60,
    finance: { pe: null, peGap: 0, target: isKr ? 53000 : 106, targetGap: 6, rsi: 50 },
    chart: isKr ? [47000, 48000, 49000, 48500, 50000] : [96, 98, 99, 101, 100],
    tradePlan: { buy: isKr ? 50000 : 100, stop: isKr ? 47500 : 95, target1: isKr ? 53000 : 106, target2: isKr ? 55500 : 111, atr: isKr ? 1400 : 2.5 },
    canslim: [["C", "실데이터 연결 후 계산됩니다", false], ["A", "실데이터 연결 후 계산됩니다", false], ["N", "실데이터 연결 후 계산됩니다", false], ["S", "실데이터 연결 후 계산됩니다", false], ["L", "실데이터 연결 후 계산됩니다", false], ["I", "실데이터 연결 후 계산됩니다", false]],
    support: [["M", "시장 방향은 서버에서 계산됩니다", true], ["MATH", "수학 지표는 서버에서 계산됩니다", false], ["SP", "임시 모드", false]],
    technical: [["RSI", "실데이터 연결 후 계산됩니다", false], ["VWAP", "실데이터 연결 후 계산됩니다", false], ["MACD", "실데이터 연결 후 계산됩니다", false], ["ATR", "실데이터 연결 후 계산됩니다", false]],
    financeRows: [["상태", "임시 후보", false], ["데이터", "서버 모드 필요", false], ["유형", isKr ? "KR 주식" : assetType === "etf" ? "US ETF" : "US 주식", true], ["주의", "샘플 점수", false]],
    insight: [["상태", `${upper}가 목록에 없어 임시 후보를 추가했습니다.`], ["다음 단계", "서버 데이터가 연결되면 실제 계산값으로 교체됩니다."]]
  };
}
function ensureSearchTicker(list) {
  const term = searchInput.value.trim().toUpperCase();
  if (!term || !/^[A-Z0-9.]{2,12}$/.test(term)) return list;
  const exists = list.some((stock) => stock.ticker.toUpperCase() === term || String(stock.yf_symbol || "").toUpperCase() === term);
  if (exists) return list;
  return [...list, buildAdHocTicker(term)];
}

function ratingClass(stock) {
  if (stock.verdict === "매수" || stock.score >= 70) return "green";
  if (stock.verdict === "주의" || stock.entry < 40) return "red";
  return "yellow";
}

function renderMarketChips() {
  const list = visibleStocks();
  const green = list.filter((stock) => stock.score >= 70).length;
  const yellow = list.filter((stock) => stock.score >= 55 && stock.score < 70).length;
  const buy = list.filter((stock) => stock.entry >= 60 && stock.entry < 75).length;
  const watched = list.filter((stock) => isWatchedTicker(stock.ticker)).length;
  document.querySelector("#marketChips").innerHTML = `
    <span class="chip">스캔 종목 <strong>${list.length}</strong>개</span>
    <span class="chip">진입 후보 <strong>${buy}</strong>개</span>
    <span class="chip">관심 후보 <strong>${yellow + green}</strong>개</span>
    <span class="chip">내 관심 <strong>${watched}</strong>개</span>
    <span class="chip">변화 기록 <strong>${scanHistory.length}</strong>회</span>
    <span class="chip">섹터 <strong>${activeSector === WATCHLIST_SECTOR ? "관심 종목" : activeSector === "all" ? "전체" : activeSector}</strong></span>
  `;
  renderQuickFilters();
  renderSectorRail();
}

function renderRows() {
  const term = searchInput.value.trim().toLowerCase();
  stockRows.innerHTML = "";
  const rows = visibleStocks().filter((stock) => {
    if (!passesQuickFilter(stock)) return false;
    if (searchResultTickers.has(stock.ticker)) return true;
    const searchOriginal = String(stock.searchOriginal || "").toLowerCase();
    return !term || stock.searchMatched || searchOriginal === term || stock.ticker.toLowerCase().includes(term) || stock.company.toLowerCase().includes(term);
  });

  rows.forEach((stock, index) => {
    const tr = document.createElement("tr");
    tr.dataset.ticker = stock.ticker;
    tr.innerHTML = `
      <td><input type="checkbox" aria-label="${stock.ticker} 선택"></td>
      <td><span class="rank">${index + 1}</span></td>
      <td>
        <div class="ticker">
          <div>
            <strong>${stock.company}</strong>
            <span>${stock.ticker}</span>
          </div>
        </div>
      </td>
      <td class="description-cell">${stock.industry}</td>
      <td><span class="sector-pill">${stock.sector}</span></td>
      <td>
        <div class="score-stack">
          <strong>${stock.score}</strong>
          ${scoreDelta(stock, index)}
          ${trustBadge(stock)}
          <i><b style="width:${stock.score}%"></b></i>
        </div>
      </td>
      <td>${signalBadge(stock)}</td>
      <td class="number-cell">${priceText(stock)}</td>
      <td class="${Number(stock.change) >= 0 ? "up" : "down"}">${percentText(stock.change)}</td>
      <td>${money(stock.finance?.rsi)}</td>
      <td class="target-cell">${compactTarget(stock, stock.tradePlan?.target1)}</td>
      <td class="target-cell">${compactTarget(stock, stock.finance?.target)}</td>
      <td>
        <div class="reason-list">${reasonTags(stock)}</div>
        <div class="source-line">${escapeHtml(stockSourceSummary(stock))}</div>
        <button class="row-watch-toggle ${isWatchedTicker(stock.ticker) ? "active" : ""}" data-ticker="${stock.ticker}" type="button">${isWatchedTicker(stock.ticker) ? "관심 해제" : "관심 추가"}</button>
        <button class="row-portfolio-add" data-ticker="${stock.ticker}" type="button">포트폴리오 추가</button>
      </td>
    `;
    stockRows.appendChild(tr);
  });

  if (!rows.length) {
    const message = activeSector === WATCHLIST_SECTOR
      ? "관심 종목이 아직 없습니다. 왼쪽 관심 종목 입력창에 티커를 추가해 주세요."
      : "검색 결과가 없습니다. 티커를 다시 확인해 주세요.";
    stockRows.innerHTML = `<tr><td colspan="13">${message}</td></tr>`;
  }
}

function mergeStockResults(current, incoming) {
  const merged = [...current];
  for (const item of incoming) {
    const index = merged.findIndex((stock) => stock.ticker === item.ticker);
    if (index >= 0) {
      merged[index] = { ...merged[index], ...item };
    } else {
      merged.unshift(item);
    }
  }
  return merged;
}

function parseTickerList(value) {
  return String(value || "")
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((ticker) => ticker.trim())
    .filter((ticker) => /^[A-Z0-9.-]{1,12}$/.test(ticker))
    .slice(0, 20);
}

function getSelectedStock() {
  return stocks.find((stock) => stock.ticker === selectedTicker) || stocks[0];
}

async function loadStocks({ sampleDrift = false } = {}) {
  const query = searchInput.value.trim().toUpperCase();
  if (!canUseApi) {
    const real = realStocks();
    const base = real ? ensureSearchTicker([...real]) : (sampleDrift ? cloneFallbackWithDrift() : ensureSearchTicker([...sampleUniverse]));
    stocks = mergeSavedScannedStocks(base);
    await ensureWatchlistStocks();
    apiMode = Boolean(real);
    renderMarketChips();
    renderRows();
    renderPortfolio();
    return;
  }

  try {
    stockRows.innerHTML = `<tr><td colspan="13">가격 데이터와 점수를 계산하는 중입니다...</td></tr>`;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), STOCK_LOAD_TIMEOUT_MS) : null;
    const safeQuery = query.length <= 40 ? query : "";
    const tickerList = parseTickerList(safeQuery);
    if (tickerList.length > 1) {
      const settled = await Promise.allSettled(tickerList.map((ticker) => fetch(`/api/stocks/${encodeURIComponent(ticker)}`).then((res) => {
        if (!res.ok) throw new Error(`API ${res.status}`);
        return res.json();
      })));
      const incoming = settled
        .filter((item) => item.status === "fulfilled")
        .map((item) => normalizeApiStock(item.value));
      incoming.forEach((stock) => searchResultTickers.add(stock.ticker));
      rememberScannedStocks(incoming);
      requestDataEnrichment(incoming);
      stocks = mergeStockResults(stocks, incoming);
      apiMode = incoming.length > 0;
      renderMarketChips();
      renderRows();
      renderPortfolio();
      return;
    }
    const queryParam = safeQuery ? `&query=${encodeURIComponent(safeQuery)}` : "";
    const response = await fetch(`/api/stocks?market=${activeMarket}${queryParam}`, controller ? { signal: controller.signal } : {});
    if (timer) clearTimeout(timer);
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    const incoming = payload.items && payload.items.length ? payload.items.map(normalizeApiStock) : [];
    if (safeQuery) {
      incoming.forEach((stock) => searchResultTickers.add(stock.ticker));
      rememberScannedStocks(incoming);
      requestDataEnrichment(incoming);
      stocks = mergeStockResults(stocks, incoming);
    } else {
      searchResultTickers = new Set();
      stocks = mergeSavedScannedStocks(incoming);
      requestDataEnrichment(incoming.slice(0, 12));
    }
    apiMode = Boolean(payload.items && payload.items.length);
  } catch (error) {
    if (!query && !stocks.length) stocks = loadScannedStocks();
    apiMode = false;
    if (!stocks.length) {
      stockRows.innerHTML = `<tr><td colspan="13">서버 계산이 오래 걸리고 있습니다. 잠시 후 다시 스캔을 눌러 주세요.</td></tr>`;
      renderMarketChips();
      renderPortfolio();
      return;
    }
  }
  await ensureWatchlistStocks();
  renderMarketChips();
  renderRows();
  if (!query) mergeServerScannedStocks();
  renderPortfolio();
}

async function loadCacheStatus() {
  if (!cacheStatus) return;
  if (!canUseApi) {
    cacheStatus.textContent = "파일 모드 · 서버 실행 필요";
    cacheStatus.className = "cache-status bad";
    return;
  }
  try {
    const response = await fetch("/api/cache/status");
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    const missing = Array.isArray(payload.missingWatchedSymbols) ? payload.missingWatchedSymbols.length : 0;
    const missingFundamentals = Array.isArray(payload.missingFundamentalSymbols) ? payload.missingFundamentalSymbols.length : 0;
    const fundamentals = payload.fundamentalFiles || {};
    const quota = payload.alphaQuota || {};
    const quality = payload.dataQuality || {};
    const qualityIssues = [...(quality.blockers || []), ...(quality.warnings || [])].slice(0, 2).join(" · ");
    const quotaText = quota.date ? `Alpha ${quota.used || 0}/${quota.limit || 23}${quota.blocked ? " 한도초과" : ""}` : "Alpha 기록 없음";
    const sources = Object.entries(payload.priceSources || {})
      .map(([source, count]) => `${source} ${count}`)
      .join(" · ");
    cacheStatus.innerHTML = `
      <strong>데이터 신뢰도 ${quality.score ?? "-"}점 · ${escapeHtml(quality.label || "확인중")}</strong>
      <span>가격 ${quality.freshPricePct ?? 0}% · 재무 ${quality.fundamentalPct ?? 0}% · 가격 캐시 ${payload.freshPriceFiles || 0}/${payload.priceFiles || 0}</span>
      <span>${sources || "소스 없음"}${missing ? ` · 가격누락 ${missing}` : " · 가격누락 없음"}</span>
      <span>재무 ${fundamentals.both || 0}개 완성 · FMP 완성 ${fundamentals.fmpComplete || 0} · 부분 ${fundamentals.fmpPartial || 0} · Alpha overview ${fundamentals.overview || 0} · earnings ${fundamentals.earnings || 0} · 누락 ${missingFundamentals} · ${quotaText}</span>
      ${qualityIssues ? `<span>주의: ${escapeHtml(qualityIssues)}</span>` : ""}
    `;
    cacheStatus.className = `cache-status ${quality.label === "높음" && !missing ? "good" : quality.label === "낮음" ? "bad" : "neutral"}`;
  } catch {
    cacheStatus.textContent = "서버 상태 확인 실패";
    cacheStatus.className = "cache-status bad";
  }
}

function normalizeApiStock(stock) {
  if (!stock || typeof stock !== "object") return stock;
  return {
    ...stock,
    canSlim: stock.canSlim ?? stock.canSlimScore ?? 0
  };
}

async function openStock(ticker) {
  selectedTicker = ticker;
  selectedTab = "canslim";
  if (apiMode) {
    try {
      const response = await fetch(`/api/stocks/${encodeURIComponent(ticker)}`);
      if (response.ok) {
        const detail = normalizeApiStock(await response.json());
        const found = stocks.some((stock) => stock.ticker === ticker);
        stocks = found
          ? stocks.map((stock) => stock.ticker === ticker ? detail : stock)
          : [detail, ...stocks];
      }
    } catch (error) {
      // 기존 목록 데이터로 계속 표시합니다.
    }
  }
  renderModal();
  modalBackdrop.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

async function openPortfolioStock(ticker) {
  const normalized = String(ticker || "").trim().toUpperCase();
  if (!normalized) return;
  const cachedQuote = portfolioQuotes.get(normalized);
  if (cachedQuote && !stocks.some((stock) => stock.ticker === normalized)) {
    stocks = [normalizeApiStock(cachedQuote), ...stocks];
  }
  await openStock(normalized);
}

function closeStock() {
  modalBackdrop.classList.add("hidden");
  document.body.style.overflow = "";
}

function renderModal() {
  const stock = getSelectedStock();
  document.querySelector('button[data-tab="insight"]').textContent = stock.market === "kr" ? "공시·뉴스" : "US 인사이트";
  document.querySelector("#modalCompany").textContent = stock.company;
  document.querySelector("#modalTicker").textContent = stock.ticker;
  document.querySelector("#modalSector").textContent = stock.sector;
  document.querySelector("#modalIndustry").textContent = stock.industry;
  document.querySelector("#calloutTitle").innerHTML = escapeHtml(stock.mainPoint || "").replace(/\n/g, "<br>");
  document.querySelector("#calloutSub").textContent = stock.subPoint || "";
  document.querySelector("#modalScore").innerHTML = isMissingData(stock) ? `-<span>점</span>` : `${stock.score}<span>점</span>`;
  renderScoreReferenceWarning(stock);
  renderDetailTrustBanner(stock);
  document.querySelector("#entryScore").textContent = isMissingData(stock) ? "-" : stock.entry;
  document.querySelector("#entryLabel").textContent = isMissingData(stock)
    ? "데이터 없음 · 캐시 적재 필요"
    : `${stock.verdict} · ${stock.entry >= 60 && stock.entry < 75 ? "눌림/재돌파 후보" : stock.entry >= 75 ? "강세·추격 확인" : stock.entry >= 45 ? "관찰 후보" : "리스크 확인"}`;
  document.querySelector("#entryMeter").style.width = `${isMissingData(stock) ? 0 : stock.entry}%`;
  document.querySelector("#entryMeter").style.background = stock.entry >= 60 && stock.entry < 75 ? "var(--green)" : stock.entry < 40 ? "var(--red)" : "var(--orange)";
  document.querySelector("#modalBadge").textContent = isMissingData(stock) ? "데이터 없음" : stock.score >= 70 ? "섹터 리더" : stock.score >= 60 ? "관심 후보" : "관망";
  renderMetrics(stock);
  renderEntryPlan(stock);
  renderSideStats(stock);
  renderTimingPanel(stock);
  renderChart(stock);
  updateWatchButton();
  renderTabs();
  renderTabContent();
}

function scoreReferenceWarning(stock) {
  const statuses = Object.values(stock.sourceStatus || {}).map((item) => item?.status);
  const fallbackCount = Number(stock.trust?.fallbackCount ?? statuses.filter((status) => status === "fallback" || status === "missing_key").length);
  if (isMissingData(stock)) {
    return "가격 데이터가 없어 점수와 진입 타점을 계산하지 않았습니다.";
  }
  if (stock.trust?.label === "낮음" || fallbackCount >= 2 || stock.dataSource === "fallback") {
    return "점수 참고용 · 대체 데이터 비중이 높습니다.";
  }
  return "";
}

function renderScoreReferenceWarning(stock) {
  const scoreCard = document.querySelector(".score-card");
  if (!scoreCard) return;
  let warning = scoreCard.querySelector(".score-reference-warning");
  if (!warning) {
    scoreCard.insertAdjacentHTML("beforeend", `<div class="score-reference-warning hidden"></div>`);
    warning = scoreCard.querySelector(".score-reference-warning");
  }
  const text = scoreReferenceWarning(stock);
  warning.textContent = text;
  warning.classList.toggle("hidden", !text);
}

function renderDetailTrustBanner(stock) {
  const callout = document.querySelector("#bigCallout");
  if (!callout) return;
  let banner = document.querySelector("#detailTrustBanner");
  if (!banner) {
    callout.insertAdjacentHTML("afterend", `<section id="detailTrustBanner" class="detail-trust-banner"></section>`);
    banner = document.querySelector("#detailTrustBanner");
  }
  const sources = Object.entries(stock.sourceStatus || {});
  const weak = sources
    .filter(([, item]) => ["missing", "missing_key", "fallback", "partial"].includes(item?.status))
    .map(([key, item]) => `${sourceShortLabel(key)} ${sourceStatusLabel(item?.status)}`)
    .slice(0, 4);
  const tone = trustTone(stock);
  banner.className = `detail-trust-banner ${tone}`;
  banner.innerHTML = `
    <div>
      <span>데이터 신뢰도</span>
      <strong>${escapeHtml(stock.trust?.label || "확인중")}</strong>
      <small>${escapeHtml(stock.trust?.note || trustCountsText(stock))}</small>
    </div>
    <p>${weak.length ? escapeHtml(`확인 필요: ${weak.join(" · ")}`) : "가격·핵심 출처가 양호하게 연결되어 있습니다."}</p>
  `;
}

function classificationRow(stock) {
  const item = stock.classification;
  if (!item) return "";
  return `<div class="metric-row classification-metric"><span>분류 근거<br><small>${escapeHtml(item.source || "unknown")} · 신뢰도 ${escapeHtml(item.confidence || "-")}</small></span><strong>${escapeHtml(item.label || item.assetType || "-")}</strong></div>`;
}

function trustCounts(stock) {
  const statuses = Object.values(stock.sourceStatus || {}).map((item) => item?.status);
  return {
    ok: Number(stock.trust?.okCount ?? statuses.filter((status) => status === "ok").length),
    fallback: Number(stock.trust?.fallbackCount ?? statuses.filter((status) => status === "fallback" || status === "missing_key" || status === "missing").length),
    weak: Number(stock.trust?.weakCount ?? statuses.filter((status) => status === "partial" || status === "unavailable").length)
  };
}

function trustTone(stock) {
  if (stock.trust?.label === "높음") return "good";
  if (stock.trust?.label === "낮음" || isMissingData(stock)) return "bad";
  const counts = trustCounts(stock);
  return counts.fallback >= 2 ? "bad" : counts.fallback || counts.weak ? "neutral" : "good";
}

function trustCountsText(stock) {
  const counts = trustCounts(stock);
  return counts.fallback || counts.weak
    ? `연결 ${counts.ok} · 대체/누락 ${counts.fallback} · 부분/미지원 ${counts.weak}`
    : `연결 ${counts.ok} · 주요 소스 정상`;
}

function dataTrustMetricRow(stock) {
  if (!stock.trust) return "";
  return `<div class="metric-row trust-metric ${trustTone(stock)}"><span>데이터 신뢰도<br><small>${escapeHtml(trustCountsText(stock))}</small></span><strong>${escapeHtml(stock.trust.label || "-")}</strong></div>`;
}

function renderMetrics(stock) {
  const f = stock.finance || {};
  document.querySelector("#metricList").innerHTML = `
    ${classificationRow(stock)}
    ${dataTrustMetricRow(stock)}
    <div class="metric-row"><span>현재가</span><strong>${priceText(stock)}</strong></div>
    <div class="metric-row"><span>등락률</span><strong class="${Number(stock.change) >= 0 ? "up" : "down"}">${percentText(stock.change)}</strong></div>
    <div class="metric-row"><span>목표가<br><small>ATR 기반</small></span><strong>${priceText(stock, f.target)}</strong></div>
    <div class="metric-row"><span>목표 여력</span><strong class="${Number(f.targetGap) >= 0 ? "up" : "down"}">${percentText(f.targetGap)}</strong></div>
    <div class="metric-row"><span>RSI</span><strong>${money(f.rsi)}</strong></div>
    <div class="metric-row"><span>RS 등급</span><strong>${stock.rsRating || "-"}</strong></div>
    <div class="metric-row"><span>확신도</span><strong>${stock.conviction}</strong></div>
  `;
}

function renderEntryPlan(stock) {
  const plan = stock.tradePlan || {};
  const model = plan.entryModel;
  const sizing = plan.positionSizing || {};
  const gateText = Array.isArray(plan.gateReasons) ? plan.gateReasons.join(" · ") : "";
  const modelText = model?.notes?.length
    ? `${model.version || "EntryScore"} · ${model.notes.slice(0, 3).join(" · ")}`
    : "ATR 기반 타점 계산";
  document.querySelector("#entryPlan").innerHTML = `
    <div><span>매수</span><strong>${priceText(stock, plan.buy)}</strong></div>
    <div><span>손절</span><strong class="down">${priceText(stock, plan.stop)}</strong></div>
    <div><span>목표가1</span><strong class="up">${priceText(stock, plan.target1)}</strong></div>
    <div><span>목표가2</span><strong class="up">${priceText(stock, plan.target2)}</strong></div>
    <div><span>권장 수량</span><strong>${Number.isFinite(sizing.shares) ? `${sizing.shares}주` : "-"}</strong></div>
    <div><span>1회 손실</span><strong class="down">${Number.isFinite(sizing.dollarRisk) ? priceText(stock, sizing.dollarRisk) : "-"}</strong></div>
    <div><span>포지션</span><strong>${Number.isFinite(sizing.positionPct) ? `${sizing.positionPct}%` : "-"}</strong></div>
    <div><span>셋업</span><strong>${escapeHtml(plan.setupState || "-")}</strong></div>
    <small>${escapeHtml(modelText)} · 손절폭 ${Number.isFinite(plan.riskPct) ? `${plan.riskPct}%` : "-"} · R:R ${plan.rr || "-"} · ${escapeHtml(gateText)}</small>
  `;
}

function renderChart(stock) {
  const rows = Array.isArray(stock.chartRows) && stock.chartRows.length
    ? stock.chartRows.map((row, index) => ({
      date: row.date || String(index + 1),
      close: Number(row.close),
      volume: Number(row.volume || 0)
    })).filter((row) => Number.isFinite(row.close))
    : (stock.chart || []).map((close, index) => ({
      date: String(index + 1),
      close: Number(close),
      volume: 0
    })).filter((row) => Number.isFinite(row.close));
  const data = rows.map((row) => row.close);
  const chartInsight = document.querySelector("#chartInsight");
  if (!rows.length) {
    document.querySelector("#modalChart").innerHTML = `<div class="chart-empty">가격 데이터가 아직 없어 차트를 표시할 수 없습니다.</div>`;
    chartInsight.className = "chart-insight bad";
    chartInsight.innerHTML = `<strong>차트 데이터 없음</strong><p>가격 캐시를 먼저 적재해야 합니다.</p>`;
    return;
  }
  const firstDate = rows[0]?.date || "-";
  const lastDate = rows.at(-1)?.date || "-";
  const volumeCount = rows.filter((row) => row.volume > 0).length;
  const priceSource = stock.sourceStatus?.price?.source || stock.dataSource || "가격 캐시";
  const priceStatus = stock.sourceStatus?.price?.status || (stock.dataSource === "missing" ? "missing" : "ok");
  chartInsight.className = `chart-insight ${sourceStatusPass(priceStatus) === true ? "good" : sourceStatusPass(priceStatus) === false ? "bad" : "neutral"}`;
  chartInsight.innerHTML = `
    <strong>차트 데이터</strong>
    <p>${escapeHtml(firstDate)} ~ ${escapeHtml(lastDate)} · ${rows.length}개 봉 · 거래량 ${volumeCount ? "포함" : "없음"} · ${escapeHtml(sourceStatusLabel(priceStatus))} · 출처 ${escapeHtml(priceSource)}</p>
  `;
  if (window.Chart) {
    document.querySelector("#modalChart").innerHTML = `<canvas id="priceChartCanvas"></canvas>`;
    const canvas = document.querySelector("#priceChartCanvas");
    if (modalChartInstance) {
      modalChartInstance.destroy();
    }
    modalChartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels: rows.map((row) => row.date),
        datasets: [
          {
            label: "종가",
            data,
            borderColor: "#f0f0f0",
            backgroundColor: "rgba(240, 240, 240, .06)",
            borderWidth: 3,
            pointRadius: 0,
            fill: false,
            tension: .28,
            yAxisID: "price"
          },
          {
            label: "EMA20",
            data: emaSeries(data, 20),
            borderColor: "#3b9eff",
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: .25,
            yAxisID: "price"
          },
          {
            label: "EMA50",
            data: emaSeries(data, 50),
            borderColor: "#ffca16",
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: .25,
            yAxisID: "price"
          },
          {
            label: "EMA200",
            data: emaSeries(data, 200),
            borderColor: "#baa7ff",
            borderWidth: 2,
            borderDash: [8, 6],
            pointRadius: 0,
            fill: false,
            tension: .2,
            yAxisID: "price"
          },
          {
            type: "bar",
            label: "거래량",
            data: rows.map((row) => row.volume),
            backgroundColor: rows.map((row, index) => index === 0 || row.close >= rows[index - 1].close ? "rgba(58, 211, 137, .24)" : "rgba(255, 149, 146, .22)"),
            borderWidth: 0,
            yAxisID: "volume"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            position: "top",
            align: "start",
            labels: { boxWidth: 22, boxHeight: 3, color: "#a1a4a5", font: { size: 12, weight: "600" } }
          },
          tooltip: {
            enabled: true,
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === "volume") return `거래량 ${formatVolume(context.parsed.y)}`;
                return `${context.dataset.label} ${priceText(stock, context.parsed.y)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxTicksLimit: 6, color: "#8b95a5", font: { size: 11 } }
          },
          price: {
            position: "left",
            grid: { color: "rgba(161, 164, 165, .16)" },
            ticks: {
              color: "#a1a4a5",
              font: { size: 11 },
              callback(value) { return stock.market === "kr" ? Math.round(value).toLocaleString("ko-KR") : `$${Number(value).toFixed(0)}`; }
            }
          },
          volume: {
            position: "right",
            grid: { display: false },
            ticks: {
              maxTicksLimit: 3,
              color: "#6e727a",
              font: { size: 10 },
              callback(value) { return formatVolume(value); }
            }
          }
        }
      }
    });
    return;
  }
  const width = 520;
  const height = 70;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const points = data.map((value, index) => {
    const x = index * (width / Math.max(1, data.length - 1));
    const y = height - ((value - min) / (max - min || 1)) * 58 - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  document.querySelector("#modalChart").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${stock.ticker} 가격 흐름">
      <polyline points="${points}" fill="none" stroke="#d9e7ff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline>
    </svg>
  `;
}

function renderTabs() {
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === selectedTab);
  });
}

function rowsHtml(rows) {
  return rows.map(([code, text, pass]) => `
    <div class="factor-row ${pass ? "pass" : ""}">
      <span class="factor-code">${code}</span>
      <span>${text}</span>
    </div>
  `).join("");
}

function renderFactorList(title, rows, includeSupport = false) {
  const support = includeSupport ? `
    <div class="section-label">보조 지표</div>
    ${rowsHtml(getSelectedStock().support || [])}
  ` : "";
  tabContent.innerHTML = `
    <div class="tab-title">${title}</div>
    <div class="factor-list">${rowsHtml(rows || [])}${support}</div>
  `;
}

function sentimentMeter({ positive, neutral, negative }) {
  const total = Math.max(1, positive + neutral + negative);
  return `
    <div class="sentiment-meter" aria-label="뉴스 감성 분포">
      <i class="good" style="width:${(positive / total) * 100}%"></i>
      <i class="neutral" style="width:${(neutral / total) * 100}%"></i>
      <i class="bad" style="width:${(negative / total) * 100}%"></i>
    </div>
  `;
}

function newsList(items) {
  return `
    <div class="news-list">
      ${items.map((item) => {
        const title = Array.isArray(item) ? item[0] : item.title;
        const tone = Array.isArray(item) ? item[1] : item.tone;
        const href = Array.isArray(item) ? "" : item.url;
        const evidence = Array.isArray(item)
          ? ""
          : [item.reason, Number.isFinite(Number(item.score)) ? `감성점수 ${Number(item.score) > 0 ? "+" : ""}${Number(item.score)}` : ""].filter(Boolean).join(" · ");
        return `
        <a href="${escapeHtml(href || `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(title || "")}`)}" target="_blank" rel="noopener">
          <span class="dot ${tone}"></span>
          <span>
            ${escapeHtml(title)}
            ${evidence ? `<small>${escapeHtml(evidence)}</small>` : ""}
          </span>
        </a>
      `;
      }).join("")}
    </div>
  `;
}

function sentimentEvidence(sentiment) {
  const source = sentiment?.source || "대체 계산";
  const method = sentiment?.method || "제목 키워드 기반 분류";
  const confidence = sentiment?.confidence || "보통";
  return `
    <div class="sentiment-evidence">
      <span>출처 ${escapeHtml(source)}</span>
      <span>방식 ${escapeHtml(method)}</span>
      <span>신뢰도 ${escapeHtml(confidence)}</span>
    </div>
  `;
}

function earningsGrid(rows, isKr = false) {
  return `
    <div class="earnings-grid">
      ${rows.map(([date, beat, gap, actual, estimate]) => `
        <div class="earnings-cell ${beat ? "beat" : "miss"}">
          <span>${escapeHtml(date)}</span>
          <strong>${beat ? "✓" : "×"}</strong>
          <b>${isKr ? "컨센 대비" : "vs Est"} ${escapeHtml(gap)}</b>
          <small>${escapeHtml(actual)}<br>${escapeHtml(estimate)}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function filingItems(filings) {
  if (Array.isArray(filings)) return filings;
  return filings?.items || [];
}

function renderKrFilingItems(filings, defaultUrl) {
  return filingItems(filings).map((item) => {
    const date = Array.isArray(item) ? item[0] : item.date;
    const title = Array.isArray(item) ? item[1] : item.title;
    const href = Array.isArray(item) ? item[2] : item.url;
    return `
      <a href="${escapeHtml(href || defaultUrl)}" target="_blank" rel="noopener">
        <time>${escapeHtml(date || "DART")}</time>
        <strong>${escapeHtml(title || "")}</strong>
        <span>&rarr;</span>
      </a>
    `;
  }).join("");
}

function filingImportance(form, title = "") {
  const text = `${form || ""} ${title || ""}`;
  if (/10-K|10-Q|8-K|S-1|424B|FORM 4|4\b|분기보고서|사업보고서|반기보고서|주요사항|영업\(잠정\)|단일판매/i.test(text)) return "중요";
  if (/13F|SC 13|지분|임원|소송|합병|분할|유상증자/i.test(text)) return "확인";
  return "일반";
}

function renderSecFilingItems(filings, defaultUrl) {
  return filingItems(filings).map((item) => {
    const date = Array.isArray(item) ? item[0] : item.date;
    const form = Array.isArray(item) ? item[1] : item.form;
    const title = Array.isArray(item) ? item[2] : item.title;
    const href = Array.isArray(item) ? defaultUrl : item.url;
    const source = Array.isArray(item) ? "" : item.source;
    const importance = filingImportance(form, title);
    return `
      <a href="${escapeHtml(href || defaultUrl)}" target="_blank" rel="noopener">
        <time>${escapeHtml(date || "")}</time>
        <b>${escapeHtml(form || "")}</b>
        <strong>${escapeHtml(title || form || "")}</strong>
        <em class="filing-importance">${escapeHtml(importance)}</em>
        ${source ? `<em>${escapeHtml(source)}</em>` : ""}
        <span>&rarr;</span>
      </a>
    `;
  }).join("");
}

function renderOwnershipCard(item) {
  const label = Array.isArray(item) ? item[0] : item.label;
  const value = Array.isArray(item) ? item[1] : item.value;
  const sub = Array.isArray(item) ? item[2] : item.sub;
  const url = Array.isArray(item) ? "" : item.url;
  const source = Array.isArray(item) ? "" : item.source;
  const content = `
    <span>${escapeHtml(label || "")}</span>
    <strong>${escapeHtml(value || "-")}</strong>
    ${sub ? `<small>${escapeHtml(sub)}</small>` : ""}
    ${source ? `<em>${escapeHtml(source)}</em>` : ""}
  `;
  return url
    ? `<a class="intel-card ownership-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">${content}</a>`
    : `<article class="intel-card ownership-card">${content}</article>`;
}

function renderInstitutionalHolders(items, defaultUrl) {
  return (items || []).map((item) => `
    <a href="${escapeHtml(item.url || defaultUrl)}" target="_blank" rel="noopener">
      <time>${escapeHtml(item.date || "13F")}</time>
      <b>13F</b>
      <strong>${escapeHtml(item.holder || "기관")}</strong>
      <span>${escapeHtml(item.shares || "-")}</span>
      ${item.source ? `<em>${escapeHtml(item.source)}</em>` : ""}
    </a>
  `).join("");
}

function renderKrInsightLegacyStaticA(stock) {
  const dartSearch = `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(stock.company)}`;
  tabContent.innerHTML = `
    <section class="intel-stack">
      <article class="intel-card">
        <header class="intel-head">
          <h3>뉴스 감성분석</h3>
          <span class="status-badge neutral">${krInsights.sentiment.label}</span>
        </header>
        <p class="sentiment-count">긍정 ${krInsights.sentiment.positive} · 중립 ${krInsights.sentiment.neutral} · 부정 ${krInsights.sentiment.negative}</p>
        ${sentimentMeter(krInsights.sentiment)}
        <p class="intel-copy">${escapeHtml(stock.company)} ${krInsights.sentiment.summary}</p>
        ${newsList(krInsights.sentiment.items)}
      </article>

      <article class="intel-card flush">
        <header class="intel-head compact">
          <h3>실적 서프라이즈</h3>
          <span>최근 4분기</span>
        </header>
        ${earningsGrid(krInsights.earnings, true)}
      </article>

      <article class="intel-card flush">
        <header class="intel-head compact">
          <h3>최근 공시</h3>
          <a href="${dartSearch}" target="_blank" rel="noopener">DART 전체보기</a>
        </header>
        <div class="filing-list">
          ${renderKrFilingItems(krInsights.filings, dartSearch)}
        </div>
      </article>
    </section>
  `;
}

function renderUsInsightLegacyEnglishA(stock) {
  const insight = stock.usInsight;
  const data = insight || usInsights;
  const secUrl = `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(stock.ticker)}`;
  const s = detailStats(stock);
  const analystTarget = s.target ? `${formatPrice(stock, s.price)} → ${formatPrice(stock, s.target)}` : "-";
  tabContent.innerHTML = `
    <section class="intel-stack">
      ${renderSourceStatus(stock)}
      <article class="intel-card earnings-date">
        <span class="calendar-icon">📅</span>
        <div><strong>${escapeHtml(data.earningsDate || "확인 필요")}</strong><small>Earnings Date</small></div>
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>Earnings Surprise</h3><span>최근 데이터</span></header>
        ${earningsGrid(data.earnings || [])}
      </article>
      <div class="ownership-grid">
        ${(data.ownership || []).map(renderOwnershipCard).join("")}
      </div>
      ${(data.institutionalHolders || []).length ? `
        <article class="intel-card flush">
          <header class="intel-head compact"><h3>기관 13F 보유자</h3><span>${data.institutionalHolders.length}건</span></header>
          <div class="filing-list sec">
            ${renderInstitutionalHolders(data.institutionalHolders, secUrl)}
          </div>
        </article>
      ` : ""}
      ${(data.insiderFilings || []).length ? `
        <article class="intel-card flush">
          <header class="intel-head compact"><h3>내부자 거래 Form 4</h3><span>${data.insiderFilings.length}건</span></header>
          <div class="filing-list sec">
            ${renderSecFilingItems(data.insiderFilings, secUrl)}
          </div>
        </article>
      ` : ""}
      <article class="intel-card">
        <header class="intel-head"><h3>News Sentiment</h3><span class="status-badge good">${escapeHtml(data.sentiment?.label || "Neutral")}</span></header>
        <p class="sentiment-count">Positive ${data.sentiment?.positive || 0} · Neutral ${data.sentiment?.neutral || 0} · Negative ${data.sentiment?.negative || 0}</p>
        ${sentimentMeter(data.sentiment || { positive: 0, neutral: 1, negative: 0 })}
        <p class="intel-copy">${escapeHtml(data.sentiment?.summary || `${stock.ticker} insight data is being prepared.`)}</p>
        ${newsList(data.sentiment?.items || [])}
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>Analyst Recommendations</h3><span>${(data.analysts || []).length}건</span></header>
        <div class="analyst-list">
          ${(data.analysts || []).map(([firm, rating, target], index) => `
            <div><span>MAIN</span><strong>${escapeHtml(firm)}</strong><em>${escapeHtml(rating)}</em><b>${escapeHtml(index === 0 && !target ? analystTarget : target || "-")}</b></div>
          `).join("")}
        </div>
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>SEC Filings</h3><a href="${secUrl}" target="_blank" rel="noopener">SEC 전체보기</a></header>
        <div class="filing-list sec">
          ${renderSecFilingItems(data.filings, secUrl)}
        </div>
      </article>
    </section>
  `;
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const output = [];
  let prev = values[0];
  for (let index = 0; index < values.length; index += 1) {
    prev = index === 0 ? values[index] : values[index] * k + prev * (1 - k);
    output.push(Number(prev.toFixed(2)));
  }
  return output;
}

function formatVolume(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(0)}K`;
  return String(Math.round(number));
}

function renderKrInsightLegacyStatic(stock) {
  const insight = stock.krInsight;
  const data = insight || krInsights;
  const dartSearch = `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(stock.company)}`;
  tabContent.innerHTML = `
    <section class="intel-stack">
      ${renderSourceStatus(stock)}
      <article class="intel-card">
        <header class="intel-head"><h3>뉴스 감성분석</h3><span class="status-badge neutral">${escapeHtml(data.sentiment?.label || "중립")}</span></header>
        <p class="sentiment-count">긍정 ${data.sentiment?.positive || 0} · 중립 ${data.sentiment?.neutral || 0} · 부정 ${data.sentiment?.negative || 0}</p>
        ${sentimentEvidence(data.sentiment)}
        ${sentimentMeter(data.sentiment || { positive: 0, neutral: 1, negative: 0 })}
        <p class="intel-copy">${escapeHtml(data.sentiment?.summary || "국장 뉴스 감성 데이터는 준비 중입니다.")}</p>
        ${newsList(data.sentiment?.items || [])}
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>실적 서프라이즈</h3><span>최근 데이터</span></header>
        ${earningsGrid(data.earnings || [], true)}
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>최근 공시</h3><a href="${dartSearch}" target="_blank" rel="noopener">DART 전체보기</a></header>
        <div class="filing-list">
          ${renderKrFilingItems(data.filings, dartSearch)}
        </div>
      </article>
    </section>
  `;
}
function renderTabContentLegacyA() {
  const stock = getSelectedStock();
  if (selectedTab === "canslim") {
    renderFactorList("CAN SLIM 점수 요약", stock.canslim, true);
    return;
  }
  if (selectedTab === "technical") {
    renderFactorList("기술 지표 요약", stock.technical);
    return;
  }
  if (selectedTab === "finance") {
    renderFactorList("재무 지표 요약", stock.financeRows);
    return;
  }
  if (stock.market === "kr") {
    renderKrInsight(stock);
    return;
  }
  renderUsInsight(stock);
}

function renderLegacyInsight() {
  const stock = getSelectedStock();
  tabContent.innerHTML = `
    <div class="tab-title">US/KR 인사이트</div>
    <div class="insight-grid">
      ${(stock.insight || []).map(([title, body]) => `
        <article class="insight-card">
          <strong>${title}</strong>
          <p>${body}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function formatPrice(stock, value = stock.price) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  if (stock.market === "kr" || stock.yf_symbol?.endsWith(".KS") || stock.yf_symbol?.endsWith(".KQ")) {
    return number.toLocaleString("ko-KR", { maximumFractionDigits: 0 });
  }
  return number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pctText(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function findIndicatorValue(rows, matcher) {
  const item = (rows || []).find((row) => matcher(String(row?.title || "")));
  return item?.value === null || item?.value === undefined || item?.value === "" ? null : item.value;
}

const TERM_HELP = {
  "EPS 성장": "EPS는 주당순이익입니다. EPS 성장은 회사 이익이 전년 대비 얼마나 늘었는지 보는 실적 성장 지표입니다.",
  "ROE": "ROE는 자기자본이익률입니다. 주주자본으로 얼마나 효율적으로 이익을 내는지 보여줍니다. CAN SLIM에서는 17% 이상을 선호합니다.",
  "12M 수익률": "최근 12개월 동안 주가가 얼마나 올랐는지 보는 장기 모멘텀 지표입니다.",
  "RS 등급": "상대강도 등급입니다. 시장 평균 대비 얼마나 강하게 움직였는지 0~100점으로 봅니다.",
  "RSI (14)": "14일 RSI입니다. 70 이상은 과열, 30 이하는 과매도 구간으로 봅니다.",
  "ADX": "추세 강도 지표입니다. 25 이상이면 방향성과 관계없이 추세가 강하다고 봅니다.",
  "ATR%": "ATR은 평균 실제 변동폭입니다. ATR%는 현재가 대비 변동폭 비율로, 높을수록 손절폭과 목표가를 더 넓게 잡아야 합니다.",
  "VWAP 거리": "거래량가중평균가격 대비 현재가 위치입니다. VWAP 위에 있으면 수요가 받쳐주는 강세 위치로 봅니다.",
  "거래량 비율": "최근 거래량을 50일 평균 거래량과 비교한 값입니다. 1배 이상이면 평소보다 거래 참여가 많다는 뜻입니다.",
  "계좌 규모": "포트폴리오 리스크 계산의 기준 금액입니다. Heat와 최대 단일 리스크는 이 금액 대비 비율로 계산합니다.",
  "평가 금액": "보유 수량에 현재가를 곱한 현재 포지션 가치의 합계입니다. USD와 KRW 종목은 각각 원 통화 기준으로 표시됩니다.",
  "오픈 리스크": "현재가에서 손절가까지 하락했을 때 발생할 수 있는 예상 손실 합계입니다. 종목별로 (현재가 - 손절가) × 수량으로 계산합니다.",
  "포트폴리오 Heat": "전체 오픈 리스크를 계좌 규모로 나눈 값입니다. 대략 6~8% 이상이면 포트폴리오 손절 위험이 높은 편으로 봅니다.",
  "섹터 집중도": "평가금액 기준으로 가장 큰 섹터가 포트폴리오에서 차지하는 비중입니다. 높을수록 특정 업종에 쏠린 상태입니다.",
  "최대 단일 리스크": "개별 종목 중 손절 시 계좌에 가장 크게 영향을 주는 리스크 비율입니다. 한 종목의 오픈 리스크 ÷ 계좌 규모로 계산합니다.",
  "KRW 환산 평가": "미국 주식과 한국 주식을 합쳐 보기 위해 USD 보유금액을 USD/KRW 환율로 환산한 총 평가금액입니다.",
  "점수 변화": "보유 종목 재스캔 기록을 기준으로 종합점수와 진입점수가 얼마나 변했는지 보여줍니다."
};

function termLabel(label) {
  const help = TERM_HELP[label];
  if (!help) return escapeHtml(label);
  return `<span class="term-label-text">${escapeHtml(label)}</span><span class="term-help" tabindex="0" aria-label="${escapeHtml(help)}"></span>`;
}

function hydrateStaticTermHelp() {
  document.querySelectorAll("[data-term-help]").forEach((el) => {
    const label = el.dataset.termHelp || el.textContent.trim();
    el.innerHTML = termLabel(label);
  });
}

function detailStats(stock) {
  const chart = (stock.chart || []).map(Number).filter(Number.isFinite);
  const first = chart[0];
  const last = chart.at(-1);
  const target = stock.finance?.target ?? stock.tradePlan?.target1 ?? null;
  const price = stock.price ?? last ?? null;
  const momentum = first && last ? ((last / first) - 1) * 100 : 0;
  const vwapGap = stock.finance?.vwapGap ?? 0;
  const volumeRatio = stock.volumeRatio ?? 1;
  const atr = stock.tradePlan?.atr ?? 0;
  return {
    price,
    target,
    rsi: Number(stock.finance?.rsi ?? 50),
    rs: Number(stock.rsRating ?? 0),
    momentum,
    vwapGap,
    volumeRatio: Number(volumeRatio),
    atrPct: price ? (Number(atr) / Number(price)) * 100 : 0,
    adx: Math.max(18, Math.min(42, Number(stock.score || 0) / 2))
  };
}

function renderSideStats(stock) {
  const finance = stock.financeIndicators || [];
  const technical = stock.technicalIndicators || [];
  const epsValue = findIndicatorValue(finance, (title) => title.toUpperCase().includes("EPS")) ?? "-";
  const roeValue = findIndicatorValue(finance, (title) => title.toUpperCase() === "ROE") ?? "-";
  const return12m = findIndicatorValue(technical, (title) => title.toUpperCase().includes("12M")) ?? "-";
  const rsGrade = findIndicatorValue(technical, (title) => {
    const upper = title.toUpperCase();
    return upper.includes("RS") && !upper.includes("RSI");
  }) ?? stock.rsRating ?? "-";

  document.querySelector("#sideStats").innerHTML = `
    <article><span>${termLabel("EPS 성장")}</span><strong>${escapeHtml(epsValue)}</strong></article>
    <article><span>${termLabel("ROE")}</span><strong>${escapeHtml(roeValue)}</strong></article>
    <article><span>${termLabel("12M 수익률")}</span><strong>${escapeHtml(return12m)}</strong></article>
    <article><span>${termLabel("RS 등급")}</span><strong>${escapeHtml(rsGrade)}</strong></article>
  `;
}

function renderTimingPanel(stock) {
  const technical = stock.technicalIndicators || [];
  const rsi = findIndicatorValue(technical, (title) => title === "RSI (14)") ?? "-";
  const adx = findIndicatorValue(technical, (title) => title.toUpperCase() === "ADX") ?? "-";
  const vwap = findIndicatorValue(technical, (title) => title.toUpperCase().includes("VWAP")) ?? "-";
  const volume = findIndicatorValue(technical, (title) => title.toLowerCase().includes("volume") || title.includes("거래량")) ?? "-";

  document.querySelector("#timingPanel").innerHTML = `
    <div class="timing-title">
      <span>진입 타이밍</span>
      <strong>${escapeHtml(stock.verdict || "관망")}</strong>
      <small>서버 계산 지표</small>
    </div>
    <div class="timing-grid">
      <article><span>${termLabel("RSI (14)")}</span><strong>${escapeHtml(rsi)}</strong><em>모멘텀</em></article>
      <article><span>${termLabel("ADX")}</span><strong>${escapeHtml(adx)}</strong><em>추세</em></article>
      <article><span>${termLabel("VWAP 거리")}</span><strong>${escapeHtml(vwap)}</strong><em>가격</em></article>
      <article><span>${termLabel("거래량 비율")}</span><strong>${escapeHtml(volume)}</strong><em>수급</em></article>
    </div>
  `;
}

function statusClass(pass) {
  if (pass === true) return "good";
  if (pass === false) return "bad";
  return "neutral";
}

function indicatorDataBadge(item) {
  const status = item?.dataStatus;
  const source = item?.dataSource;
  const label = item?.dataLabel || (status === "real" ? "실데이터" : status === "fallback" ? "대체 계산" : "가격 기반");
  const tone = item?.dataTone || status || "derived";
  if (!status && !source && !item?.dataLabel) return "";
  const sourceText = source && source !== label ? ` · ${source}` : "";
  return `<em class="indicator-source ${escapeHtml(tone)}">${escapeHtml(label)}${escapeHtml(sourceText)}</em>`;
}

function indicatorRow(row) {
  const item = Array.isArray(row)
    ? { title: row[0], desc: row[1], value: row[2], pass: row[3] }
    : row;
  const title = item?.title;
  const desc = item?.desc;
  const value = item?.value;
  const pass = Object.hasOwn(item || {}, "pass")
    ? item.pass
    : item?.status === "good" ? true : item?.status === "bad" ? false : null;
  return `
    <div class="indicator-row ${statusClass(pass)}">
      <div>
        <strong>${termLabel(String(title || ""))}</strong>
        <small>${escapeHtml(desc || "")}</small>
        ${indicatorDataBadge(item)}
      </div>
      <b>${escapeHtml(value ?? "-")}</b>
    </div>
  `;
}

function formatSourceTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function uniqueFinanceSources(stock) {
  return [...new Set((stock.financeIndicators || [])
    .map((item) => item?.dataSource)
    .filter(Boolean))];
}

function renderFinanceContext(stock) {
  const priceSource = stock.sourceStatus?.price?.source || stock.dataSource || "가격 캐시";
  const priceUpdatedAt = stock.sourceStatus?.price?.updatedAt;
  const financeSources = uniqueFinanceSources(stock).filter((source) => !/데이터 출처|통화/i.test(source));
  const sourceText = financeSources.length ? financeSources.join(" + ") : "가격 기반 계산";
  const updatedCandidates = Object.values(stock.sourceStatus || {})
    .map((item) => item?.updatedAt)
    .filter(Boolean)
    .sort();
  const updatedAt = updatedCandidates.at(-1) || priceUpdatedAt;
  const peItem = (stock.financeIndicators || []).find((item) => String(item.title).toUpperCase() === "PER");
  const epsItem = (stock.financeIndicators || []).find((item) => String(item.title).toUpperCase() === "EPS");
  const peValue = Number(peItem?.value);
  const epsValue = Number(epsItem?.value);
  const formula = Number.isFinite(peValue) && Number.isFinite(epsValue) && epsValue > 0
    ? `PER ${peValue.toFixed(1)} = 가격 ${money(stock.price)} / EPS ${epsValue.toFixed(2)}`
    : "PER/PBR은 공급 API의 TTM 지표를 우선 사용합니다.";
  return `
    <div class="finance-context">
      <article>
        <span>기준 가격</span>
        <strong>${priceText(stock)}</strong>
        <small>${escapeHtml(priceSource)} · ${formatSourceTime(priceUpdatedAt)}</small>
      </article>
      <article>
        <span>재무 소스</span>
        <strong>${escapeHtml(sourceText)}</strong>
        <small>TTM 기준 우선 · 최신 공개 API 값</small>
      </article>
      <article>
        <span>계산 기준</span>
        <strong>${escapeHtml(formula)}</strong>
        <small>사이트별 현재가와 EPS 기준 차이로 PER/PBR은 달라질 수 있습니다.</small>
      </article>
      <article>
        <span>업데이트</span>
        <strong>${formatSourceTime(updatedAt)}</strong>
        <small>상세 API 응답 기준</small>
      </article>
    </div>
  `;
}

function renderTechnicalContext(stock) {
  const price = stock.sourceStatus?.price || {};
  const technical = stock.technicalIndicators || [];
  const derivedCount = technical.filter((item) => item?.dataStatus === "derived").length;
  const fallbackCount = technical.filter((item) => item?.dataStatus === "fallback").length;
  const sourceText = [...new Set(technical.map((item) => item?.dataSource).filter(Boolean))].join(" + ") || price.source || stock.dataSource || "가격 기반 계산";
  return `
    <div class="finance-context technical-context">
      <article>
        <span>기술 지표 소스</span>
        <strong>${escapeHtml(sourceText)}</strong>
        <small>${escapeHtml(sourceStatusLabel(price.status || "ok"))} · ${formatSourceTime(price.updatedAt)}</small>
      </article>
      <article>
        <span>지표 상태</span>
        <strong>파생 ${derivedCount} · 대체 ${fallbackCount}</strong>
        <small>초록 배경은 우호적 신호, 검은 배경은 중립/관찰 신호입니다. RSI, ADX, ATR, VWAP 등은 가격/거래량에서 계산됩니다.</small>
      </article>
    </div>
  `;
}

function compactRows(rows) {
  return (rows || []).map(([code, text, pass]) => ({
    code,
    title: text,
    pass,
    value: pass ? "통과" : "주의",
    body: text
  }));
}

function metricScore(value, goodAt = 70) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Math.max(0, Math.min(100, Number(value)));
}

function signedScore(raw, scale = 1) {
  return Math.max(0, Math.min(100, 50 + raw * scale));
}

function quantContribution(score, weight) {
  if (!weight) return "volatility adjustment +0.0";
  return `score ${score.toFixed(1)}/100 x weight ${weight.toFixed(1)}% = contribution ${((score * weight) / 100).toFixed(1)}`;
}

function quantCard(code, title, desc, raw, scale, weight, body, pass = null, value = null, inputs = []) {
  const score = value === null ? signedScore(raw, scale) : Math.max(0, Math.min(100, Number(value)));
  return [code, title, desc, pass === null ? (score >= 70 ? true : score < 40 ? false : null) : pass, score, `${body} ${quantContribution(score, weight)}`, {
    score,
    rawScore: raw,
    weight,
    contribution: Number(((score * (weight || 0)) / 100).toFixed(2)),
    inputs: inputs.length ? inputs : [`raw: ${raw.toFixed(1)}`, `normalized: ${score.toFixed(1)}`],
    calculation: [`raw: ${raw.toFixed(1)}`, `normalized: ${score.toFixed(1)}/100`, `weight: ${weight.toFixed(1)}%`]
  }];
}

function recentMaxDrawdown(values, windowSize = 10) {
  const prices = (values || []).map(Number).filter(Number.isFinite).slice(-windowSize);
  if (prices.length < 2) return null;
  let peak = prices[0];
  let maxDrawdown = 0;
  prices.forEach((price) => {
    peak = Math.max(peak, price);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, (price / peak - 1) * 100);
  });
  return maxDrawdown;
}

function clientQuantMathCards() {
  return [];
}

function clientCanslimCards(stock) {
  return compactRows([...(stock.canslim || []), ...(stock.support || [])]);
}

function translateFactorText(value) {
  if (value === null || value === undefined) return value;
  let text = String(value);
  const replacements = [
    [/Current QE/g, "최근 분기 실적"],
    [/Annual EPS/g, "연간 실적"],
    [/New Highs/g, "신고가"],
    [/New High \/ Pivot/g, "신고가·피벗 돌파"],
    [/Supply\/Demand/g, "수급·거래량"],
    [/Leader\/Laggard/g, "주도주 판별"],
    [/Institutional Flow/g, "기관 수급"],
    [/Institutional/g, "기관 수급"],
    [/Market Direction/g, "시장 방향"],
    [/Value-Quality Factor/g, "가치·퀄리티 팩터"],
    [/Fama-French Factor/g, "파마-프렌치 팩터"],
    [/Mean Reversion/g, "평균 회귀"],
    [/Momentum \(Carhart\)/g, "카하트 모멘텀"],
    [/Multi-Timeframe/g, "다중 시간대"],
    [/Drawdown Risk/g, "낙폭 위험도"],
    [/Smart Money Flow/g, "스마트머니 흐름"],
    [/Target Price Factor/g, "목표가 팩터"],
    [/Short Interest/g, "공매도 비율"],
    [/Hurst Exponent/g, "허스트 지수"],
    [/Kalman Filter/g, "칼만 필터"],
    [/Stat Arb Z-Score/g, "통계적 Z-Score"],
    [/Vol-Adjusted \(DE Shaw\)/g, "변동성 조정"],
    [/Market Sentiment Proxy/g, "시장 심리 추정"],
    [/Recent quarterly EPS growth is assumed flat until earnings data is available\./g, "실적 데이터가 부족해 최근 분기 EPS 성장은 보수적으로 0%로 반영했습니다."],
    [/ROE is below the 17% benchmark when verified financial data is unavailable\./g, "검증된 ROE 데이터가 부족해 기준 17% 미달로 보수 계산했습니다."],
    [/Price is ([0-9.]+)% below the 52-week high\./g, "52주 최고가에서 $1% 아래입니다."],
    [/It is near the high zone\./g, "신고가 권역에 가깝습니다."],
    [/It is not near the high zone\./g, "신고가 권역은 아닙니다."],
    [/Pivot breakout is not confirmed\./g, "피벗 돌파는 아직 확인되지 않았습니다."],
    [/Pivot breakout is detected\./g, "피벗 돌파가 감지됐습니다."],
    [/Volume is ([0-9.]+)x the average\./g, "거래량은 평균의 $1배입니다."],
    [/Breakout volume is not confirmed\./g, "돌파 거래량은 아직 부족합니다."],
    [/Breakout volume is confirmed\./g, "돌파 거래량이 확인됐습니다."],
    [/Relative strength rating is ([0-9.]+)\./g, "상대강도는 $1점입니다."],
    [/Leadership is not fully confirmed\./g, "주도주는 아직 완전히 확인되지 않았습니다."],
    [/Leadership is confirmed\./g, "시장 주도주로 볼 수 있습니다."],
    [/Institutional flow is neutral to positive\./g, "기관 자금 흐름은 중립 이상입니다."],
    [/MFI is ([0-9.]+)\./g, "MFI는 $1입니다."],
    [/Market direction is ([A-Z_]+)\./g, "현재 시장 방향은 $1입니다."],
    [/ADX is ([0-9.]+)\./g, "ADX는 $1입니다."],
    [/score ([0-9.]+)\/100 x weight ([0-9.]+)% = contribution ([0-9.]+)/g, "점수 $1/100 x 가중치 $2% = 기여도 $3점"],
    [/raw:/g, "원점수:"],
    [/normalized:/g, "정규화:"],
    [/weight:/g, "가중치:"]
  ];
  replacements.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  return text;
}

function translateFactorDetail(detail) {
  if (!detail) return detail;
  return {
    ...detail,
    inputs: (detail.inputs || []).map(translateFactorText),
    calculation: (detail.calculation || []).map(translateFactorText)
  };
}

function normalizeFactorCard(item) {
  if (Array.isArray(item)) {
    const [code, title, desc, pass, value, body, detail] = item;
    const score = Number(value);
    return {
      code,
      title: translateFactorText(title),
      desc: translateFactorText(desc),
      pass,
      displayValue: Number.isFinite(score) ? score : null,
      barValue: Number.isFinite(score) ? score : 0,
      body: translateFactorText(body),
      dataStatus: "derived",
      dataSource: "가격 기반 계산",
      detail: translateFactorDetail(detail) || null
    };
  }
  const factorNumber = (value) => value === null || value === undefined || value === "" ? NaN : Number(value);
  const normalized = factorNumber(item.normalizedScore ?? item.value ?? item.barValue);
  const raw = factorNumber(item.rawScore);
  const hasDisplayValue = Object.prototype.hasOwnProperty.call(item, "displayValue");
  const explicitDisplay = factorNumber(item.displayValue);
  const explicitBar = factorNumber(item.barValue);
  const displayValue = hasDisplayValue
    ? (Number.isFinite(explicitDisplay) ? explicitDisplay : null)
    : Number.isFinite(raw) ? raw : normalized;
  const barValue = Number.isFinite(explicitBar)
    ? explicitBar
    : Number.isFinite(normalized)
      ? normalized
      : Math.max(0, Math.min(100, displayValue || 0));
  const pass = typeof item.pass === "boolean" || item.pass === null
    ? item.pass
    : item.status === "good"
      ? true
      : item.status === "bad"
        ? false
        : null;
  return {
    code: item.code,
    title: translateFactorText(item.title),
    desc: translateFactorText(item.desc),
    pass,
    rawScore: Number.isFinite(raw) ? raw : null,
    normalizedScore: Number.isFinite(normalized) ? normalized : null,
    displayValue,
    barValue,
    body: translateFactorText(item.body),
    dataStatus: item.dataStatus || inferFactorDataStatus(item),
    dataSource: item.dataSource || inferFactorDataSource(item),
    detail: translateFactorDetail(item.detail || {
      score: normalized,
      rawScore: item.rawScore,
      weight: item.weight,
      contribution: item.contribution,
      inputs: item.inputs || [],
      calculation: item.calculation || []
    })
  };
}

function inferFactorDataStatus(item) {
  const text = `${item.title || ""} ${item.body || ""} ${(item.inputs || []).join(" ")}`;
  if (/데이터가 부족|외부 목표가 데이터가 부족|공매도 데이터가 부족|검증된 ROE 데이터가 부족/i.test(text)) return "fallback";
  return "derived";
}

function inferFactorDataSource(item) {
  const status = item.dataStatus || inferFactorDataStatus(item);
  if (status === "fallback") return "대체 계산";
  if (status === "real") return "실데이터";
  return "가격 기반 계산";
}

function factorDataBadge(card) {
  const status = card.dataStatus || "derived";
  const label = status === "real" ? "실데이터" : status === "fallback" ? "대체 계산" : "가격 기반";
  const sourceText = String(card.dataSource || "");
  const repeatsLabel = sourceText === label || sourceText.includes(label) || label.includes(sourceText);
  const source = sourceText && !repeatsLabel ? ` · ${sourceText}` : "";
  return `<span class="factor-source ${escapeHtml(status)}">${escapeHtml(label)}${escapeHtml(source)}</span>`;
}

function factorScoreSuffix(card) {
  const raw = Number(card.rawScore ?? card.displayValue);
  const normalized = Number(card.normalizedScore);
  if (Number.isFinite(raw) && Number.isFinite(normalized) && Math.abs(raw - normalized) > 0.05) {
    return `<small>정규화 점수 · 원점수 ${raw.toFixed(1)}</small>`;
  }
  return "<small>/100</small>";
}

function factorSurfaceScore(card) {
  const normalized = Number(card.normalizedScore);
  if (Number.isFinite(normalized)) return normalized;
  const display = Number(card.displayValue);
  return Number.isFinite(display) ? display : null;
}

const FACTOR_GUIDES = {
  C: "C는 Current Earnings입니다. 최근 분기 EPS와 순이익이 전년 대비 얼마나 성장했고, 성장 속도가 빨라지는지를 봅니다. 높을수록 실적 모멘텀이 살아 있는 종목으로 해석합니다.",
  A: "A는 Annual Earnings입니다. 연간 이익 체력과 ROE를 봅니다. 일회성 반등보다 꾸준히 돈을 잘 버는 회사인지 확인하는 품질 지표입니다.",
  N: "N은 New Highs/New Factor입니다. 52주 신고가 근처인지, 새로운 추세나 피벗 돌파가 나왔는지를 봅니다. 강한 종목은 보통 고점 근처에서 다시 힘을 받습니다.",
  S: "S는 Supply/Demand입니다. 가격 돌파에 거래량이 같이 붙었는지 봅니다. 상승이 진짜 수요인지, 얇은 거래에서 나온 움직임인지 구분하는 항목입니다.",
  L: "L은 Leader/Laggard입니다. 시장 평균보다 강한 주도주인지 봅니다. RS 등급이 높을수록 같은 장 안에서 상대적으로 강한 종목입니다.",
  I: "I는 Institutional Sponsorship입니다. 기관성 자금 흐름, MFI, OBV 같은 수급 신호를 봅니다. 큰돈이 들어오는 구조인지 확인하는 항목입니다.",
  M: "M은 Market Direction입니다. 개별 종목보다 먼저 전체 장세가 우호적인지 봅니다. 시장 방향이 약하면 좋은 종목도 성공 확률이 낮아질 수 있습니다."
};

const FACTOR_TITLE_GUIDES = [
  ["가치·퀄리티", "가치·퀄리티 팩터는 밸류에이션과 수익성을 함께 봅니다. 너무 비싸게 거래되는지, 가격을 정당화할 품질이 있는지 확인합니다."],
  ["평균 회귀", "평균 회귀는 RSI와 Z점수로 단기 과열·과매도 위치를 봅니다. 너무 오른 자리에서는 점수가 낮고, 조정 후 반등 가능성이 있으면 유리합니다."],
  ["모멘텀", "모멘텀은 최근 수익률이 같은 섹터 안에서 얼마나 강한지 봅니다. 강한 추세가 이어지는 종목을 찾는 항목입니다."],
  ["다중 시간대", "다중 시간대는 단기·중기·장기 추세가 같은 방향인지 봅니다. 시간대가 정렬될수록 추세 신뢰도가 높습니다."],
  ["낙폭 위험도", "낙폭 위험도는 최근 고점 대비 얼마나 크게 빠졌는지 봅니다. 낙폭이 작을수록 추세 훼손이 적고, 손절 구조를 잡기 쉽습니다."],
  ["스마트머니", "스마트머니 흐름은 MFI, OBV, A/D 같은 수급 지표로 기관성 매수 압력을 추정합니다. 가격보다 먼저 수급이 좋아지는지 봅니다."],
  ["목표가", "목표가 팩터는 현재가와 외부 목표가 또는 모델 목표가의 괴리를 봅니다. 상승 여력이 충분한지 보조적으로 확인합니다."],
  ["공매도", "공매도 비율은 시장이 이 종목을 얼마나 부정적으로 보고 있는지 봅니다. 부담이 낮으면 수급 리스크가 작다고 봅니다."],
  ["허스트", "허스트 지수는 추세가 지속될 가능성을 보는 수학 지표입니다. 0.5보다 높을수록 추세 지속 성향이 강합니다."],
  ["칼만", "칼만 필터는 가격 노이즈를 줄여 현재 추세가 과열인지 안정적인지 봅니다. 매끈한 추세선 대비 위치를 확인합니다."],
  ["통계적 Z", "통계적 Z점수는 현재 가격이 최근 평균에서 얼마나 떨어져 있는지 봅니다. 극단값이면 단기 되돌림 가능성을 의심합니다."],
  ["변동성 조정", "변동성 조정은 같은 수익률이라도 위험을 얼마나 감수했는지 반영합니다. 변동성이 과하면 최종 점수의 신뢰도를 낮춥니다."],
  ["시장 심리", "시장 심리 추정은 가격, 거래량, 상승 강도로 투자심리를 추정합니다. 뉴스 데이터가 부족할 때 보조 심리 지표로 씁니다."]
];

function factorGuide(card) {
  if (FACTOR_GUIDES[card.code]) return FACTOR_GUIDES[card.code];
  const title = `${card.title || ""} ${card.desc || ""}`;
  const found = FACTOR_TITLE_GUIDES.find(([keyword]) => title.includes(keyword));
  if (found) return found[1];
  return "이 항목은 가격, 수급, 재무 데이터 중 해당 지표에 맞는 값을 0~100점으로 정규화해 종합 점수에 반영합니다.";
}

function factorJudgementText(text) {
  return String(text || "")
    .replace(/\s*점수\s+[0-9.]+\/100\s*x\s*가중치\s*[0-9.]+%\s*=\s*기여도\s*[0-9.]+점?\.?/gi, "")
    .trim();
}

function factorCards(stock) {
  const backendFactors = [
    ...(stock.canslimFactors || []),
    ...(stock.quantFactors || [])
  ];
  if (backendFactors.length) {
    return backendFactors.map((item) => normalizeFactorCard(item));
  }
  return [
    ...clientCanslimCards(stock),
    ...clientQuantMathCards(stock)
  ].map((item) => normalizeFactorCard(item));
}

function canslimSummaryRows(stock) {
  if (stock.canslimFactors && stock.canslimFactors.length) {
    const rows = stock.canslimFactors.map((item) => {
      const card = normalizeFactorCard(item);
      return [card.code, translateFactorText(card.body || card.title || card.desc || ""), card.pass];
    });
    const supportRows = (stock.support || [])
      .filter(([code]) => code !== "M")
      .map(([code, text, pass]) => [code, translateFactorText(text), pass]);
    return [...rows, ...supportRows];
  }
  return clientCanslimCards(stock).map((row) => [row.code, translateFactorText(row.body || row.title), row.pass]);
}

function renderCanslimDetail(stock) {
  renderFactorList("CAN SLIM 원칙 요약", stock.canslim, true);
}

function renderCanslimCardsLegacy(stock) {
  tabContent.innerHTML = `
    <div class="tab-title tab-title-centered">CAN SLIM 원칙 요약</div>
    <div class="factor-list detail-factor-list">
      ${rows.map(([code, text, pass], index) => `
        ${index === (stock.canslim || []).length ? `<div class="section-label">보조 지표</div>` : ""}
        <div class="factor-row ${statusClass(pass)}">
          <span class="factor-code">${escapeHtml(code)}</span>
          <span>${escapeHtml(text)}</span>
        </div>
      `).join("")}
    </div>
    <div class="factor-card-grid">
      ${factorCards(stock).map(([code, title, desc, pass, value, body]) => `
        <article class="factor-card ${statusClass(pass)}">
          <header>
            <span>${escapeHtml(code)}</span>
            <div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(desc)}</small></div>
            <button type="button" aria-label="상세">⌄</button>
          </header>
          <b>${value === null ? "데이터 부족" : value.toFixed(1)}</b>
          <div class="factor-bar"><i style="width:${value === null ? 12 : Math.max(4, Math.min(100, value))}%"></i></div>
          <p>${escapeHtml(body || "")}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderFactorDetail(detail) {
  if (!detail) return "";
  const score = Number(detail.score);
  const weight = Number(detail.weight || 0);
  const contribution = Number(detail.contribution ?? (score * weight / 100));
  const inputs = detail.inputs || [];
  const calculation = detail.calculation || [];
  const summary = factorJudgementText(detail.body || detail.summary || "");
  const warnings = [];
  if (detail.dataStatus === "fallback") warnings.push("대체 계산값입니다. 실데이터 연결 전까지 참고용으로만 보세요.");
  if (detail.dataStatus === "derived") warnings.push("가격 기반 파생 지표입니다. 재무/공시 원자료와 함께 확인하세요.");
  if (!inputs.length) warnings.push("세부 입력값이 없어 계산 근거를 완전히 검증하기 어렵습니다.");
  if (!calculation.length) warnings.push("계산 과정이 없어 정규화 방식을 화면에서 재확인하기 어렵습니다.");
  return `
    <div class="factor-detail hidden">
      <div class="factor-detail-meta">
        <span>${escapeHtml(detail.dataStatus === "real" ? "실데이터" : detail.dataStatus === "fallback" ? "대체 계산" : "가격 기반")}</span>
        <strong>${escapeHtml(detail.dataSource || "출처 미표시")}</strong>
      </div>
      ${warnings.length ? `
        <div class="factor-detail-warning">
          <strong>신뢰도 확인</strong>
          <ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      ` : ""}
      ${summary ? `
        <div class="factor-detail-section factor-judgement">
          <strong>현재 판정</strong>
          <p>${escapeHtml(summary)}</p>
        </div>
      ` : ""}
      <div class="factor-contribution">점수 ${Number.isFinite(score) ? score.toFixed(1) : "-"} /100 x 가중치 ${weight.toFixed(1)}% = 기여도 ${Number.isFinite(contribution) ? contribution.toFixed(1) : "0.0"}</div>
      <div class="factor-detail-section">
        <strong>입력 데이터</strong>
        ${inputs.length ? `<ul>${inputs.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>입력 데이터가 아직 없습니다.</p>`}
      </div>
      <div class="factor-detail-section">
        <strong>계산 과정</strong>
        ${calculation.length ? `<ol>${calculation.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : `<p>계산 과정이 아직 없습니다.</p>`}
      </div>
    </div>
  `;
}

function renderFactorCard(card, index) {
  const surfaceScore = factorSurfaceScore(card);
  return `
    <article class="factor-card ${statusClass(card.pass)}">
      <header>
        <span>${escapeHtml(card.code)}</span>
        <div><strong>${escapeHtml(card.title)}</strong><small>${escapeHtml(card.desc)}</small>${factorDataBadge(card)}</div>
        <button type="button" class="factor-toggle" data-factor-index="${index}" aria-expanded="false" aria-label="상세">⌄</button>
      </header>
      <b>${surfaceScore === null ? "데이터 부족" : surfaceScore.toFixed(1)}${factorScoreSuffix(card)}</b>
      <div class="factor-bar"><i style="width:${Number.isFinite(card.barValue) ? Math.max(4, Math.min(100, card.barValue)) : 12}%"></i></div>
      <p>${escapeHtml(factorGuide(card))}</p>
      ${renderFactorDetail({ ...(card.detail || {}), body: card.body, dataStatus: card.dataStatus, dataSource: card.dataSource })}
    </article>
  `;
}

function renderCanslimCards(stock) {
  const cards = factorCards(stock);
  const rows = canslimSummaryRows(stock);
  tabContent.innerHTML = `
    <div class="tab-title tab-title-centered">CAN SLIM 원칙 요약</div>
    ${renderTrustSummary(stock)}
    <div class="factor-list detail-factor-list">
      ${rows.map(([code, text, pass], index) => `
        ${index === 6 ? `<div class="section-label">보조 지표</div>` : ""}
        <div class="factor-row ${statusClass(pass)}">
          <span class="factor-code">${escapeHtml(code)}</span>
          <span>${escapeHtml(text)}</span>
        </div>
      `).join("")}
    </div>
    <div class="factor-card-grid">
      ${cards.map(renderFactorCard).join("")}
    </div>
  `;
}

function renderTechnicalRows(stock) {
  if (stock.technicalIndicators && stock.technicalIndicators.length) {
    tabContent.innerHTML = `
      ${renderTechnicalContext(stock)}
      <div class="indicator-list">${stock.technicalIndicators.map(indicatorRow).join("")}</div>
    `;
    return;
  }
  const s = detailStats(stock);
  const rows = [
    ["RSI (14)", "70 이상 과열 · 30 이하 과매도", `${s.rsi.toFixed(1)}`, s.rsi < 70 && s.rsi > 30],
    ["ADX", "추세 강도", `${Math.max(18, Math.min(42, stock.score / 2)).toFixed(1)}`, stock.score >= 55],
    ["ATR%", "변동성", `${s.atrPct.toFixed(2)}%`, null],
    ["VWAP 거리", "위에 있으면 강세", pctText(s.vwapGap, 1), s.vwapGap >= 0],
    ["RS 등급", "상대강도", `${s.rs}`, s.rs >= 80],
    ["12개월 수익률", "장기 모멘텀", pctText(s.momentum * 1.8, 1), s.momentum > 0],
    ["3개월 수익률", "단기 모멘텀", pctText(s.momentum, 1), s.momentum > 0],
    ["거래량 비율", "참여 강도", `${s.volumeRatio.toFixed(2)}배`, s.volumeRatio >= 1]
  ];
  tabContent.innerHTML = `
    ${renderTechnicalContext(stock)}
    <div class="indicator-list">${rows.map(indicatorRow).join("")}</div>
  `;
}
function renderFinanceRows(stock) {
  if (stock.financeIndicators && stock.financeIndicators.length) {
    tabContent.innerHTML = `
      ${renderFinanceContext(stock)}
      <div class="indicator-list">${stock.financeIndicators.map(indicatorRow).join("")}</div>
    `;
    return;
  }
  const rows = stock.financeRows || [
    ["PER", "밸류에이션", stock.finance?.pe ?? "-", null],
    ["목표가", "ATR 또는 애널리스트 목표가", stock.finance?.target ?? "-", true],
    ["RSI", "기술적 상태", stock.finance?.rsi ?? "-", null]
  ];
  tabContent.innerHTML = `
    ${renderFinanceContext(stock)}
    <div class="indicator-list">${rows.map(indicatorRow).join("")}</div>
  `;
}
function sourceStatusPass(status) {
  if (status === "ok") return true;
  if (status === "partial" || status === "missing_key" || status === "fallback" || status === "unavailable") return null;
  return false;
}

function sourceStatusLabel(status) {
  const labels = {
    ok: "연결됨",
    missing_key: "키 필요",
    missing: "데이터 없음",
    partial: "부분 연결",
    unavailable: "미지원",
    limited: "제한됨",
    fallback: "대체값"
  };
  return labels[status] || "확인 필요";
}

function sourceStatusTitle(key, item) {
  const titles = {
    price: "가격",
    fmp: "FMP",
    alphaVantage: "Alpha Vantage",
    dart: "DART",
    sec: "SEC",
    finra: "FINRA"
  };
  return titles[key] || item?.source || key;
}

function sourceTone(status) {
  if (status === "ok") return "real";
  if (status === "fallback" || status === "missing_key" || status === "missing") return "fallback";
  return "derived";
}

function renderSourcePills(stock) {
  const entries = Object.entries(stock.sourceStatus || {});
  if (!entries.length) return "";
  return `
    <div class="source-pill-row" aria-label="데이터 연결 상태">
      ${entries.map(([key, item]) => `
        <span class="source-pill ${sourceTone(item?.status)}">
          <b>${escapeHtml(sourceStatusTitle(key, item))}</b>
          ${escapeHtml(sourceStatusLabel(item?.status))}
        </span>
      `).join("")}
    </div>
  `;
}

function renderDataCrossChecks(stock) {
  const checks = stock.dataCrossChecks?.checks || [];
  const warnings = stock.anomalyWarnings || [];
  if (!checks.length && !warnings.length) return "";
  return `
    <div class="data-audit-list">
      ${checks.slice(0, 6).map((item) => `
        <div class="data-audit-row ${item.status === "warn" ? "warn" : "ok"}">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.summary)}</span>
        </div>
      `).join("")}
      ${warnings.slice(0, 5).map((item) => `
        <div class="data-audit-row ${item.level === "critical" ? "critical" : item.level === "info" ? "info" : "warn"}">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.summary)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTrustSummary(stock) {
  if (!stock.trust) return "";
  const tone = trustTone(stock);
  const warning = scoreReferenceWarning(stock);
  return `
    <article class="trust-summary ${tone}">
      <span>데이터 신뢰도</span>
      <strong>${escapeHtml(stock.trust.label)}</strong>
      <small>${escapeHtml(stock.trust.note || "")}</small>
      <small>${escapeHtml(trustCountsText(stock))}</small>
      ${renderSourcePills(stock)}
      ${renderDataCrossChecks(stock)}
      ${warning ? `<em>${escapeHtml(warning)}</em>` : ""}
    </article>
  `;
}

function renderClassificationEvidence(stock) {
  const item = stock.classification;
  if (!item) return "";
  return `
    <article class="classification-evidence">
      <span>분류 근거</span>
      <strong>${escapeHtml(item.label || item.assetType || "-")}</strong>
      <small>${escapeHtml(item.source || "unknown")} · 신뢰도 ${escapeHtml(item.confidence || "-")}</small>
      <p>${escapeHtml(item.reason || "")}</p>
    </article>
  `;
}

function renderSourceStatus(stock) {
  const rows = Object.entries(stock.sourceStatus || {}).map(([key, item]) => indicatorRow({
    title: sourceStatusTitle(key, item),
    desc: `${item?.source || key} · 업데이트 ${formatSourceTime(item?.updatedAt)}`,
    value: sourceStatusLabel(item?.status),
    pass: sourceStatusPass(item?.status),
    dataStatus: sourceTone(item?.status),
    dataSource: item?.source || key,
    dataLabel: sourceStatusLabel(item?.status),
    dataTone: sourceTone(item?.status)
  })).join("");
  const classification = renderClassificationEvidence(stock);
  return rows || classification ? `
    <article class="intel-card flush">
      <header class="intel-head compact"><h3>데이터 소스</h3><span>상태</span></header>
      <div class="indicator-list">${classification}${renderTrustSummary(stock)}${rows}</div>
    </article>
  ` : "";
}

function renderFilingSummary(summary) {
  if (!summary) return "";
  const cards = [
    ["SEC 최근 공시", summary.sec?.latestForm || "-", summary.sec?.latestTitle || "-", summary.sec?.latestDate || "-", summary.sec?.url],
    ["Form 4 내부자", `${summary.form4?.count || 0}건`, summary.form4?.latestTitle || "최근 내부자 거래 없음", `매수 ${summary.form4?.buyCount || 0} · 매도 ${summary.form4?.sellCount || 0}`, summary.form4?.url],
    ["13F 기관", `${summary.institutional13f?.count || 0}건`, summary.institutional13f?.topHolder || "-", `${summary.institutional13f?.topShares || "-"} · ${summary.institutional13f?.latestDate || "-"}`, summary.institutional13f?.url]
  ];
  return `
    <article class="intel-card flush">
      <header class="intel-head compact"><h3>SEC/Form 4/13F 구조화 요약</h3><span>공시·수급</span></header>
      <div class="filing-summary-grid">
        ${cards.map(([label, value, body, meta, url]) => `
          <a href="${escapeHtml(url || "#")}" target="_blank" rel="noopener">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(body)}</small>
            <em>${escapeHtml(meta)}</em>
          </a>
        `).join("")}
      </div>
    </article>
  `;
}

function renderUsInsight(stock) {
  const insight = stock.usInsight;
  const data = insight || usInsights;
  const secUrl = `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(stock.ticker)}`;
  const s = detailStats(stock);
  const analystTarget = s.target ? `${formatPrice(stock, s.price)} → ${formatPrice(stock, s.target)}` : "-";
  tabContent.innerHTML = `
    <section class="intel-stack">
      ${renderSourceStatus(stock)}
      <article class="intel-card earnings-date">
        <span class="calendar-icon">📅</span>
        <div><strong>${escapeHtml(data.earningsDate || "확인 필요")}</strong><small>어닝 발표일</small></div>
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>어닝 서프라이즈</h3><span>최근 데이터</span></header>
        ${earningsGrid(data.earnings || [])}
      </article>
      <div class="ownership-grid">
        ${(data.ownership || []).map(renderOwnershipCard).join("")}
      </div>
      ${renderFilingSummary(data.filingSummary)}
      ${(data.institutionalHolders || []).length ? `
        <article class="intel-card flush">
          <header class="intel-head compact"><h3>기관 13F 보유자</h3><span>${data.institutionalHolders.length}건</span></header>
          <div class="filing-list sec">
            ${renderInstitutionalHolders(data.institutionalHolders, secUrl)}
          </div>
        </article>
      ` : ""}
      ${(data.insiderFilings || []).length ? `
        <article class="intel-card flush">
          <header class="intel-head compact"><h3>내부자 거래 Form 4</h3><span>${data.insiderFilings.length}건</span></header>
          <div class="filing-list sec">
            ${renderSecFilingItems(data.insiderFilings, secUrl)}
          </div>
        </article>
      ` : ""}
      <article class="intel-card">
        <header class="intel-head"><h3>뉴스 감성분석</h3><span class="status-badge good">${escapeHtml(data.sentiment?.label || "중립")}</span></header>
        <p class="sentiment-count">긍정 ${data.sentiment?.positive || 0} · 중립 ${data.sentiment?.neutral || 0} · 부정 ${data.sentiment?.negative || 0}</p>
        ${sentimentEvidence(data.sentiment)}
        ${sentimentMeter(data.sentiment || { positive: 0, neutral: 1, negative: 0 })}
        <p class="intel-copy">${escapeHtml(data.sentiment?.summary || `${stock.ticker} 인사이트 데이터를 준비 중입니다.`)}</p>
        ${newsList(data.sentiment?.items || [])}
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>애널리스트 목표가</h3><span>${(data.analysts || []).length}건</span></header>
        <div class="analyst-list">
          ${(data.analysts || []).map(([firm, rating, target], index) => `
            <div><span>MAIN</span><strong>${escapeHtml(firm)}</strong><em>${escapeHtml(rating)}</em><b>${escapeHtml(index === 0 && !target ? analystTarget : target || "-")}</b></div>
          `).join("")}
        </div>
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>SEC 공시</h3><a href="${secUrl}" target="_blank" rel="noopener">SEC 전체보기</a></header>
        <div class="filing-list sec">
          ${renderSecFilingItems(data.filings, secUrl)}
        </div>
      </article>
    </section>
  `;
}

function renderKrInsight(stock) {
  const insight = stock.krInsight;
  const data = insight || krInsights;
  const dartSearch = `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(stock.company)}`;
  tabContent.innerHTML = `
    <section class="intel-stack">
      ${renderSourceStatus(stock)}
      <article class="intel-card">
        <header class="intel-head"><h3>뉴스 감성분석</h3><span class="status-badge neutral">${escapeHtml(data.sentiment?.label || "중립")}</span></header>
        <p class="sentiment-count">긍정 ${data.sentiment?.positive || 0} · 중립 ${data.sentiment?.neutral || 0} · 부정 ${data.sentiment?.negative || 0}</p>
        ${sentimentMeter(data.sentiment || { positive: 0, neutral: 1, negative: 0 })}
        <p class="intel-copy">${escapeHtml(data.sentiment?.summary || "국장 뉴스 감성 데이터는 준비 중입니다.")}</p>
        ${newsList(data.sentiment?.items || [])}
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>실적 서프라이즈</h3><span>최근 데이터</span></header>
        ${earningsGrid(data.earnings || [], true)}
      </article>
      <article class="intel-card flush">
        <header class="intel-head compact"><h3>최근 공시</h3><a href="${dartSearch}" target="_blank" rel="noopener">DART 전체보기</a></header>
        <div class="filing-list">
          ${renderKrFilingItems(data.filings, dartSearch)}
        </div>
      </article>
    </section>
  `;
}
function renderTabContent() {
  const stock = getSelectedStock();
  if (selectedTab === "canslim") {
    renderCanslimCards(stock);
    return;
  }
  if (selectedTab === "technical") {
    renderTechnicalRows(stock);
    return;
  }
  if (selectedTab === "finance") {
    renderFinanceRows(stock);
    return;
  }
  if (stock.market === "kr") {
    renderKrInsight(stock);
    return;
  }
  renderUsInsight(stock);
}

function loadPortfolio() {
  try {
    const saved = JSON.parse(localStorage.getItem(PORTFOLIO_STORAGE_KEY) || "{}");
    portfolio = {
      accountSize: Number(saved.accountSize) > 0 ? Number(saved.accountSize) : 10000,
      holdings: Array.isArray(saved.holdings) ? saved.holdings.filter((item) => item?.ticker) : [],
      exchangeRate: Number(saved.exchangeRate) > 0 ? Number(saved.exchangeRate) : null,
      history: Array.isArray(saved.history) ? saved.history.slice(-30) : []
    };
  } catch {
    portfolio = { accountSize: 10000, holdings: [], exchangeRate: null, history: [] };
  }
  const input = document.querySelector("#portfolioEquityInput");
  if (input) input.value = portfolio.accountSize;
}

function savePortfolio() {
  localStorage.setItem(PORTFOLIO_STORAGE_KEY, JSON.stringify(portfolio));
}

function portfolioClientId() {
  let clientId = localStorage.getItem(PORTFOLIO_CLIENT_ID_KEY);
  if (!clientId) {
    const randomPart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    clientId = `local-${randomPart}`;
    localStorage.setItem(PORTFOLIO_CLIENT_ID_KEY, clientId);
  }
  return clientId;
}

function portfolioAccessToken() {
  let token = localStorage.getItem(PORTFOLIO_ACCESS_TOKEN_KEY);
  if (!token) {
    token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(PORTFOLIO_ACCESS_TOKEN_KEY, token);
  }
  return token;
}

function portfolioCloudHeaders(extra = {}) {
  return {
    ...extra,
    "x-portfolio-token": portfolioAccessToken()
  };
}

function setPortfolioCloudStatus(message, status = "warn") {
  const el = document.querySelector("#portfolioCloudStatus");
  if (!el) return;
  el.textContent = message;
  el.dataset.status = status;
}

function portfolioCurrencySymbol(holding, quote) {
  return quote?.market === "kr" || /^\d{6}/.test(holding.ticker) ? "원" : "$";
}

function portfolioMoney(value, holding = {}, quote = {}) {
  if (!Number.isFinite(Number(value))) return "-";
  if (portfolioCurrencySymbol(holding, quote) === "원") return `${Math.round(Number(value)).toLocaleString("ko-KR")}원`;
  return `$${money(value)}`;
}

function portfolioStopState(item) {
  const price = Number(item?.price);
  const stop = Number(item?.stop);
  if (!Number.isFinite(price) || !Number.isFinite(stop) || stop <= 0) {
    return { status: "neutral", label: "손절가 없음", distancePct: null, text: "손절가 계산 데이터가 부족합니다." };
  }
  const distancePct = ((price / stop) - 1) * 100;
  if (price <= stop) {
    return { status: "breached", label: "손절가 이탈", distancePct, text: `현재가가 손절가보다 ${Math.abs(distancePct).toFixed(2)}% 낮습니다.` };
  }
  if (distancePct <= 3) {
    return { status: "near", label: "손절가 3% 이내", distancePct, text: `손절가까지 ${distancePct.toFixed(2)}% 남았습니다.` };
  }
  return { status: "ok", label: "정상 범위", distancePct, text: `손절가까지 ${distancePct.toFixed(2)}% 여유가 있습니다.` };
}

function portfolioStopBasisText(quote) {
  const plan = quote?.tradePlan || {};
  const basis = plan.stopBasis || "ATR/최근 저가";
  const parts = [
    `채택: ${basis}`,
    Number.isFinite(Number(plan.atrStop)) ? `ATR ${portfolioMoney(plan.atrStop, {}, quote)}` : "",
    Number.isFinite(Number(plan.vcpStop)) ? `20일 저가 ${portfolioMoney(plan.vcpStop, {}, quote)}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function krwMoney(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return `${Math.round(Number(value)).toLocaleString("ko-KR")}원`;
}

async function loadExchangeRate({ refresh = false } = {}) {
  const label = document.querySelector("#portfolioFxLabel");
  if (!refresh && Number(portfolio.exchangeRate) > 0) {
    if (label) label.textContent = `USD/KRW ${Number(portfolio.exchangeRate).toLocaleString("ko-KR", { maximumFractionDigits: 2 })} · 저장값`;
    return portfolio.exchangeRate;
  }
  if (!canUseApi) return portfolio.exchangeRate || 1350;
  try {
    const response = await fetch("/api/exchange/usd-krw");
    if (!response.ok) throw new Error(`FX ${response.status}`);
    const payload = await response.json();
    const rate = Number(payload.rate);
    if (rate > 0) {
      portfolio.exchangeRate = rate;
      savePortfolio();
      if (label) label.textContent = `USD/KRW ${rate.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} · ${payload.fallback ? "대체값" : payload.source}`;
    }
    return portfolio.exchangeRate || 1350;
  } catch {
    portfolio.exchangeRate = portfolio.exchangeRate || 1350;
    return portfolio.exchangeRate;
  }
}

function portfolioGroupedMoney(items, field) {
  const totals = new Map();
  items.forEach((item) => {
    const amount = Number(item[field]);
    if (!Number.isFinite(amount)) return;
    const symbol = portfolioCurrencySymbol(item.holding, item.quote);
    totals.set(symbol, (totals.get(symbol) || 0) + amount);
  });
  if (!totals.size) return "-";
  return [...totals.entries()].map(([symbol, value]) => (
    symbol === "원"
      ? `${Math.round(value).toLocaleString("ko-KR")}원`
      : `$${money(value)}`
  )).join(" / ");
}

function portfolioGroupedHeat(items) {
  const totals = new Map();
  items.forEach((item) => {
    const amount = Number(item.openRisk);
    if (!Number.isFinite(amount)) return;
    const symbol = portfolioCurrencySymbol(item.holding, item.quote);
    totals.set(symbol, (totals.get(symbol) || 0) + amount);
  });
  const entries = [...totals.entries()];
  if (!entries.length || !(portfolio.accountSize > 0)) return { label: "-", status: "neutral" };
  const heats = entries.map(([symbol, risk]) => ({
    symbol,
    heat: risk / portfolio.accountSize * 100
  }));
  const maxHeat = Math.max(...heats.map((item) => item.heat));
  return {
    label: heats.map((item) => `${item.symbol === "원" ? "KRW" : "USD"} ${item.heat.toFixed(2)}%`).join(" / "),
    basis: `계좌 기준 ${portfolio.accountSize.toLocaleString("en-US")} · Heat = Open Risk / 계좌금액`,
    status: portfolioHeatStatus(maxHeat)
  };
}

function portfolioKrwTotal(items) {
  const rate = Number(portfolio.exchangeRate) || 1350;
  return items.reduce((sum, item) => {
    const value = Number(item.value);
    if (!Number.isFinite(value)) return sum;
    return sum + (portfolioCurrencySymbol(item.holding, item.quote) === "원" ? value : value * rate);
  }, 0);
}

function portfolioSectorSummary(items) {
  const totals = new Map();
  let totalValue = 0;
  items.forEach((item) => {
    const value = Number(item.value);
    if (!Number.isFinite(value) || value <= 0) return;
    const sector = item.quote?.sector || "미분류";
    totals.set(sector, (totals.get(sector) || 0) + value);
    totalValue += value;
  });
  if (!totalValue || !totals.size) return { label: "-", status: "neutral" };
  const [sector, value] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  const pct = value / totalValue * 100;
  return {
    label: `${sector.replace(/\s*\(.+?\)/g, "")} ${pct.toFixed(1)}%`,
    status: pct >= 45 ? "risk" : pct >= 30 ? "warn" : "good"
  };
}

function portfolioTopRiskSummary(items) {
  const valid = items
    .filter((item) => Number.isFinite(Number(item.openRisk)))
    .sort((a, b) => Number(b.openRisk) - Number(a.openRisk));
  if (!valid.length) return { label: "-", status: "neutral" };
  const top = valid[0];
  const heat = portfolio.accountSize > 0 ? Number(top.openRisk) / portfolio.accountSize * 100 : 0;
  return {
    label: `${top.holding.ticker} ${heat.toFixed(2)}%`,
    status: portfolioHeatStatus(heat)
  };
}

function portfolioChangeSummary(items) {
  const latest = portfolio.history?.at?.(-1);
  if (!latest?.items?.length) return { label: "-", alerts: [] };
  const alerts = [];
  let changed = 0;
  for (const item of items) {
    const prev = latest.items.find((row) => row.ticker === item.holding.ticker);
    if (!prev || !item.quote) continue;
    const scoreDelta = Number(item.quote.score) - Number(prev.score);
    const entryDelta = Number(item.quote.entry) - Number(prev.entry);
    if (Math.abs(scoreDelta) >= 5 || Math.abs(entryDelta) >= 5) {
      changed += 1;
      alerts.push(`${item.holding.ticker}: 점수 ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}, Entry ${entryDelta >= 0 ? "+" : ""}${entryDelta}`);
    }
    const previousSource = prev.trustLabel || prev.dataSource || "";
    const currentSource = item.quote.trust?.label || item.quote.dataSource || "";
    if (previousSource && currentSource && previousSource !== currentSource) {
      alerts.push(`${item.holding.ticker}: 데이터 신뢰도 ${previousSource} → ${currentSource}`);
    }
    const stop = Number(item.stop);
    const price = Number(item.price);
    const stopState = portfolioStopState(item);
    if (stopState.status === "breached") {
      alerts.push(`${item.holding.ticker}: 손절가 이탈`);
    } else if (stopState.status === "near") {
      alerts.push(`${item.holding.ticker}: 손절가 3% 이내 접근`);
    }
    const previousFiling = prev.latestFiling || "";
    const currentFiling = item.quote.usInsight?.filings?.items?.[0]?.form || item.quote.krInsight?.filings?.items?.[0]?.form || "";
    if (previousFiling && currentFiling && previousFiling !== currentFiling) {
      alerts.push(`${item.holding.ticker}: 새 공시 유형 ${currentFiling} 확인`);
    }
  }
  return { label: changed ? `${changed}개 변화` : "변화 없음", alerts };
}

function collectPortfolioAlerts(items) {
  const alerts = [];
  const groupedHeat = portfolioGroupedHeat(items);
  if (groupedHeat.status === "risk") alerts.push({ ticker: null, level: "risk", text: "전체 Heat가 8% 이상입니다. 신규 진입보다 리스크 축소를 먼저 확인하세요." });
  if (groupedHeat.status === "warn") alerts.push({ ticker: null, level: "warn", text: "전체 Heat가 6% 이상입니다. 추가 매수 전 손절폭을 확인하세요." });
  for (const item of items) {
    if (!item.quote) continue;
    const stopState = portfolioStopState(item);
    if (stopState.status === "breached") alerts.push({ ticker: item.holding.ticker, level: "risk", text: `${item.holding.ticker}: 손절가를 이탈했습니다. (${stopState.text})` });
    if (stopState.status === "near") alerts.push({ ticker: item.holding.ticker, level: "warn", text: `${item.holding.ticker}: 손절가 3% 이내입니다. (${stopState.text})` });
    if (Number(item.quote.entry) < 40) alerts.push({ ticker: item.holding.ticker, level: "warn", text: `${item.holding.ticker}: EntryScore가 주의 구간입니다.` });
    if (Number(item.quote.entry) >= 75) alerts.push({ ticker: item.holding.ticker, level: "warn", text: `${item.holding.ticker}: 강하지만 추격 위험 구간입니다.` });
    const filings = item.quote.usInsight?.filings?.items || item.quote.krInsight?.filings?.items || [];
    if (filings.length) alerts.push({ ticker: item.holding.ticker, level: "info", text: `${item.holding.ticker}: 최근 공시 ${filings[0].form || filings[0].title || "확인"} 링크를 확인하세요.` });
    const sentiment = item.quote.usInsight?.sentiment || item.quote.krInsight?.sentiment;
    if (Number(sentiment?.negative) > Number(sentiment?.positive)) alerts.push({ ticker: item.holding.ticker, level: "risk", text: `${item.holding.ticker}: 뉴스 부정 신호가 우세합니다.` });
  }
  const change = portfolioChangeSummary(items);
  alerts.push(...change.alerts.map((text) => ({
    ticker: String(text).split(":")[0],
    level: text.includes("손절") ? "risk" : "info",
    text
  })));
  return { alerts, changeLabel: change.label };
}

function renderPortfolioAlerts(items) {
  const alertEl = document.querySelector("#portfolioAlertList");
  const bannerEl = document.querySelector("#portfolioAlertBanner");
  if (!alertEl) return [];
  const { alerts, changeLabel } = collectPortfolioAlerts(items);
  const changeEl = document.querySelector("#portfolioChangeLabel");
  if (changeEl) {
    changeEl.textContent = changeLabel;
    changeEl.dataset.status = alerts.some((alert) => alert.level === "risk") ? "risk" : alerts.length ? "warn" : "good";
  }
  const bannerText = alerts.length
    ? alerts.slice(0, 2).map((alert) => alert.text).join(" · ")
    : "현재 즉시 조치가 필요한 알림은 없습니다.";
  if (bannerEl) {
    bannerEl.textContent = bannerText;
    bannerEl.dataset.status = alerts.some((alert) => alert.level === "risk") ? "risk" : alerts.length ? "warn" : "good";
  }
  alertEl.innerHTML = alerts.length
    ? alerts.slice(0, 8).map((alert) => `<div class="portfolio-alert ${alert.level}">${escapeHtml(alert.text)}</div>`).join("")
    : `<div class="portfolio-alert good">현재 즉시 조치가 필요한 알림은 없습니다.</div>`;
  return alerts;
}

function renderPortfolioHistory() {
  const chartEl = document.querySelector("#portfolioHistoryChart");
  if (!chartEl) return;
  const snapshots = Array.isArray(portfolio.history) ? portfolio.history.slice(-12) : [];
  const usable = snapshots
    .map((snapshot) => {
      const rows = (snapshot.items || []).filter((item) => Number.isFinite(Number(item.score)) || Number.isFinite(Number(item.entry)));
      if (!rows.length) return null;
      const scoreRows = rows.filter((item) => Number.isFinite(Number(item.score)));
      const entryRows = rows.filter((item) => Number.isFinite(Number(item.entry)));
      const score = scoreRows.length ? scoreRows.reduce((sum, item) => sum + Number(item.score), 0) / scoreRows.length : null;
      const entry = entryRows.length ? entryRows.reduce((sum, item) => sum + Number(item.entry), 0) / entryRows.length : null;
      return { generatedAt: snapshot.generatedAt, score, entry };
    })
    .filter(Boolean);
  if (usable.length < 2) {
    chartEl.innerHTML = `<div class="portfolio-history-empty">재스캔 기록이 2회 이상 쌓이면 변화선이 표시됩니다.</div>`;
    return;
  }
  const width = 560;
  const height = 150;
  const padding = 22;
  const points = usable.map((item, index) => ({
    ...item,
    x: padding + (width - padding * 2) * (usable.length === 1 ? 0 : index / (usable.length - 1)),
    scoreY: padding + (height - padding * 2) * (1 - Math.max(0, Math.min(100, Number(item.score) || 0)) / 100),
    entryY: padding + (height - padding * 2) * (1 - Math.max(0, Math.min(100, Number(item.entry) || 0)) / 100)
  }));
  const polyline = (key) => points
    .filter((point) => Number.isFinite(point[key]))
    .map((point) => `${point.x.toFixed(1)},${point[key].toFixed(1)}`)
    .join(" ");
  const latest = usable.at(-1);
  const first = usable[0];
  const scoreDelta = Number(latest.score) - Number(first.score);
  const entryDelta = Number(latest.entry) - Number(first.entry);
  chartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="포트폴리오 점수 변화">
      <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}"></line>
      <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}"></line>
      <polyline class="score-line" points="${polyline("scoreY")}"></polyline>
      <polyline class="entry-line" points="${polyline("entryY")}"></polyline>
      ${points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.scoreY.toFixed(1)}" r="3"></circle>`).join("")}
    </svg>
    <div class="portfolio-history-meta">
      <span>Total ${Number(latest.score).toFixed(1)} (${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(1)})</span>
      <span>Entry ${Number(latest.entry).toFixed(1)} (${entryDelta >= 0 ? "+" : ""}${entryDelta.toFixed(1)})</span>
    </div>
  `;
}

function fillPortfolioForm(stock, shares = "", avgCost = "") {
  document.querySelector("#portfolioTickerInput").value = stock?.ticker || "";
  document.querySelector("#portfolioSharesInput").value = shares;
  document.querySelector("#portfolioCostInput").value = avgCost || stock?.price || "";
  document.querySelector("#portfolioTickerInput").focus();
  document.querySelector("#portfolio")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"" && quoted && line[i + 1] === "\"") {
      current += "\"";
      i += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function exportPortfolioCsv() {
  const lines = [
    ["accountSize", portfolio.accountSize],
    [],
    ["ticker", "shares", "avgCost"],
    ...portfolio.holdings.map((item) => [item.ticker, item.shares, item.avgCost])
  ].map((row) => row.map(csvEscape).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `portfolio-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportPortfolioJson() {
  const blob = new Blob([JSON.stringify({
    ...portfolio,
    exportedAt: new Date().toISOString(),
    version: 1
  }, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importPortfolioCsv(file) {
  if (!file) return;
  const text = await file.text();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const imported = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (cells[0] === "accountSize") {
      const accountSize = Number(cells[1]);
      if (accountSize > 0) portfolio.accountSize = accountSize;
      continue;
    }
    if (cells[0]?.toLowerCase() === "ticker") continue;
    const [ticker, shares, avgCost] = cells;
    const cleanTicker = String(ticker || "").trim().toUpperCase();
    if (!cleanTicker) continue;
    const cleanShares = Number(shares);
    const cleanCost = Number(avgCost);
    if (Number.isFinite(cleanShares) && cleanShares > 0 && Number.isFinite(cleanCost) && cleanCost >= 0) {
      imported.push({ ticker: cleanTicker, shares: cleanShares, avgCost: cleanCost });
    }
  }
  if (imported.length) portfolio.holdings = imported;
  savePortfolio();
  loadPortfolio();
  await renderPortfolio({ refresh: true });
}

async function importPortfolioJson(file) {
  if (!file) return;
  const payload = JSON.parse(await file.text());
  portfolio = {
    accountSize: Number(payload.accountSize) > 0 ? Number(payload.accountSize) : 10000,
    holdings: Array.isArray(payload.holdings) ? payload.holdings.filter((item) => item?.ticker) : [],
    exchangeRate: Number(payload.exchangeRate) > 0 ? Number(payload.exchangeRate) : null,
    history: Array.isArray(payload.history) ? payload.history.slice(-30) : []
  };
  savePortfolio();
  loadPortfolio();
  await renderPortfolio({ refresh: true });
}

async function savePortfolioCloud() {
  if (!canUseApi) return setPortfolioCloudStatus("서버 연결 후 클라우드 저장을 사용할 수 있습니다.", "risk");
  setPortfolioCloudStatus("Supabase에 포트폴리오를 저장하는 중입니다...", "warn");
  try {
    const response = await fetch("/api/portfolio", {
      method: "PUT",
      headers: portfolioCloudHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ clientId: portfolioClientId(), portfolio })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    setPortfolioCloudStatus(`클라우드 저장 완료 · ${new Date(payload.updatedAt || Date.now()).toLocaleString("ko-KR")}`, "ok");
  } catch (error) {
    setPortfolioCloudStatus(`클라우드 저장 실패 · ${error.message}`, "risk");
  }
}

async function loadPortfolioCloud() {
  if (!canUseApi) return setPortfolioCloudStatus("서버 연결 후 클라우드 불러오기를 사용할 수 있습니다.", "risk");
  setPortfolioCloudStatus("Supabase에서 포트폴리오를 불러오는 중입니다...", "warn");
  try {
    const response = await fetch(`/api/portfolio?clientId=${encodeURIComponent(portfolioClientId())}`, {
      headers: portfolioCloudHeaders()
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (!payload.portfolio) {
      setPortfolioCloudStatus("아직 클라우드에 저장된 포트폴리오가 없습니다.", "warn");
      return;
    }
    portfolio = {
      accountSize: Number(payload.portfolio.accountSize) > 0 ? Number(payload.portfolio.accountSize) : 10000,
      holdings: Array.isArray(payload.portfolio.holdings) ? payload.portfolio.holdings.filter((item) => item?.ticker) : [],
      exchangeRate: Number(payload.portfolio.exchangeRate) > 0 ? Number(payload.portfolio.exchangeRate) : null,
      history: Array.isArray(payload.portfolio.history) ? payload.portfolio.history.slice(-30) : []
    };
    savePortfolio();
    loadPortfolio();
    await renderPortfolio({ refresh: true });
    setPortfolioCloudStatus(`클라우드 불러오기 완료 · ${new Date(payload.updatedAt || Date.now()).toLocaleString("ko-KR")}`, "ok");
  } catch (error) {
    setPortfolioCloudStatus(`클라우드 불러오기 실패 · ${error.message}`, "risk");
  }
}

async function fetchPortfolioQuote(ticker) {
  const normalized = String(ticker || "").trim().toUpperCase();
  if (!normalized) return null;
  if (portfolioQuotes.has(normalized)) return portfolioQuotes.get(normalized);
  const existing = stocks.find((stock) => stock.ticker?.toUpperCase() === normalized || stock.yf_symbol?.toUpperCase() === normalized);
  if (existing && Number.isFinite(Number(existing.price))) {
    portfolioQuotes.set(normalized, existing);
    return existing;
  }
  if (!canUseApi) return existing || null;
  const response = await fetch(`/api/stocks/${encodeURIComponent(normalized)}`);
  if (!response.ok) throw new Error(`quote ${response.status}`);
  const payload = await response.json();
  portfolioQuotes.set(normalized, payload);
  return payload;
}

function portfolioHeatStatus(heat) {
  if (!Number.isFinite(heat)) return "neutral";
  if (heat >= 8) return "risk";
  if (heat >= 6) return "warn";
  return "good";
}

async function renderPortfolio({ refresh = false } = {}) {
  if (refresh) portfolioQuotes.clear();
  const rowsEl = document.querySelector("#portfolioRows");
  if (!rowsEl) return;
  await loadExchangeRate({ refresh });
  document.querySelector("#portfolioEquityLabel").textContent = `$${Math.round(portfolio.accountSize).toLocaleString("en-US")}`;

  if (!portfolio.holdings.length) {
    rowsEl.innerHTML = `<tr><td colspan="11">보유 종목을 추가하면 현재가, 손익, 손절 기준 리스크가 계산됩니다.</td></tr>`;
    document.querySelector("#portfolioValueLabel").textContent = "-";
    document.querySelector("#portfolioRiskLabel").textContent = "-";
    document.querySelector("#portfolioHeatLabel").textContent = "-";
    document.querySelector("#portfolioSectorLabel").textContent = "-";
    document.querySelector("#portfolioTopRiskLabel").textContent = "-";
    document.querySelector("#portfolioKrwValueLabel").textContent = "-";
    document.querySelector("#portfolioChangeLabel").textContent = "-";
    document.querySelector("#portfolioAlertList").textContent = "보유 종목을 재스캔하면 변화 알림이 표시됩니다.";
    const bannerEl = document.querySelector("#portfolioAlertBanner");
    if (bannerEl) {
      bannerEl.textContent = "보유 종목을 추가하면 핵심 리스크가 여기에 표시됩니다.";
      bannerEl.dataset.status = "neutral";
    }
    renderPortfolioHistory();
    return;
  }

  rowsEl.innerHTML = `<tr><td colspan="11">포트폴리오 가격과 리스크를 계산하는 중입니다...</td></tr>`;
  const enriched = await Promise.all(portfolio.holdings.map(async (holding) => {
    try {
      const quote = await fetchPortfolioQuote(holding.ticker);
      const price = Number(quote?.price);
      const shares = Number(holding.shares);
      const avgCost = Number(holding.avgCost);
      const value = price * shares;
      const cost = avgCost * shares;
      const pnl = value - cost;
      const stop = Number(quote?.tradePlan?.stop);
      const openRisk = Number.isFinite(stop) && price > stop ? (price - stop) * shares : 0;
      const heat = portfolio.accountSize > 0 ? openRisk / portfolio.accountSize * 100 : 0;
      return { holding, quote, price, shares, avgCost, value, pnl, stop, openRisk, heat, error: null };
    } catch (error) {
      return { holding, quote: null, error };
    }
  }));

  document.querySelector("#portfolioValueLabel").textContent = portfolioGroupedMoney(enriched, "value");
  document.querySelector("#portfolioRiskLabel").textContent = portfolioGroupedMoney(enriched, "openRisk");
  const groupedHeat = portfolioGroupedHeat(enriched);
  const heatEl = document.querySelector("#portfolioHeatLabel");
  heatEl.textContent = groupedHeat.label;
  heatEl.dataset.status = groupedHeat.status;
  const heatBasisEl = document.querySelector("#portfolioHeatBasisLabel");
  if (heatBasisEl) heatBasisEl.textContent = groupedHeat.basis || "Heat = Open Risk / 계좌금액";
  const sectorSummary = portfolioSectorSummary(enriched);
  const sectorEl = document.querySelector("#portfolioSectorLabel");
  sectorEl.textContent = sectorSummary.label;
  sectorEl.dataset.status = sectorSummary.status;
  const topRisk = portfolioTopRiskSummary(enriched);
  const topRiskEl = document.querySelector("#portfolioTopRiskLabel");
  topRiskEl.textContent = topRisk.label;
  topRiskEl.dataset.status = topRisk.status;
  document.querySelector("#portfolioKrwValueLabel").textContent = krwMoney(portfolioKrwTotal(enriched));
  const alerts = renderPortfolioAlerts(enriched);
  renderPortfolioHistory();

  rowsEl.innerHTML = enriched.map((item) => {
    const ticker = escapeHtml(item.holding.ticker);
    const itemAlerts = alerts.filter((alert) => alert.ticker === item.holding.ticker);
    const alertCell = itemAlerts.length
      ? `<div class="portfolio-alert-stack">${itemAlerts.slice(0, 2).map((alert) => `<span class="portfolio-row-alert ${alert.level}">${escapeHtml(alert.text.replace(`${item.holding.ticker}: `, ""))}</span>`).join("")}</div>`
      : `<span class="portfolio-row-alert good">정상</span>`;
    if (item.error || !item.quote) {
      return `
        <tr data-ticker="${ticker}">
          <td><strong>${ticker}</strong><small>데이터 없음</small></td>
          <td>${money(item.holding.shares)}</td>
          <td>${money(item.holding.avgCost)}</td>
          <td colspan="6">가격 데이터를 불러오지 못했습니다.</td>
          <td class="portfolio-alert-cell"><span class="portfolio-row-alert risk">데이터 오류</span></td>
          <td class="portfolio-actions">
            <button class="portfolio-edit" data-ticker="${ticker}" type="button">수정</button>
            <button class="portfolio-remove" data-ticker="${ticker}" type="button">삭제</button>
          </td>
        </tr>
      `;
    }
    const status = portfolioHeatStatus(item.heat);
    const stopState = portfolioStopState(item);
    const stopBasis = portfolioStopBasisText(item.quote);
    const pnlClass = item.pnl >= 0 ? "up" : "down";
    return `
      <tr data-ticker="${ticker}">
        <td><strong>${escapeHtml(item.quote.company || item.holding.ticker)}</strong><small>${ticker}</small></td>
        <td>${money(item.shares)}</td>
        <td>${portfolioMoney(item.avgCost, item.holding, item.quote)}</td>
        <td>${portfolioMoney(item.price, item.holding, item.quote)}</td>
        <td>${portfolioMoney(item.value, item.holding, item.quote)}</td>
        <td class="${pnlClass}">${portfolioMoney(item.pnl, item.holding, item.quote)}</td>
        <td class="portfolio-stop-cell">
          <strong>${portfolioMoney(item.stop, item.holding, item.quote)}</strong>
          <small class="${stopState.status}">${escapeHtml(stopState.label)} · ${escapeHtml(stopState.text)}</small>
          <em>${escapeHtml(stopBasis)}</em>
        </td>
        <td class="down">
          ${portfolioMoney(item.openRisk, item.holding, item.quote)}
          <small>(${portfolioMoney(item.price - item.stop, item.holding, item.quote)} × ${money(item.shares)}주)</small>
        </td>
        <td><span class="portfolio-heat ${status}">${item.heat.toFixed(2)}%</span><small>계좌 ${money(portfolio.accountSize)} 기준</small></td>
        <td class="portfolio-alert-cell">${alertCell}</td>
        <td class="portfolio-actions">
          <button class="portfolio-edit" data-ticker="${ticker}" type="button">수정</button>
          <button class="portfolio-remove" data-ticker="${ticker}" type="button">삭제</button>
        </td>
      </tr>
    `;
  }).join("");
}

async function rescanPortfolio() {
  if (!portfolio.holdings.length) return renderPortfolio({ refresh: true });
  await renderPortfolio({ refresh: true });
  const snapshotItems = portfolio.holdings.map((holding) => {
    const quote = portfolioQuotes.get(holding.ticker);
    return {
      ticker: holding.ticker,
      price: quote?.price ?? null,
      score: quote?.score ?? null,
      entry: quote?.entry ?? null,
      stop: quote?.tradePlan?.stop ?? null,
      trustLabel: quote?.trust?.label || null,
      dataSource: quote?.dataSource || null,
      latestFiling: quote?.usInsight?.filings?.items?.[0]?.form || quote?.krInsight?.filings?.items?.[0]?.form || null,
      negativeNews: quote?.usInsight?.sentiment?.negative ?? quote?.krInsight?.sentiment?.negative ?? null,
      generatedAt: new Date().toISOString()
    };
  });
  portfolio.history = [...(portfolio.history || []), { generatedAt: new Date().toISOString(), items: snapshotItems }].slice(-30);
  savePortfolio();
  renderPortfolioHistory();
}

function upsertPortfolioHolding({ ticker, shares, avgCost }) {
  const normalized = String(ticker || "").trim().toUpperCase();
  const cleanShares = Number(shares);
  const cleanCost = Number(avgCost);
  if (!normalized || !Number.isFinite(cleanShares) || cleanShares <= 0 || !Number.isFinite(cleanCost) || cleanCost < 0) {
    return false;
  }
  const existing = portfolio.holdings.find((item) => item.ticker === normalized);
  if (existing) {
    existing.shares = cleanShares;
    existing.avgCost = cleanCost;
  } else {
    portfolio.holdings.push({ ticker: normalized, shares: cleanShares, avgCost: cleanCost });
  }
  savePortfolio();
  return true;
}

async function rescan() {
  const button = document.querySelector("#scanButton");
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "스캔 중";
  await loadStocks({ sampleDrift: true });
  recordScanHistory(visibleStocks());
  renderMarketChips();
  renderRows();
  await loadCacheStatus();
  button.textContent = apiMode ? "완료" : "샘플 완료";
  setTimeout(() => {
    button.disabled = false;
    button.textContent = oldText;
  }, 900);
}

async function runBacktest() {
  const backtestRows = document.querySelector("#backtestRows");
  backtestRows.innerHTML = `<tr><td colspan="8">백테스트를 계산하는 중입니다...</td></tr>`;
  try {
    const response = await fetch(`/api/backtest?market=${activeMarket}&limit=60&mode=long&years=5&step=5&horizon=10&mdd=20`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    const rows = payload.results || [];
    if (!rows.length) {
      backtestRows.innerHTML = `<tr><td colspan="8">${escapeHtml(payload.message || "백테스트 결과가 아직 없습니다.")}</td></tr>`;
      return;
    }
    const pct = (value) => value === null || value === undefined || Number.isNaN(Number(value)) ? "-" : `${value}%`;
    const totalSamples = rows.reduce((sum, row) => sum + Number(row.samples || 0), 0);
    const entryRows = payload.entryBuckets || [];
    const entrySamples = entryRows.reduce((sum, row) => sum + Number(row.samples || 0), 0);
    const statusText = {
      ok: "실제 계산 완료",
      partial: "일부 제외 후 실제 계산",
      no_samples: "샘플 없음",
      not_ready: "데이터 준비 중"
    }[payload.status] || payload.status || "상태 미확인";
    const calibration = payload.entryCalibration;
    const reliability = payload.backtestReliability || {};
    const coverage = payload.coverage || {};
    const params = payload.params || {};
    const testedText = `${params.mode || "recent"} · ${params.years || 5}년 · +${params.horizon || 10}일 수익률 · ${params.mddHorizon || 20}일 MDD`;
    const samplePass = reliability.meetsSampleRule ? "표본 기준 통과" : "표본 누적 필요";
    const interpretation = calibration
      ? `${calibration.recommendedBand} 구간이 현재 샘플에서 우선 관찰 대상입니다. 샘플 ${calibration.samples}개, edge ${pct(calibration.edge)}, 승률 ${pct(calibration.winRate)}입니다.`
      : "아직 추천 구간을 산출할 만큼 샘플이 충분하지 않습니다.";
    const calibrationHtml = calibration ? `
      <tr class="backtest-calibration-row">
        <td colspan="8">
          <strong>현재 추천 구간: ${escapeHtml(calibration.recommendedBand)}</strong>
          <span>샘플 ${calibration.samples}개 · edge ${pct(calibration.edge)} · 승률 ${pct(calibration.winRate)} · 신뢰도 ${escapeHtml(calibration.confidence)}</span>
          <small>${escapeHtml(calibration.note || "백테스트 결과를 계속 누적해 검증합니다.")}</small>
        </td>
      </tr>
    ` : "";
    const historyRows = (payload.backtestHistory || []).slice(0, 3);
    const historyHtml = historyRows.length ? `
      <tr class="backtest-history-row">
        <td colspan="8">
          <strong>누적 검증 기록 ${historyRows.length}회</strong>
          ${historyRows.map((item) => `
            <span>${escapeHtml(new Date(item.generatedAt).toLocaleString("ko-KR"))} · ${escapeHtml(item.recommendedBand || "-")} · edge ${pct(item.recommendedEdge)} · 평가시점 ${escapeHtml(String(item.coverage?.evaluatedPoints || 0))}</span>
          `).join("")}
        </td>
      </tr>
    ` : "";
    const strategyHtml = rows.map((row) => `
      <tr>
        <td>${row.name === "V4_HYBRID" ? "★ " : ""}${escapeHtml(row.name)}</td>
        <td>${row.high}/${row.low}</td>
        <td>${row.samples}</td>
        <td>${pct(row.green_ratio)}</td>
        <td>${pct(row.green_return_10d)}</td>
        <td>${pct(row.edge)}</td>
        <td>${pct(row.win_rate)}</td>
        <td>${pct(row.mdd_20d)}</td>
      </tr>
    `).join("");
    const entryHtml = entryRows.map((row) => `
      <tr class="entry-bucket-row">
        <td>${escapeHtml(row.name)}</td>
        <td>${row.high}/${row.low}</td>
        <td>${row.samples}</td>
        <td>${pct(row.green_ratio)}</td>
        <td>${pct(row.green_return_10d)}</td>
        <td>${pct(row.edge)}</td>
        <td>${pct(row.win_rate)}</td>
        <td>${pct(row.mdd_20d)}</td>
      </tr>
    `).join("");
    backtestRows.innerHTML = `
      <tr class="backtest-summary-row"><td colspan="8">
        <strong>${escapeHtml(statusText)}</strong>
        <span>${escapeHtml(testedText)} · 평가시점 ${escapeHtml(String(coverage.evaluatedPoints || 0))}개 · 로드 ${escapeHtml(String(coverage.loaded || 0))}/${escapeHtml(String(coverage.requested || 0))}종목</span>
        <small>${escapeHtml(interpretation)}</small>
        <small>검증 신뢰도 ${escapeHtml(reliability.label || "확인중")} · ${escapeHtml(samplePass)} · ${escapeHtml(reliability.sampleRule || "샘플 기준 확인 필요")} · ${escapeHtml(reliability.caveat || "")}</small>
      </td></tr>
      ${calibrationHtml}
      ${historyHtml}
      <tr class="backtest-section-row"><td colspan="8">전략 후보 검증</td></tr>
      ${strategyHtml || `<tr><td colspan="8">전략 조건에 맞는 샘플이 아직 없습니다.</td></tr>`}
      <tr class="backtest-section-row"><td colspan="8">EntryScore 구간별 검증</td></tr>
      ${entryHtml || `<tr><td colspan="8">EntryScore 구간 샘플이 아직 없습니다.</td></tr>`}
    `;
    if (payload.errors && payload.errors.length) {
      backtestRows.innerHTML += `<tr><td colspan="8">일부 종목 제외: ${payload.errors.length}개</td></tr>`;
    }
  } catch (error) {
    backtestRows.innerHTML = `<tr><td colspan="8">백테스트 결과를 불러오지 못했습니다. 서버 상태를 확인해 주세요.</td></tr>`;
  }
}

stockRows.addEventListener("click", (event) => {
  const watchButton = event.target.closest(".row-watch-toggle");
  if (watchButton) {
    toggleWatchlist(watchButton.dataset.ticker);
    return;
  }

  const portfolioButton = event.target.closest(".row-portfolio-add");
  if (portfolioButton) {
    const stock = stocks.find((item) => item.ticker === portfolioButton.dataset.ticker);
    if (stock) fillPortfolioForm(stock);
    return;
  }
  if (event.target.closest("input, button, a")) return;
  const row = event.target.closest("tr[data-ticker]");
  if (row) openStock(row.dataset.ticker);
});

document.querySelector(".tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  selectedTab = button.dataset.tab;
  renderTabs();
  renderTabContent();
});

tabContent.addEventListener("click", (event) => {
  const button = event.target.closest(".factor-toggle");
  if (!button) return;
  const card = button.closest(".factor-card");
  const detail = card?.querySelector(".factor-detail");
  if (!card || !detail) return;
  const open = detail.classList.toggle("hidden");
  button.setAttribute("aria-expanded", String(!open));
  button.textContent = open ? "⌄" : "⌃";
  card.classList.toggle("expanded", !open);
});

searchInput.addEventListener("input", renderRows);
closeModal.addEventListener("click", closeStock);
ensureClearScannedButton();
document.querySelector("#scanButton").addEventListener("click", rescan);
document.querySelector("#clearScannedButton")?.addEventListener("click", clearScannedStocks);
document.querySelector("#backtestButton").addEventListener("click", runBacktest);
document.querySelector("#rescanPortfolioButton")?.addEventListener("click", rescanPortfolio);
document.querySelector("#refreshPortfolioButton")?.addEventListener("click", () => renderPortfolio({ refresh: true }));
document.querySelector("#exportPortfolioButton")?.addEventListener("click", exportPortfolioCsv);
document.querySelector("#importPortfolioButton")?.addEventListener("click", () => document.querySelector("#portfolioImportInput")?.click());
document.querySelector("#portfolioImportInput")?.addEventListener("change", async (event) => {
  await importPortfolioCsv(event.target.files?.[0]);
  event.target.value = "";
});
document.querySelector("#exportPortfolioJsonButton")?.addEventListener("click", exportPortfolioJson);
document.querySelector("#importPortfolioJsonButton")?.addEventListener("click", () => document.querySelector("#portfolioJsonImportInput")?.click());
document.querySelector("#portfolioJsonImportInput")?.addEventListener("change", async (event) => {
  await importPortfolioJson(event.target.files?.[0]);
  event.target.value = "";
});
document.querySelector("#savePortfolioCloudButton")?.addEventListener("click", savePortfolioCloud);
document.querySelector("#loadPortfolioCloudButton")?.addEventListener("click", loadPortfolioCloud);
document.querySelector("#addPortfolioFromModal")?.addEventListener("click", () => {
  const stock = getSelectedStock();
  if (stock) fillPortfolioForm(stock);
});
document.querySelector("#watchButton")?.addEventListener("click", () => {
  const stock = getSelectedStock();
  if (stock) toggleWatchlist(stock.ticker);
});

document.querySelector("#portfolioForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  portfolio.accountSize = Number(document.querySelector("#portfolioEquityInput").value) || portfolio.accountSize;
  const ok = upsertPortfolioHolding({
    ticker: document.querySelector("#portfolioTickerInput").value,
    shares: document.querySelector("#portfolioSharesInput").value,
    avgCost: document.querySelector("#portfolioCostInput").value
  });
  savePortfolio();
  if (ok) {
    document.querySelector("#portfolioTickerInput").value = "";
    document.querySelector("#portfolioSharesInput").value = "";
    document.querySelector("#portfolioCostInput").value = "";
  }
  await renderPortfolio({ refresh: true });
});

document.querySelector("#portfolioRows")?.addEventListener("click", async (event) => {
  const editButton = event.target.closest(".portfolio-edit");
  if (editButton) {
    const ticker = editButton.dataset.ticker;
    const holding = portfolio.holdings.find((item) => item.ticker === ticker);
    if (!holding) return;
    document.querySelector("#portfolioTickerInput").value = holding.ticker;
    document.querySelector("#portfolioSharesInput").value = holding.shares;
    document.querySelector("#portfolioCostInput").value = holding.avgCost;
    document.querySelector("#portfolioTickerInput").focus();
    return;
  }

  const button = event.target.closest(".portfolio-remove");
  if (button) {
    const ticker = button.dataset.ticker;
    portfolio.holdings = portfolio.holdings.filter((item) => item.ticker !== ticker);
    savePortfolio();
    await renderPortfolio();
    return;
  }

  if (event.target.closest("input, button, a")) return;
  const row = event.target.closest("tr[data-ticker]");
  if (row) await openPortfolioStock(row.dataset.ticker);
});

document.querySelector(".market-switch").addEventListener("click", async (event) => {
  const portfolioButton = event.target.closest("button[data-view='portfolio']");
  if (portfolioButton) {
    setActiveView("portfolio");
    return;
  }
  const button = event.target.closest("button[data-market]");
  if (!button) return;
  activeMarket = button.dataset.market;
  setActiveView("scanner");
  activeSector = "all";
  await loadStocks();
});

document.querySelector(".quick-filters").addEventListener("click", async (event) => {
  const filterButton = event.target.closest("button[data-filter]");
  if (filterButton) {
    activeQuickFilter = filterButton.dataset.filter || "all";
    renderMarketChips();
    renderRows();
    return;
  }

  const button = event.target.closest("button[data-market]");
  if (!button) return;
  activeMarket = button.dataset.market;
  activeSector = "all";
  document.querySelectorAll(".market-switch button").forEach((item) => {
    item.classList.toggle("active", false);
  });
  document.querySelectorAll(".quick-filters button").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  await loadStocks();
});

sectorRail.addEventListener("click", (event) => {
  const quickAdd = event.target.closest("button[data-watch-ticker]");
  if (quickAdd) {
    addWatchlistTickers(quickAdd.dataset.watchTicker);
    return;
  }
  const auditRow = event.target.closest(".watchlist-audit-row[data-ticker]");
  if (auditRow) {
    openStock(auditRow.dataset.ticker);
    return;
  }
  const button = event.target.closest("button[data-sector]");
  if (!button) return;
  activeSector = button.dataset.sector;
  renderMarketChips();
  renderRows();
});

sectorRail.addEventListener("submit", async (event) => {
  const form = event.target.closest("#watchlistAddForm");
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector("#watchlistTickerInput");
  const value = input?.value || "";
  if (input) input.value = "";
  await addWatchlistTickers(value);
});

modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeStock();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeStock();
});

loadWatchlist();
loadScanHistory();
hydrateStaticTermHelp();
loadPortfolio();
loadCloudWatchlist()
  .then(() => loadStocks())
  .then(() => {
    renderPortfolio();
    refreshWatchlistReliability();
  });
loadCacheStatus();
fetchEnrichmentStatus();









