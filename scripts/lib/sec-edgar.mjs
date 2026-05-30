// SEC EDGAR companyconcept API — capex from XBRL filings.
// Free, no API key. SEC requires a descriptive User-Agent.
// https://www.sec.gov/edgar/sec-api-documentation

const UA = 'My Daily Digest macro-digest contact@example.com';
const TIMEOUT = 12_000;

const CAPEX_CONCEPTS = [
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsForCapitalImprovements',
  'PaymentsToAcquireProductiveAssets',
  'PaymentsToAcquireMachineryAndEquipment',
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

// Returns { value, end, fp, fy, form, source, previousValue, previousEnd, periodKind }
// where periodKind is 'Q' (quarterly) or 'FY' (annual).
export async function fetchLatestQuarterlyCapex(cik) {
  const padded = String(cik).padStart(10, '0');

  for (const concept of CAPEX_CONCEPTS) {
    try {
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/us-gaap/${concept}.json`;
      const data = await getJson(url);
      const usd = data.units?.USD || [];

      // Dedupe by `end` keeping the newest `filed` (amendments win).
      const byEnd = new Map();
      for (const u of usd) {
        if (!u.fp) continue;
        if (!ACCEPTED_FORMS.has(u.form)) continue;
        const isQ  = u.fp.startsWith('Q');
        const isFY = u.fp === 'FY';
        if (!isQ && !isFY) continue;
        const key = `${u.end}|${isQ ? 'Q' : 'FY'}`;
        const prev = byEnd.get(key);
        if (!prev || u.filed > prev.filed) byEnd.set(key, { ...u, periodKind: isQ ? 'Q' : 'FY' });
      }

      // Prefer quarterly; if none, fall back to annual.
      const quarterly = [...byEnd.values()].filter(u => u.periodKind === 'Q')
        .sort((a, b) => b.end.localeCompare(a.end));
      const annual = [...byEnd.values()].filter(u => u.periodKind === 'FY')
        .sort((a, b) => b.end.localeCompare(a.end));

      const pool = quarterly.length > 0 ? quarterly : annual;
      if (pool.length === 0) continue;

      const latest = pool[0];
      const prev   = pool[1];
      return {
        value: latest.val,
        end: latest.end,
        fp: latest.fp,
        fy: latest.fy,
        form: latest.form,
        filed: latest.filed,
        concept,
        periodKind: latest.periodKind,
        previousValue: prev?.val,
        previousEnd: prev?.end,
      };
    } catch (err) {
      console.warn(`  CIK ${padded} ${concept}: ${err.message}`);
    }
  }
  return null;
}

export function formatCapexB(usd) {
  if (!Number.isFinite(usd)) return '—';
  if (usd >= 1e9)  return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6)  return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${usd.toFixed(0)}`;
}
