// Yahoo Finance public endpoints (no API key, ~best-effort).
// quote v7 is reliable for live price + a handful of fundamentals.
// quoteSummary v10 returns deep financials but Yahoo intermittently requires
// a crumb cookie now; we catch failures and the caller falls back to cached
// values from config/stock-tickers.json.

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

export async function fetchQuotes(symbols) {
  const symbolList = symbols.join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolList)}`;
  const data = await getJson(url);
  return data.quoteResponse?.result || [];
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
    const quotes = await fetchQuotes(['^TNX']);
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
