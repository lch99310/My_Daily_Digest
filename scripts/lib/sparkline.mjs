// ASCII sparkline + min/max/now annotation row + decade axis.
// Pure function; no deps. v2 swap-out point: replace with renderSparklineUrl()
// to use QuickChart.io and send via Telegram sendPhoto.

const BLOCKS = '▁▂▃▄▅▆▇█';

// series: [{ date: 'YYYY-MM-DD', value: number }, ...] sorted oldest → newest.
// opts.unit: optional suffix appended to min/max/now numbers ('%' etc.)
// opts.precision: decimal places for displayed numbers (default 1)
export function renderSparkline(series, opts = {}) {
  const { unit = '', precision = 1 } = opts;
  if (!Array.isArray(series) || series.length === 0) return '(無資料)';

  const values = series.map(p => p.value).filter(Number.isFinite);
  if (values.length === 0) return '(無資料)';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const bars = series.map(p => {
    if (!Number.isFinite(p.value)) return ' ';
    const idx = Math.min(
      BLOCKS.length - 1,
      Math.max(0, Math.round(((p.value - min) / range) * (BLOCKS.length - 1))),
    );
    return BLOCKS[idx];
  }).join('');

  const minPoint = series.find(p => p.value === min);
  const maxPoint = series.find(p => p.value === max);
  const nowPoint = [...series].reverse().find(p => Number.isFinite(p.value));

  const fmt = v => `${v.toFixed(precision)}${unit}`;
  const ym  = d => (d || '').slice(0, 7);

  const headerLine =
    `區間: ${fmt(min)} (${ym(minPoint?.date)}) ─ ${fmt(max)} (${ym(maxPoint?.date)}) ─ 最新 ${fmt(nowPoint.value)}`;

  // Axis labels: align "start year" and "end year" under bar string. Bars need
  // to be at least startYr+space+endYr (≈10 chars) for the line to look right;
  // shorter series fall back to "startYr → endYr".
  const startYr = (series[0].date || '').slice(0, 4);
  const endYr   = (series[series.length - 1].date || '').slice(0, 4);
  const minWidth = startYr.length + 1 + endYr.length;
  const axisLine = bars.length >= minWidth
    ? startYr + ' '.repeat(bars.length - startYr.length - endYr.length) + endYr
    : `${startYr} → ${endYr}`;

  return `${headerLine}\n${bars}\n${axisLine}`;
}
