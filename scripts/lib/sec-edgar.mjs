// SEC EDGAR companyconcept API — capex from XBRL filings.
// Free, no API key. SEC requires a descriptive User-Agent.
// https://www.sec.gov/edgar/sec-api-documentation

const UA = 'My Daily Digest macro-digest contact@example.com';
const TIMEOUT = 12_000;

const CAPEX_CONCEPTS = [
  // us-gaap variants — companies pick whichever fits their disclosure style.
  // Amazon historically reported under PaymentsToAcquirePropertyPlantAnd-
  // Equipment but later split capex into multiple concepts incl. finance
  // leases; we pool data from every concept and pick the newest.
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets',
  'PaymentsForCapitalImprovements',
  'PaymentsToAcquireMachineryAndEquipment',
  'PaymentsToAcquireOtherProductiveAssets',
  'PaymentsForPropertyPlantAndEquipment',
];

// Forms that legitimately disclose periodic capex via XBRL.
// 10-Q / 10-K = ongoing US filers. S-1 = IPO prospectus (used by pre-IPO
// companies like SpaceX whose CIK is registered but no 10-Q exists yet).
const ACCEPTED_FORMS = new Set([
  '10-Q', '10-Q/A',
  '10-K', '10-K/A',
  '20-F', '20-F/A',
  'S-1',  'S-1/A',
  'F-1',  'F-1/A',
]);

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Returns { value, end, fp, fy, form, previousValue, previousEnd, periodKind,
//           yoyValue, yoyEnd, history } where `history` is oldest → newest
// last N periods usable for charting; each item has {date,end,fp,value}.
//
// Strategy: instead of trying concepts one-by-one and stopping at the first
// hit (which returned stale 2017 data for Amazon — they later split capex
// into multiple concepts), pool entries from ALL concepts and pick the
// newest. Same period reported under multiple concepts dedupes by `filed`.
export async function fetchLatestQuarterlyCapex(cik, { historyCount = 6 } = {}) {
  const padded = String(cik).padStart(10, '0');

  // (end + periodKind) → entry; later filings or concepts win on equal key.
  const byKey = new Map();
  let conceptsHit = 0;

  for (const concept of CAPEX_CONCEPTS) {
    try {
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/us-gaap/${concept}.json`;
      const data = await getJson(url);
      const usd = data.units?.USD || [];

      for (const u of usd) {
        if (!u.fp) continue;
        if (!ACCEPTED_FORMS.has(u.form)) continue;
        const isQ  = u.fp.startsWith('Q');
        const isFY = u.fp === 'FY';
        if (!isQ && !isFY) continue;
        const key = `${u.end}|${isQ ? 'Q' : 'FY'}`;
        const prev = byKey.get(key);
        // Prefer later filings; if same filing date, prefer the concept that
        // appears earlier in CAPEX_CONCEPTS (us-gaap canonical name first).
        if (!prev || u.filed > prev.filed) {
          byKey.set(key, { ...u, periodKind: isQ ? 'Q' : 'FY', concept });
        }
      }
      conceptsHit++;
    } catch (err) {
      // 404 = company doesn't report under this concept; that's fine.
      if (!String(err.message).includes('404')) {
        console.warn(`  CIK ${padded} ${concept}: ${err.message}`);
      }
    }
  }

  if (byKey.size === 0) return null;

  // Prefer quarterly; if none, fall back to annual.
  const all = [...byKey.values()];
  const quarterly = all.filter(u => u.periodKind === 'Q').sort((a, b) => b.end.localeCompare(a.end));
  const annual    = all.filter(u => u.periodKind === 'FY').sort((a, b) => b.end.localeCompare(a.end));

  const pool = quarterly.length > 0 ? quarterly : annual;
  if (pool.length === 0) return null;

  const latest = pool[0];
  const prev   = pool[1];

  // YoY counterpart: for quarterly, 4 periods back; for annual, 1 period back.
  const yoyOffset = latest.periodKind === 'Q' ? 4 : 1;
  const yoy = pool[yoyOffset];

  const history = pool
    .slice(0, historyCount)
    .reverse()
    .map(u => ({ date: u.end, end: u.end, value: u.val, fp: u.fp }));

  return {
    value: latest.val,
    end: latest.end,
    fp: latest.fp,
    fy: latest.fy,
    form: latest.form,
    filed: latest.filed,
    concept: latest.concept,
    periodKind: latest.periodKind,
    previousValue: prev?.val,
    previousEnd: prev?.end,
    yoyValue: yoy?.val,
    yoyEnd: yoy?.end,
    history,
  };
}

export function formatCapexB(usd) {
  if (!Number.isFinite(usd)) return '—';
  if (usd >= 1e9)  return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6)  return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${usd.toFixed(0)}`;
}

// Compact period label, unified across quarterly and annual:
//   "2026-03-31" + "Q1" → "26Q1"      (quarterly filing)
//   "2025-12-31" + "FY" → "Y25"        (annual filing, actuals)
// Private-company estimates supply their own "Y25E" string via config.
export function shortPeriodLabel(end, fp) {
  if (!end) return fp || '—';
  const yr = end.slice(2, 4);
  if (fp === 'FY') return `Y${yr}`;
  return `${yr}${fp || ''}`;
}
