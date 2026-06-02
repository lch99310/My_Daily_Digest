// RSS fetch + parse helpers extracted from dc-digest.mjs / geopo-digest.mjs.
// Kept zero-dependency and used by the new finance digests; existing digests
// retain their inlined copies (deliberately not refactored to avoid churn).

export function parseRSSItems(xml) {
  const items = [];
  const itemRe  = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  const titleRe = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const descRe  = /<(?:description|summary|content(?::[^>]*)?)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content(?::[^>]*)?)>/;
  const linkRe  = /<link(?:\s[^>]*)?>([^<\s]+)<\/link>|<link[^>]+href="([^"]+)"/;
  const dateRe  = /<(pubDate|published|updated|dc:date)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/;

  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (titleRe.exec(block)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const desc  = (descRe.exec(block)?.[1]  || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim().slice(0, 250);
    const lm    = linkRe.exec(block);
    const link  = (lm?.[1] || lm?.[2] || '').trim();
    const dm    = dateRe.exec(block);
    const pubDate = (dm?.[2] || '').trim();
    if (title && title.length > 8) items.push({ title, desc, link, pubDate });
  }
  return items;
}

export async function fetchFeed({ name, url, ua = 'finance-digest/1.0', timeoutMs = 12_000 }) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': `Mozilla/5.0 (compatible; ${ua})` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRSSItems(xml).map(it => ({ ...it, source: name }));
    console.log(`  ${name}: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`  ${name}: failed (${err.message})`);
    return [];
  }
}

export function dedupeByTitle(items, prefixLen = 40) {
  const seen = new Set();
  return items.filter(a => {
    const key = a.title.toLowerCase().slice(0, prefixLen);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function filterByAge(items, hours = 24) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return items.filter(a => {
    if (!a.pubDate) return false;
    const t = new Date(a.pubDate).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

export function sortByDateDesc(items) {
  return [...items].sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
}
