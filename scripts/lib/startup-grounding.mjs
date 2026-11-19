// ============================================================================
// Grounding for the weekly startup-funding digest.
//
// The model only extracts. Every deal it returns must cite article numbers
// ([#N]) from the list it was given, and code then checks each field against
// the text of those articles:
//
//   - no valid article number            → the deal is dropped
//   - company name not in the cited text → the deal is dropped
//   - amount / round / city / investor not in the cited text → that field is
//     cleared to 未載明 (the deal stays)
//   - 做什麼 / 資金用途 must come with a verbatim English quote from the cited
//     text; a quote that is not there clears the field
//
// Dates and links never come from the model: they are the cited articles'
// own pubDate and URL. This is the 2026-10-13 DC lesson (invented ByteDance
// cards attributed to a real outlet) applied field by field, because a funding
// card is mostly numbers and names, the parts a model gets wrong most easily.
// ============================================================================

export const NOT_STATED = '未載明';

const norm = s => (s || '')
  .toLowerCase()
  .replace(/&#8217;|&#8216;|[‘’`]/g, "'")
  .replace(/&#8220;|&#8221;|[“”]/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

/** The article text a deal may be checked against. */
export function articleText(a) {
  return norm(`${a.title}\n${a.desc || ''}\n${a.body || ''}`);
}

/** Numbers in an amount string: 'A$5.6M' → ['5.6'], 'US$290 million' → ['290']. */
function amountNumbers(amount) {
  return [...(amount || '').matchAll(/\d+(?:[.,]\d+)*/g)].map(m => m[0].replace(/,/g, ''));
}

function numberInText(num, text) {
  // '5.6' must appear as a number, not inside '15.62'; allow '1,200' for '1200'.
  const variants = new Set([num, Number(num).toLocaleString('en-US')]);
  return [...variants].some(v =>
    new RegExp(`(^|[^\\d.])${v.replace(/[.]/g, '\\.')}(?![\\d])`).test(text));
}

const ROUND_WORDS = [
  ['pre-seed', /pre-?seed/], ['seed', /\bseed\b/], ['series a', /series a\b/],
  ['series b', /series b\b/], ['series c', /series c\b/], ['series d', /series d\b/],
  ['bridge', /\bbridge\b/], ['convertible', /convertible/], ['debt', /\bdebt\b|\bloan\b|facility/],
  ['grant', /\bgrant/], ['extension', /extension/], ['safe', /\bsafe\b/],
];

/** Every round word in the model's round must also be in the text. */
function roundGrounded(round, text) {
  const r = norm(round);
  const claimed = ROUND_WORDS.filter(([, re]) => re.test(r));
  if (claimed.length === 0) return text.includes(r);
  return claimed.every(([, re]) => re.test(text));
}

/** A quote counts if its normalised form is in the text and is long enough to mean something. */
function quoteGrounded(quote, text) {
  const q = norm(quote).replace(/^["']|["']$/g, '');
  return q.length >= 20 && text.includes(q);
}

const DC_RE = /data cent(?:er|re)|datacent|\bgpu cloud\b|\bai factory\b|hyperscale|colocation/;

/**
 * Validate the model's deals against the numbered article list.
 *
 * @param {object[]} deals     parsed model output
 * @param {object[]} articles  the exact list numbered in the prompt (1-based)
 * @returns {{ kept: object[], dropped: string[], cleared: string[], dc: string[] }}
 */
export function groundDeals(deals, articles) {
  const kept = [];
  const dropped = [];
  const cleared = [];
  const dc = [];
  const seen = new Set();

  for (const d of Array.isArray(deals) ? deals : []) {
    const name = (d.company || '').trim();
    const label = name || '(無公司名)';
    const refs = [...new Set((d.refs || []).map(Number))]
      .filter(n => Number.isInteger(n) && n >= 1 && n <= articles.length);
    if (!name) { dropped.push(`${label}: 沒有公司名`); continue; }
    if (refs.length === 0) { dropped.push(`${label}: 沒有有效的文章編號`); continue; }

    const cited = refs.map(n => articles[n - 1]);
    const text = cited.map(articleText).join('\n');
    if (!text.includes(norm(name))) { dropped.push(`${label}: 公司名不在引用的原文裡`); continue; }

    const key = norm(name);
    if (seen.has(key)) { dropped.push(`${label}: 重複`); continue; }

    const out = {
      company: name,
      kind: ['equity', 'debt', 'grant'].includes(d.kind) ? d.kind : 'equity',
      refs,
    };
    const clear = (field, why) => { cleared.push(`${name}.${field}: ${why}`); return NOT_STATED; };

    // Amount: every number the model wrote must be in the text.
    const nums = amountNumbers(d.amount);
    out.amount = !d.amount || nums.length === 0 ? NOT_STATED
      : nums.every(n => numberInText(n, text)) ? d.amount.trim()
      : clear('amount', `「${d.amount}」的數字不在原文`);

    out.round = !d.round ? NOT_STATED
      : roundGrounded(d.round, text) ? d.round.trim()
      : clear('round', `「${d.round}」不在原文`);

    out.city = !d.city ? NOT_STATED
      : text.includes(norm(d.city)) ? d.city.trim()
      : clear('city', `「${d.city}」不在原文`);

    out.program = !d.program ? ''
      : text.includes(norm(d.program)) ? d.program.trim()
      : (clear('program', `「${d.program}」不在原文`), '');

    const investors = Array.isArray(d.investors) ? d.investors : [];
    out.investors = investors.filter(i => i && text.includes(norm(i)));
    for (const i of investors) if (i && !out.investors.includes(i)) clear('investors', `「${i}」不在原文`);

    out.what = d.what_zh && quoteGrounded(d.what_quote, text) ? d.what_zh.trim()
      : d.what_zh ? clear('what', '原文引句比對不到') : NOT_STATED;
    out.what_quote = out.what === NOT_STATED ? '' : d.what_quote.trim();

    out.use = d.use_zh && quoteGrounded(d.use_quote, text) ? d.use_zh.trim()
      : d.use_zh ? clear('use', '原文引句比對不到') : NOT_STATED;
    out.use_quote = out.use === NOT_STATED ? '' : d.use_quote.trim();

    // Data-centre and compute raises belong to the DC briefing.
    if (DC_RE.test(norm(`${out.what_quote} ${cited.map(a => a.title).join(' ')}`))) {
      dc.push(name);
      continue;
    }

    seen.add(key);
    kept.push(out);
  }
  return { kept, dropped, cleared, dc };
}

/**
 * Validate the model's pick of timeline items. Candidates are numbered per
 * company; the model may only choose numbers, and a chosen item must name the
 * company in its title. The date, title and link come from the feed.
 *
 * @param {object} picks       { [company]: [{ n, zh }] }
 * @param {object} candidates  { [company]: [{ title, link, pubDate, source }] }
 */
export function groundTimeline(picks, candidates) {
  const out = {};
  for (const [company, list] of Object.entries(candidates)) {
    const chosen = Array.isArray(picks?.[company]) ? picks[company] : [];
    const items = [];
    const used = new Set();
    for (const p of chosen) {
      const n = Number(p?.n);
      const item = list[n - 1];
      if (!item || used.has(n)) continue;
      if (!norm(item.title).includes(norm(company))) continue;
      used.add(n);
      items.push({ ...item, zh: typeof p.zh === 'string' ? p.zh.trim() : '' });
    }
    items.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
    out[company] = items.slice(-5);
  }
  return out;
}
