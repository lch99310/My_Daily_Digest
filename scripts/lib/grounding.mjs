// ============================================================================
// Card grounding for the news briefings (dc-digest, geopo-digest).
//
// Every article handed to the model gets a number ([#12]). The model must put
// those numbers in each card's 來源 field instead of a media name. After
// generation we parse the cards, drop any card that cites no real article
// number, and rewrite 來源 into the article's actual media name plus its link.
// A card the model made up has no article to point at, so it never ships —
// and every card that does ship links back to the story it came from.
// ============================================================================

const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━';
const NO_UPDATE = '本日無相關更新';
const MAX_LINKS_PER_CARD = 2;

/**
 * Pick the articles to put in the prompt: at most `perSource` per feed so a
 * high-volume feed can't crowd out the small ones, newest first, capped at
 * `max`. Expects `articles` already sorted newest first.
 */
export function selectArticles(articles, { perSource, max }) {
  const counts = new Map();
  const picked = [];
  for (const a of articles) {
    const n = counts.get(a.source) || 0;
    if (n >= perSource) continue;
    counts.set(a.source, n + 1);
    picked.push(a);
    if (picked.length >= max) break;
  }
  return picked;
}

/** Render the numbered article list for the prompt. */
export function formatArticleList(articles) {
  return articles
    .map((a, i) => {
      const src = a.source ? ` [來源：${a.source}]` : '';
      return `[#${i + 1}]${src} ${a.title}${a.desc ? '\n   ' + a.desc : ''}`;
    })
    .join('\n\n');
}

const FIELD_RE = /^\s*(?:[-*•]\s*)?\**\s*(標題|摘要|影響|風險|來源)\s*\**\s*[:：]\s*(.*)$/;
const SEP_RE   = /^\s*[━─—\-=_]{3,}\s*$/;
const REF_RE   = /#\s*(\d{1,3})/g;

const clean = s => s.replace(/\*\*/g, '').trim();
// Article numbers belong in 來源 only; strip any the model left in prose.
const stripRefs = s => s.replace(/\s*[\[（(]\s*#\s*\d{1,3}(?:\s*[、,，]\s*#\s*\d{1,3})*\s*[\]）)]/g, '').replace(/\s*#\s*\d{1,3}/g, '').trim();

/**
 * Validate and rewrite a generated briefing.
 *
 * @param {string}   raw       model output
 * @param {object[]} articles  the exact list numbered in the prompt
 * @param {object}   opts
 * @param {string[]} opts.cardSections  emoji prefixes of the card sections, in order
 * @param {string}   opts.summarySection emoji prefix of the free-text summary section
 * @param {string[]} opts.fields        card body fields in display order (before 來源)
 * @returns {{ text: string, kept: number, dropped: string[] }}
 */
export function groundBriefing(raw, articles, { cardSections, summarySection, fields }) {
  const lines = raw.replace(/\r/g, '').split('\n');
  const sections = [];   // { header, cards: [], summary: [] }
  const dropped = [];
  const usedRefs = new Set();
  let section = null;
  let card = null;
  let lastField = null;

  const headerOf = line => {
    const t = clean(line).replace(/^#+\s*/, '');
    const prefix = [...cardSections, summarySection].find(p => t.startsWith(p));
    return prefix ? { prefix, text: t } : null;
  };

  const closeCard = () => {
    if (!card) return;
    const c = card;
    card = null;
    lastField = null;
    if (!section || section.prefix === summarySection) return;
    const label = c.標題 || '(無標題)';
    if (!c.標題 || !c.摘要) { dropped.push(`${label}: missing 標題/摘要`); return; }
    const refs = [...new Set([...(c.來源 || '').matchAll(REF_RE)].map(m => Number(m[1])))]
      .filter(n => n >= 1 && n <= articles.length);
    if (refs.length === 0) { dropped.push(`${label}: no valid article number in 來源 (${c.來源 || 'empty'})`); return; }
    if (usedRefs.has(refs[0])) { dropped.push(`${label}: duplicates article #${refs[0]}`); return; }
    refs.forEach(n => usedRefs.add(n));
    section.cards.push({ ...c, refs });
  };

  for (const line of lines) {
    const header = headerOf(line);
    if (header) {
      closeCard();
      section = { prefix: header.prefix, header: header.text, cards: [], summary: [] };
      sections.push(section);
      continue;
    }
    if (!section) continue; // preamble before the first section
    if (section.prefix === summarySection) {
      section.summary.push(stripRefs(clean(line)));
      continue;
    }
    if (SEP_RE.test(line)) { closeCard(); continue; }

    const m = FIELD_RE.exec(line);
    if (m) {
      const [, name, value] = m;
      if (name === '標題') { closeCard(); card = {}; }
      if (!card) continue;
      card[name] = name === '來源' ? clean(value) : stripRefs(clean(value));
      lastField = name;
      if (name === '來源') closeCard();
      continue;
    }
    // Wrapped continuation of a long 摘要/影響 line.
    if (card && lastField && lastField !== '標題' && line.trim()) {
      card[lastField] += stripRefs(clean(line));
    }
  }
  closeCard();

  const out = [];
  let kept = 0;
  for (const s of sections) {
    if (out.length) out.push('');
    out.push(s.header);
    if (s.prefix === summarySection) {
      out.push(...s.summary);
      continue;
    }
    out.push('');
    if (s.cards.length === 0) { out.push(NO_UPDATE); continue; }
    for (const c of s.cards) {
      kept++;
      out.push(SEPARATOR);
      out.push(`標題：${c.標題}`);
      for (const f of fields) if (f !== '標題' && c[f]) out.push(`${f}：${c[f]}`);
      const cited = c.refs.slice(0, MAX_LINKS_PER_CARD).map(n => articles[n - 1]);
      out.push(`來源：${[...new Set(cited.map(a => a.source))].join('、')}`);
      for (const a of cited) if (a.link) out.push(a.link);
      out.push('');
    }
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, kept, dropped };
}
