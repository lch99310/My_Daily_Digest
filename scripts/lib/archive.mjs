// ============================================================================
// Card archive for the daily briefings (dc, geopo, ai).
//
// Every run appends its shipped cards to archive/<stream>/YYYY-MM.jsonl, one
// JSON object per line. The workflow commits the file back to the repo, and
// lch-llm-wiki pulls a week of it every Sunday. Only the news itself is kept
// (title, summary, source, link) — the model's 風險/影響/總結 commentary is not.
//
// Dates are Sydney dates: the briefings run 21:00–23:00 UTC, which is the
// morning of the next day in Sydney, the day the briefing is read.
// ============================================================================

import { createHash } from 'crypto';
import { mkdir, readFile, appendFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Today's date in Sydney as YYYY-MM-DD. */
export function sydneyDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

/** '2026-11-05' → '2026-10'; '2027-01-02' → '2026-12'. */
function previousMonth(date) {
  const [y, m] = date.slice(0, 7).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Section header → plain label: drop the leading emoji and the "(Top N)" suffix. */
export function sectionLabel(header) {
  return header
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s*[(（]\s*Top\s*\d+\s*[)）]\s*$/i, '')
    .trim();
}

/**
 * Append cards to archive/<stream>/<YYYY-MM>.jsonl. A card's id is a hash of
 * stream + link (title when there is no link), so a manual re-run on the same
 * day adds nothing that is already there. Ids in the previous month's file
 * count too: a story archived on 10-29 came back on 11-05 and was stored twice.
 *
 * @param {string}   stream  'dc' | 'geopo' | 'ai'
 * @param {object[]} cards   { section, title, summary, source, feed, url }
 * @returns {Promise<{ path: string, added: number, skipped: number }>}
 */
export async function archiveCards(stream, cards, { date = sydneyDate(), root = REPO_ROOT } = {}) {
  const path = resolve(root, 'archive', stream, `${date.slice(0, 7)}.jsonl`);
  await mkdir(dirname(path), { recursive: true });

  const existing = new Set();
  for (const month of [previousMonth(date), date.slice(0, 7)]) {
    try {
      const text = await readFile(resolve(root, 'archive', stream, `${month}.jsonl`), 'utf-8');
      for (const line of text.split('\n')) {
        if (line.trim()) existing.add(JSON.parse(line).id);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const rows = [];
  for (const c of cards) {
    const id = createHash('sha1').update(`${stream}|${c.url || c.title}`).digest('hex').slice(0, 12);
    if (existing.has(id)) continue;
    existing.add(id);
    rows.push(JSON.stringify({
      id, date, stream,
      section: sectionLabel(c.section || ''),
      title:   c.title,
      summary: c.summary || '',
      source:  c.source || '',
      feed:    c.feed || '',
      url:     c.url || '',
    }));
  }
  if (rows.length) await appendFile(path, rows.join('\n') + '\n', 'utf-8');
  return { path, added: rows.length, skipped: cards.length - rows.length };
}
