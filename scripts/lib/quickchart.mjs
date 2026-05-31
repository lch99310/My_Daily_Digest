// QuickChart.io URL builder for sparkline-as-photo. We use the GET endpoint
// with a URL-encoded Chart.js v3 config. URLs stay well under Telegram's
// sendPhoto limit for our 5y monthly series (~60 points).

const BASE = 'https://quickchart.io/chart';
const CREATE = 'https://quickchart.io/chart/create';
const TIMEOUT = 10_000;

// POST chart config to QuickChart to get a short permanent URL. Long GET URLs
// (4+ KB) occasionally fail in Telegram sendPhoto; the short URL is ~100 chars
// and rock-solid. Falls back to the raw GET URL if the POST itself fails.
export async function shortenChartUrl(longUrl) {
  try {
    // Extract chart config from the long URL. URLSearchParams.get() already
    // percent-decodes — calling decodeURIComponent on the result would be a
    // double-decode and throws "URI malformed" on any literal `%` in the
    // JSON (e.g. callback strings ending in '%').
    const u = new URL(longUrl);
    const config = JSON.parse(u.searchParams.get('c'));
    const width  = u.searchParams.get('w');
    const height = u.searchParams.get('h');

    const res = await fetch(CREATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chart: config,
        width: width ? Number(width) : undefined,
        height: height ? Number(height) : undefined,
        backgroundColor: 'white',
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.success && data.url) return data.url;
    throw new Error(data.error || 'no url in response');
  } catch (err) {
    console.warn(`  QuickChart shorten failed: ${err.message} — using long URL`);
    return longUrl;
  }
}

export function buildSparklineUrl(series, opts = {}) {
  const {
    label = '',
    color = 'rgb(54,162,235)',
    width = 600,
    height = 240,
    yUnit = '',
  } = opts;
  if (!Array.isArray(series) || series.length === 0) return null;

  const labels = series.map(p => (p.date || '').slice(0, 7));
  const data   = series.map(p => p.value);

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label,
        data,
        borderColor: color,
        backgroundColor: color,
        fill: false,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.2,
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title:  { display: !!label, text: label, font: { size: 14 } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, autoSkip: true } },
        y: { ticks: { callback: `v => v + '${yUnit}'` } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `${BASE}?w=${width}&h=${height}&bkg=white&c=${encoded}`;
}

// Combined chart of multiple series sharing the same x-axis. Useful for
// CPI + Core PCE together, capex across multiple companies, etc.
//
// Each point: { date: 'YYYY-MM-DD', value, displayLabel? }
// date is used for chronological sorting + dedup; displayLabel (optional)
// is what shows on the x-axis tick (e.g. "26Q1"). Without displayLabel we
// fall back to date.slice(0, 7) ("YYYY-MM").
export function buildMultiSparklineUrl(seriesList, opts = {}) {
  const { title = '', width = 700, height = 280, yUnit = '' } = opts;
  if (!Array.isArray(seriesList) || seriesList.length === 0) return null;
  const valid = seriesList.filter(s => s.points && s.points.length > 0);
  if (valid.length === 0) return null;

  const palette = ['rgb(54,162,235)', 'rgb(255,99,132)', 'rgb(75,192,192)', 'rgb(255,159,64)', 'rgb(153,102,255)', 'rgb(255,205,86)'];

  // Collect every (date, label) tuple across all series, then sort by date.
  // This fixes the prior bug where only the "longest" series controlled the
  // axis — companies with different fiscal-year alignment ended up with
  // out-of-order or dropped points.
  const dateToLabel = new Map();
  for (const s of valid) {
    for (const p of s.points) {
      if (!p.date) continue;
      dateToLabel.set(p.date, p.displayLabel || p.date.slice(0, 7));
    }
  }
  const sortedDates = [...dateToLabel.keys()].sort();
  const labels = sortedDates.map(d => dateToLabel.get(d));
  const dateIndex = new Map(sortedDates.map((d, i) => [d, i]));

  const datasets = valid.map((s, i) => {
    const data = Array(labels.length).fill(null);
    for (const p of s.points) {
      const idx = dateIndex.get(p.date);
      if (idx != null) data[idx] = p.value;
    }
    return {
      label: s.label,
      data,
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length],
      fill: false,
      pointRadius: 0,
      borderWidth: 2,
      tension: 0.2,
      spanGaps: true,
    };
  });

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: {
        legend: { display: true, position: 'top' },
        title:  { display: !!title, text: title, font: { size: 14 } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, autoSkip: true } },
        y: { ticks: { callback: `v => v + '${yUnit}'` } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `${BASE}?w=${width}&h=${height}&bkg=white&c=${encoded}`;
}
