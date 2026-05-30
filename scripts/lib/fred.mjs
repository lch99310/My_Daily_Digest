// FRED (St. Louis Fed) API client. Requires FRED_API_KEY env var (free).
// https://fred.stlouisfed.org/docs/api/fred/series_observations.html

const TIMEOUT = 12_000;

export async function fetchSeries(seriesId, { years = 5, apiKey } = {}) {
  if (!apiKey) throw new Error('FRED_API_KEY required');

  const obsStart = new Date();
  obsStart.setFullYear(obsStart.getFullYear() - years);
  const startStr = obsStart.toISOString().slice(0, 10);

  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}` +
    `&file_type=json` +
    `&observation_start=${startStr}` +
    `&sort_order=asc`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`FRED ${seriesId} HTTP ${res.status}`);
  const data = await res.json();

  const obs = (data.observations || [])
    .filter(o => o.value !== '.' && o.value != null)
    .map(o => ({ date: o.date, value: Number(o.value) }))
    .filter(o => Number.isFinite(o.value));

  return obs;
}

// Returns { latest, previous, latestDate, deltaSign }.
export function summarizeSeries(obs) {
  if (!obs || obs.length === 0) return {};
  const latest = obs[obs.length - 1];
  const previous = obs[obs.length - 2];
  let deltaSign = '';
  if (previous && Number.isFinite(previous.value)) {
    if (latest.value > previous.value) deltaSign = '↑';
    else if (latest.value < previous.value) deltaSign = '↓';
    else deltaSign = '→';
  }
  return {
    latest: latest.value,
    previous: previous?.value,
    latestDate: latest.date,
    deltaSign,
  };
}

// Compute YoY % change series from a level series.
export function toYoYSeries(obs) {
  if (!obs || obs.length < 13) return [];
  return obs.map((o, i) => {
    const yearAgo = obs[i - 12];
    if (!yearAgo) return null;
    return { date: o.date, value: ((o.value - yearAgo.value) / yearAgo.value) * 100 };
  }).filter(Boolean);
}
