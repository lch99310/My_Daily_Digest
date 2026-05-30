// Yahoo Finance public endpoints (no API key, ~best-effort).
// As of mid-2023 the v7 /quote endpoint requires a crumb cookie and 401s
// without it. The v8 /chart endpoint is still open and exposes the live
// quote inside its `meta` block, so we use chart for live prices. quoteSummary
// v10 is also crumb-gated for many tickers; we catch failures and the caller
// falls back to cached fundamentals in config/stock-tickers.json.

const UA = 'Mozilla/5.0 (compatible; finance-digest/1.0)';
const TIMEOUT = 12_000;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Live quotes via v8 chart endpoint (works without crumb). One request per
// symbol — N requests but each is small and we run them in parallel.
export async function fetchQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map(async (sym) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
    const data = await getJson(url);
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('no meta');
    return {
      symbol: meta.symbol || sym,
      regularMarketPrice: meta.regularMarketPrice,
      regularMarketPreviousClose: meta.chartPreviousClose ?? meta.previousClose,
      source: 'yahoo-chart',
    };
  }));
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`  yahoo quote ${symbols[i]} failed: ${r.reason?.message}`);
    return { symbol: symbols[i], error: r.reason?.message };
  });
}

// Stooq CSV fallback for live prices (no auth, no rate limit headaches).
// CSV format with f=sd2t2ohlc:  Symbol,Date,Time,Open,High,Low,Close
export async function fetchQuotesStooq(symbols) {
  const stooqSyms = symbols.map(s => `${s.toLowerCase()}.us`).join(',');
  const url = `https://stooq.com/q/l/?s=${stooqSyms}&f=sd2t2ohlc&h&e=csv`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split('\n').slice(1);
  return lines.map(line => {
    const cols = line.split(',');
    return {
      symbol: (cols[0] || '').replace(/\.US$/i, ''),
      regularMarketPrice: Number(cols[6]),
      regularMarketPreviousClose: Number(cols[3]),  // Open as crude proxy
      source: 'stooq',
    };
  }).filter(q => Number.isFinite(q.regularMarketPrice));
}

// Best-effort quote fetch: Yahoo chart first, Stooq fills gaps.
export async function fetchQuotesResilient(symbols) {
  let primary = [];
  try {
    primary = await fetchQuotes(symbols);
  } catch (err) {
    console.warn(`Yahoo chart batch failed: ${err.message}`);
  }
  const ok = new Map(primary.filter(q => Number.isFinite(q.regularMarketPrice)).map(q => [q.symbol, q]));
  const missing = symbols.filter(s => !ok.has(s));
  if (missing.length === 0) return [...ok.values()];

  console.log(`Falling back to Stooq for ${missing.length} symbol(s): ${missing.join(', ')}`);
  try {
    const stooq = await fetchQuotesStooq(missing);
    for (const q of stooq) ok.set(q.symbol, q);
  } catch (err) {
    console.warn(`Stooq fallback failed: ${err.message}`);
  }
  return symbols.map(s => ok.get(s) || { symbol: s, error: 'all sources failed' });
}

export async function fetchSummary(symbol, modules) {
  const m = modules.join(',');
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${m}`;
  const data = await getJson(url);
  return data.quoteSummary?.result?.[0] || {};
}

// Pull as many fundamentals as Yahoo will give us. Each field is best-effort;
// missing values stay undefined so the caller can blend with cached config.
export async function fetchFundamentals(symbol) {
  const out = { symbol };

  try {
    const summary = await fetchSummary(symbol, [
      'defaultKeyStatistics',
      'financialData',
      'earningsTrend',
      'price',
    ]);

    const keyStats   = summary.defaultKeyStatistics || {};
    const finData    = summary.financialData || {};
    const earnTrend  = summary.earningsTrend?.trend || [];

    out.eps              = num(keyStats.trailingEps);
    out.beta             = num(keyStats.beta);
    out.sharesOutstanding = num(keyStats.sharesOutstanding);
    out.operatingCashflow = num(finData.operatingCashflow);
    out.freeCashflow      = num(finData.freeCashflow);

    // earningsTrend includes a "+5y" period with growth.raw as a decimal.
    const fiveYr = earnTrend.find(t => t.period === '+5y');
    out.growth5y = num(fiveYr?.growth);
  } catch (err) {
    console.warn(`  ${symbol} fundamentals fetch failed: ${err.message}`);
  }

  return out;
}

// Helper — Yahoo wraps numbers as `{ raw, fmt, longFmt }`; pull `.raw`.
function num(field) {
  if (field == null) return undefined;
  if (typeof field === 'number') return Number.isFinite(field) ? field : undefined;
  if (typeof field === 'object' && Number.isFinite(field.raw)) return field.raw;
  return undefined;
}

// ^TNX is the 10Y Treasury Yield in percent (e.g. 4.30). Divide by 100 → decimal.
export async function fetch10YTreasury() {
  try {
    const quotes = await fetchQuotesResilient(['^TNX']);
    const tnx = quotes[0]?.regularMarketPrice;
    if (!Number.isFinite(tnx)) return undefined;
    return tnx / 100;
  } catch (err) {
    console.warn(`  10Y treasury fetch failed: ${err.message}`);
    return undefined;
  }
}

// Historical close prices via chart API. range: '5y', interval: '1mo' for monthly.
// Returns [{ date: 'YYYY-MM-DD', value: number }, ...] sorted ascending.
export async function fetchHistory(symbol, { range = '5y', interval = '1mo' } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const data = await getJson(url);
  const result = data.chart?.result?.[0];
  if (!result) return [];
  const ts     = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  return ts.map((t, i) => {
    const v = closes[i];
    if (!Number.isFinite(v)) return null;
    return { date: new Date(t * 1000).toISOString().slice(0, 10), value: v };
  }).filter(Boolean);
}
