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
    // Extract chart config from the long URL
    const u = new URL(longUrl);
    const config = JSON.parse(decodeURIComponent(u.searchParams.get('c')));
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
// CPI + Core PCE together, Fed Funds + 10Y together, etc.
export function buildMultiSparklineUrl(seriesList, opts = {}) {
  const { title = '', width = 700, height = 280, yUnit = '' } = opts;
  if (!Array.isArray(seriesList) || seriesList.length === 0) return null;
  const valid = seriesList.filter(s => s.points && s.points.length > 0);
  if (valid.length === 0) return null;

  const palette = ['rgb(54,162,235)', 'rgb(255,99,132)', 'rgb(75,192,192)', 'rgb(255,159,64)'];

  // Build a common x-axis from the longest series.
  const longest = valid.reduce((a, b) => b.points.length > a.points.length ? b : a);
  const labels = longest.points.map(p => (p.date || '').slice(0, 7));
  const labelIndex = new Map(labels.map((l, i) => [l, i]));

  const datasets = valid.map((s, i) => {
    const data = Array(labels.length).fill(null);
    for (const p of s.points) {
      const idx = labelIndex.get((p.date || '').slice(0, 7));
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
