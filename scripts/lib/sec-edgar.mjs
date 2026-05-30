// SEC EDGAR companyconcept API — quarterly capex from XBRL filings.
// Free, no API key. SEC requires a descriptive User-Agent.
// https://www.sec.gov/edgar/sec-api-documentation

const UA = 'My Daily Digest macro-digest contact@example.com';
const TIMEOUT = 12_000;

const CAPEX_CONCEPTS = [
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsForCapitalImprovements',
  'PaymentsToAcquireProductiveAssets',
];

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// CIK must be 10 digits zero-padded. Returns { value, end, fp, fy, form, source }
// where value is USD, end is YYYY-MM-DD quarter end, fp is Q1/Q2/Q3.
export async function fetchLatestQuarterlyCapex(cik) {
  const padded = String(cik).padStart(10, '0');

  for (const concept of CAPEX_CONCEPTS) {
    try {
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/us-gaap/${concept}.json`;
      const data = await getJson(url);
      const usd = data.units?.USD || [];
      // Quarterly entries: 10-Q form, fp = Q1/Q2/Q3. Annual (10-K, FY) skipped.
      // SEC reports same period multiple times across amendments → dedupe by
      // `end` keeping highest `filed` (newest filing wins).
      const byEnd = new Map();
      for (const u of usd) {
        if (!u.fp || !u.fp.startsWith('Q')) continue;
        if (!['10-Q', '10-Q/A'].includes(u.form)) continue;
        const prev = byEnd.get(u.end);
        if (!prev || u.filed > prev.filed) byEnd.set(u.end, u);
      }
      const quarterly = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
      if (quarterly.length === 0) continue;
      const latest = quarterly[0];
      const prev   = quarterly[1];
      return {
        value: latest.val,
        end: latest.end,
        fp: latest.fp,
        fy: latest.fy,
        form: latest.form,
        filed: latest.filed,
        concept,
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
