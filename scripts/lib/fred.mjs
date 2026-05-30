// FRED (St. Louis Fed) API client. Requires FRED_API_KEY env var (free).
// https://fred.stlouisfed.org/docs/api/fred/series_observations.html

const TIMEOUT = 12_000;
const MAX_ATTEMPTS = 3;

// Retry transient failures (429, 5xx, network) with linear backoff. FRED's
// stated limit is 120 reqs/min — bursts of 20 in 1s sometimes get throttled.
async function fredGet(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      const body = await res.text();
      lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastErr;
      console.warn(`  FRED ${label} attempt ${attempt}/${MAX_ATTEMPTS} got ${res.status}, retrying…`);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) throw err;
      console.warn(`  FRED ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800 * attempt));
  }
  throw lastErr;
}

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

  const data = await fredGet(url, seriesId);

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

// Next scheduled release date for a series, via FRED's release calendar.
// Returns YYYY-MM-DD string or null if unavailable.
export async function fetchNextReleaseDate(seriesId, apiKey) {
  if (!apiKey) return null;
  try {
    // Step 1: find the release_id that owns this series.
    const relUrl =
      `https://api.stlouisfed.org/fred/series/release?series_id=${encodeURIComponent(seriesId)}` +
      `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    const relData = await fredGet(relUrl, `${seriesId}/release`);
    const releaseId = relData.releases?.[0]?.id;
    if (!releaseId) return null;

    // Step 2: list future release dates (include "no data yet" entries).
    const today = new Date().toISOString().slice(0, 10);
    const datesUrl =
      `https://api.stlouisfed.org/fred/release/dates` +
      `?release_id=${releaseId}` +
      `&realtime_start=${today}` +
      `&include_release_dates_with_no_data=true` +
      `&sort_order=asc&limit=3` +
      `&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    const datesData = await fredGet(datesUrl, `${seriesId}/dates`);
    return datesData.release_dates?.[0]?.date || null;
  } catch (err) {
    console.warn(`  next-release lookup for ${seriesId} failed: ${err.message}`);
    return null;
  }
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
