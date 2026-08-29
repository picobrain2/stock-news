import { classifyTone } from "./impact";
import { bundledMarket, bundledQuotes, bundledStocks, bundleFetchedAt, fetchMarket, fetchQuotes, fetchStockNews, searchRemote } from "./api";
import { loadArchive, saveArchive } from "./archive";
import { findStock, popularStocks, searchCatalog, typedStock } from "./catalog";
import { formatPct, formatPrice, fromNow, isFresh, marketStatus } from "./time";
import type { NewsItem, Quote, SearchHit, Stock, Tab } from "./types";
import { loadWatchlist, saveWatchlist } from "./watchlist";

const app = document.querySelector<HTMLDivElement>("#app")!;
const boot = loadArchive();

let tab: Tab = "market";
let watchlist = loadWatchlist();
let quotes = new Map((boot.quotes.length ? boot.quotes : bundledQuotes()).map((q) => [q.symbol, q]));
let marketNews: NewsItem[] = boot.market.length ? boot.market : bundledMarket();
let stockNews: NewsItem[] = boot.stocks.length ? boot.stocks : bundledStocks();
let filterId = "all";
let regionFilter: "all" | "kr" | "us" = "all";
let search = "";
let suggestions: SearchHit[] = [];
let loadingMarket = marketNews.length === 0;
let loadingMine = stockNews.length === 0;
let error = "";
let lastFetch = boot.fetchedAt;
let searchTimer = 0;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch
  ));
}

function stockById(id: string): Stock | undefined {
  return watchlist.find((s) => s.id === id) ?? findStock(id);
}

function quoteFor(stock: Stock): Quote | undefined {
  return quotes.get(stock.yahoo);
}

function visibleNews(): NewsItem[] {
  const source = tab === "market" ? marketNews : stockNews;
  return source.filter((item) => {
    if (regionFilter !== "all" && item.region !== regionFilter && item.region !== "global") return false;
    if (tab === "mine" && filterId !== "all" && !item.stockIds.includes(filterId)) return false;
    return true;
  });
}

function splitFeed(items: NewsItem[]): { spotlight: NewsItem[]; rest: NewsItem[] } {
  const now = Date.now();
  const spotlight = items.filter((n) => n.impact >= 24 && now - n.publishedAt < 12 * 3_600_000);
  const ids = new Set(spotlight.map((n) => n.id));
  return { spotlight, rest: items.filter((n) => !ids.has(n.id)) };
}

function addStock(hit: SearchHit | Stock): void {
  if (watchlist.some((s) => s.id === hit.id || s.yahoo === hit.yahoo)) return;
  const known = findStock(hit.id);
  const stock: Stock = known ?? {
    id: hit.id,
    name: hit.name,
    nameEn: hit.nameEn || hit.name,
    aliases: [],
    yahoo: hit.yahoo,
    market: hit.market,
    popular: false,
  };
  watchlist = [stock, ...watchlist].slice(0, 16);
  saveWatchlist(watchlist);
  search = "";
  suggestions = [];
  tab = "mine";
  filterId = stock.id;
  void refreshMine();
  void refreshQuotes();
  paint();
}

function removeStock(id: string): void {
  watchlist = watchlist.filter((s) => s.id !== id);
  saveWatchlist(watchlist);
  if (filterId === id) filterId = "all";
  void refreshMine();
  paint();
}

async function persist(): Promise<void> {
  saveArchive({
    market: marketNews,
    stocks: stockNews,
    quotes: [...quotes.values()],
    fetchedAt: bundleFetchedAt || lastFetch || Date.now(),
  });
}

async function refreshAll(): Promise<void> {
  error = "";
  await Promise.all([refreshMarket(), refreshMine(), refreshQuotes()]);
  lastFetch = bundleFetchedAt || Date.now();
  await persist();
  paint();
}

async function refreshMarket(): Promise<void> {
  loadingMarket = true;
  paint();
  try {
    marketNews = await fetchMarket(marketNews);
  } catch (err) {
    error = err instanceof Error ? err.message : "뉴스를 불러오지 못했습니다.";
  } finally {
    loadingMarket = false;
    paint();
  }
}

async function refreshMine(): Promise<void> {
  if (watchlist.length === 0) {
    stockNews = [];
    loadingMine = false;
    paint();
    return;
  }
  loadingMine = true;
  paint();
  try {
    stockNews = await fetchStockNews(watchlist, stockNews);
  } catch (err) {
    error = err instanceof Error ? err.message : "종목 뉴스를 불러오지 못했습니다.";
  } finally {
    loadingMine = false;
    paint();
  }
}

async function refreshQuotes(): Promise<void> {
  try {
    const rows = await fetchQuotes(watchlist, [...quotes.values()]);
    quotes = new Map(rows.map((q) => [q.symbol, q]));
    paint();
  } catch {
    /* quotes are optional */
  }
}

async function onSearchInput(value: string): Promise<void> {
  search = value;
  window.clearTimeout(searchTimer);
  const local = searchCatalog(value);
  const typed = typedStock(value);
  suggestions = [
    ...(typed ? [typed] : []),
    ...local,
  ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i).slice(0, 8);
  paint();
  if (value.trim().length < 2) return;
  searchTimer = window.setTimeout(async () => {
    try {
      const remote = await searchRemote(value);
      const seen = new Set(suggestions.map((s) => s.id));
      for (const hit of remote) {
        if (!seen.has(hit.id)) {
          suggestions.push(hit);
          seen.add(hit.id);
        }
      }
      suggestions = suggestions.slice(0, 10);
      paint();
    } catch {
      /* local results are enough */
    }
  }, 220);
}

function newsCard(item: NewsItem): string {
  const stocks = item.stockIds
    .map(stockById)
    .filter((s): s is Stock => Boolean(s))
    .slice(0, 3);
  const focus = tab === "mine" && filterId !== "all"
    ? stocks.filter((s) => s.id === filterId)
    : stocks;
  const names = focus.flatMap((s) => [s.name, s.nameEn, s.id, ...s.aliases]);
  const call = names.length || tab === "mine"
    ? classifyTone(item.title, item.snippet, names)
    : classifyTone(item.title, item.snippet);
  const toneLabel = tab === "mine" && filterId !== "all" && focus[0]
    ? `${focus[0].name} ${call.label}`
    : call.label;
  const fresh = isFresh(item.publishedAt) ? " fresh" : "";
  const impact = item.impact >= 28 ? "high" : item.impact >= 16 ? "mid" : "";
  const showTone = tab === "mine" || call.tone !== "mixed";
  return `
    <a class="card${fresh} tone-${call.tone}" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">
      <div class="card-meta">
        ${showTone ? `<span class="tone ${call.tone}">${esc(toneLabel)}</span>` : ""}
        <span class="when">${esc(fromNow(item.publishedAt))}</span>
        <span class="dot">·</span>
        <span class="src">${esc(item.source)}</span>
        <span class="region">${item.region === "kr" ? "한국" : item.region === "us" ? "미국" : "글로벌"}</span>
        ${impact ? `<span class="impact ${impact}">영향 ${impact === "high" ? "큼" : "있음"}</span>` : ""}
      </div>
      <h3>${esc(item.title)}</h3>
      ${item.snippet ? `<p>${esc(item.snippet)}</p>` : ""}
      <div class="card-tags">
        ${item.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        ${stocks.map((s) => `<span class="tag stock">${esc(s.name)}</span>`).join("")}
      </div>
    </a>
  `;
}

function watchRow(stock: Stock): string {
  const q = quoteFor(stock);
  const active = tab === "mine" && filterId === stock.id ? " active" : "";
  return `
    <div class="watch${active}" data-open="${esc(stock.id)}">
      <div class="watch-main">
        <div class="watch-name">${esc(stock.name)}</div>
        <div class="watch-id">${esc(stock.id)} · ${stock.market === "kr" ? "한국" : "미국"}</div>
      </div>
      <div class="watch-px">
        ${q ? `
          <div class="px">${esc(formatPrice(q.price, q.currency))}</div>
          <div class="${q.changePct > 0 ? "up" : q.changePct < 0 ? "down" : "muted"}">${esc(formatPct(q.changePct))}</div>
        ` : `<div class="muted">시세 대기</div>`}
      </div>
      <button class="icon-btn" data-remove="${esc(stock.id)}" title="빼기" aria-label="${esc(stock.name)} 빼기">×</button>
    </div>
  `;
}

function paint(): void {
  const active = document.activeElement;
  const keepSearch = active?.id === "q" && active instanceof HTMLInputElement;
  const selStart = keepSearch ? active.selectionStart : null;
  const selEnd = keepSearch ? active.selectionEnd : null;
  const status = marketStatus();
  const loading = tab === "market" ? loadingMarket : loadingMine;
  const news = visibleNews();
  const { spotlight, rest } = splitFeed(news);
  const pop = popularStocks().filter((s) => !watchlist.some((w) => w.id === s.id)).slice(0, 10);

  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        <button class="brand" data-home>
          <span class="logo">시황</span>
          <span class="tagline">시장을 움직이는 뉴스</span>
        </button>
        <div class="status-row">
          <span class="pill">${esc(status.kr)}</span>
          <span class="pill">${esc(status.us)}</span>
        </div>
        <label class="search-wrap">
          <span class="sr">종목 검색</span>
          <input id="q" type="search" placeholder="종목명, 티커, 종목코드" value="${esc(search)}" autocomplete="off" />
        </label>
        ${suggestions.length ? `
          <div class="suggest">
            ${suggestions.map((s) => `
              <button class="suggest-item" data-add="${esc(s.id)}" data-yahoo="${esc(s.yahoo)}" data-name="${esc(s.name)}" data-nameen="${esc(s.nameEn)}" data-market="${s.market}">
                <strong>${esc(s.name)}</strong>
                <span>${esc(s.id)} · ${s.market === "kr" ? "한국" : "미국"}</span>
              </button>
            `).join("")}
          </div>
        ` : ""}
        <div class="side-head">
          <h2>관심종목</h2>
          <span>${watchlist.length}</span>
        </div>
        <div class="watchlist">
          ${watchlist.length ? watchlist.map(watchRow).join("") : `<div class="empty-side">위에서 종목을 검색해 추가하세요.</div>`}
        </div>
        ${pop.length ? `
          <div class="side-head"><h2>인기 종목</h2></div>
          <div class="chips">
            ${pop.map((s) => `<button class="chip" data-add="${esc(s.id)}" data-yahoo="${esc(s.yahoo)}" data-name="${esc(s.name)}" data-nameen="${esc(s.nameEn)}" data-market="${s.market}">${esc(s.name)}</button>`).join("")}
          </div>
        ` : ""}
      </aside>
      <main class="main">
        <header class="top">
          <div class="tabs">
            <button class="tab${tab === "market" ? " on" : ""}" data-tab="market">시장 속보</button>
            <button class="tab${tab === "mine" ? " on" : ""}" data-tab="mine">내 종목</button>
          </div>
          <div class="top-actions">
            <div class="seg">
              <button class="seg-btn${regionFilter === "all" ? " on" : ""}" data-region="all">전체</button>
              <button class="seg-btn${regionFilter === "kr" ? " on" : ""}" data-region="kr">한국</button>
              <button class="seg-btn${regionFilter === "us" ? " on" : ""}" data-region="us">미국</button>
            </div>
            <button class="ghost" data-refresh>${loading ? "불러오는 중" : "새로고침"}</button>
          </div>
        </header>
        ${tab === "mine" ? `
          <div class="filters">
            <button class="chip${filterId === "all" ? " on" : ""}" data-filter="all">전체</button>
            ${watchlist.map((s) => `<button class="chip${filterId === s.id ? " on" : ""}" data-filter="${esc(s.id)}">${esc(s.name)}</button>`).join("")}
          </div>
        ` : `<p class="lead">금리 · 환율 · 실적 · 지정학처럼 증시에 바로 닿을 수 있는 소식만 모아 두었습니다.</p>`}
        ${error ? `<div class="banner">${esc(error)}</div>` : ""}
        <section class="feed">
          ${loading && news.length === 0 ? skeleton() : ""}
          ${!loading && news.length === 0 ? emptyState() : ""}
          ${spotlight.length ? `<h2 class="feed-label">지금 주목</h2>${spotlight.map(newsCard).join("")}` : ""}
          ${rest.length ? `${spotlight.length ? `<h2 class="feed-label">최신</h2>` : ""}${rest.map(newsCard).join("")}` : ""}
        </section>
        <footer class="foot">
          ${lastFetch ? `뉴스 수집 ${esc(fromNow(lastFetch))}` : ""} · 하루치 보관 · 새 소식만 추가
        </footer>
      </main>
    </div>
  `;

  if (keepSearch) {
    const input = app.querySelector<HTMLInputElement>("#q");
    input?.focus();
    if (input && selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd);
  }
}

function skeleton(): string {
  return Array.from({ length: 6 }, () => `<div class="card sk"><div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w70"></div></div>`).join("");
}

function emptyState(): string {
  if (tab === "mine" && watchlist.length === 0) {
    return `<div class="empty">관심종목을 추가하면 그 종목 뉴스만 모아 보여 줍니다.</div>`;
  }
  if (tab === "mine") {
    return `<div class="empty">이 종목과 연결된 최근 뉴스가 없습니다. 다른 종목을 고르거나 조금 뒤 다시 새로고침해 보세요.</div>`;
  }
  return `<div class="empty">시장 뉴스를 아직 못 받았습니다.<br>사이트는 약 10분마다 새 소식을 모읍니다. 잠시 뒤 새로고침해 보세요.</div>`;
}

function hitFromButton(btn: HTMLElement): SearchHit | undefined {
  const id = btn.dataset.add;
  const yahoo = btn.dataset.yahoo;
  const name = btn.dataset.name;
  const market = btn.dataset.market;
  if (!id || !yahoo || !name || (market !== "kr" && market !== "us")) return undefined;
  return {
    id,
    yahoo,
    name,
    nameEn: btn.dataset.nameen || name,
    market,
  };
}

function bind(): void {
  app.addEventListener("click", (event) => {
    const t = event.target as HTMLElement;
    const home = t.closest<HTMLElement>("[data-home]");
    if (home) {
      tab = "market";
      filterId = "all";
      paint();
      return;
    }
    const tabBtn = t.closest<HTMLElement>("[data-tab]");
    if (tabBtn?.dataset.tab === "market" || tabBtn?.dataset.tab === "mine") {
      tab = tabBtn.dataset.tab;
      if (tab === "market") filterId = "all";
      paint();
      return;
    }
    const regionBtn = t.closest<HTMLElement>("[data-region]");
    if (regionBtn?.dataset.region === "all" || regionBtn?.dataset.region === "kr" || regionBtn?.dataset.region === "us") {
      regionFilter = regionBtn.dataset.region;
      paint();
      return;
    }
    const refresh = t.closest<HTMLElement>("[data-refresh]");
    if (refresh) {
      void refreshAll();
      return;
    }
    const addBtn = t.closest<HTMLElement>("[data-add]");
    if (addBtn) {
      const hit = hitFromButton(addBtn);
      if (hit) addStock(hit);
      return;
    }
    const remove = t.closest<HTMLElement>("[data-remove]");
    if (remove?.dataset.remove) {
      event.preventDefault();
      event.stopPropagation();
      removeStock(remove.dataset.remove);
      return;
    }
    const filter = t.closest<HTMLElement>("[data-filter]");
    if (filter?.dataset.filter) {
      filterId = filter.dataset.filter;
      tab = "mine";
      paint();
      return;
    }
    const open = t.closest<HTMLElement>("[data-open]");
    if (open?.dataset.open) {
      tab = "mine";
      filterId = open.dataset.open;
      paint();
    }
  });

  app.addEventListener("input", (event) => {
    const t = event.target as HTMLElement;
    if (t.id === "q" && t instanceof HTMLInputElement) void onSearchInput(t.value);
  });

  app.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const t = event.target as HTMLElement;
    if (t.id !== "q") return;
    const first = suggestions[0] ?? typedStock(search);
    if (first) addStock(first);
  });
}

export function render(): void {
  bind();
  paint();
  void refreshAll();
  window.setInterval(() => {
    void refreshAll();
  }, 180_000);
  window.setInterval(() => paint(), 30_000);

  window.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const el = event.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
    event.preventDefault();
    app.querySelector<HTMLInputElement>("#q")?.focus();
  });
}
