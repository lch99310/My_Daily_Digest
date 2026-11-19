#!/usr/bin/env node
// ============================================================================
// Monthly VC portfolio diff — no model involved.
//
// Fetches each Australian VC's portfolio page, pulls the company slugs out of
// the links with a fixed pattern, and compares them with last month's
// snapshot (archive/startup/vc-portfolio.json). A company that newly appears
// is often a round that was never announced in the press.
//
// Names come only from the page's own links, so nothing can be invented. A
// page whose count falls below half of last month's is treated as a failed
// fetch (redesign, block), not as a mass exit: its snapshot is kept and the
// digest says so.
//
// Checked 2026-11-19: the six below return server-rendered links. Not
// included: Folklore (links go straight to company sites), Antler (no AU
// list), Tidal (domain parked), Rampersand (redirects off the page).
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { archiveCards, sydneyDate } from './lib/archive.mjs';
import { broadcastTelegram } from './lib/telegram.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = resolve(REPO_ROOT, 'archive/startup/vc-portfolio.json');
const OUTPUT_FILE = '/tmp/vc-portfolio.html';
const DELIVER = process.env.DELIVER !== 'false';

export const VCS = [
  { name: 'Blackbird',     url: 'https://www.blackbird.vc/portfolio',       path: '/portfolio/' },
  { name: 'Square Peg',    url: 'https://www.squarepeg.vc/portfolio',       path: '/portfolio/' },
  { name: 'AirTree',       url: 'https://www.airtree.vc/portfolio',         path: '/companies/' },
  { name: 'Main Sequence', url: 'https://www.mseq.vc/all-companies',        path: '/portfolio/' },
  { name: 'Investible',    url: 'https://www.investible.com/portfolio',     path: '/company/' },
  { name: 'OIF Ventures',  url: 'https://www.oifventures.com.au/portfolio', path: '/portfolio/' },
];

const origin = url => new URL(url).origin;

const pretty = slug => slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Company slugs linked as href="<path><slug>" (relative or absolute on the same site). */
export function slugsFrom(html, path, site = '') {
  const re = new RegExp(`href="(?:${site.replace(/[.]/g, '\\.')})?${path}([a-z0-9-]+)/?"`, 'g');
  return [...new Set([...html.matchAll(re)].map(m => m[1]))].sort();
}

async function fetchSlugs(vc) {
  try {
    const res = await fetch(vc.url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; vc-portfolio/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return slugsFrom(await res.text(), vc.path, origin(vc.url));
  } catch (err) {
    console.warn(`  ${vc.name}: ${err.message}`);
    return [];
  }
}

/**
 * Compare this month's slugs with the snapshot.
 * @returns {{ added: string[], removed: string[], status: 'baseline'|'ok'|'failed' }}
 */
export function diffPortfolio(previous, current) {
  if (!previous || previous.length === 0) return { added: [], removed: [], status: current.length ? 'baseline' : 'failed' };
  if (current.length < previous.length * 0.5) return { added: [], removed: [], status: 'failed' };
  const before = new Set(previous);
  const now = new Set(current);
  return {
    added: current.filter(s => !before.has(s)),
    removed: previous.filter(s => !now.has(s)),
    status: 'ok',
  };
}

async function main() {
  const today = sydneyDate();
  let snapshot = {};
  try { snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf-8')); } catch { /* first run */ }

  const lines = [`<b>🚀 新創融資｜VC 投資組合變動 ${today.slice(0, 7)}</b>`, ''];
  const cards = [];
  const status = [];

  for (const vc of VCS) {
    const current = await fetchSlugs(vc);
    const prev = snapshot[vc.name]?.slugs;
    const diff = diffPortfolio(prev, current);
    status.push(`${vc.name} ${current.length}` + (diff.status === 'failed' ? '（抓取異常，沿用上月名單）' : diff.status === 'baseline' ? '（首次建檔）' : ''));
    if (diff.status !== 'failed') snapshot[vc.name] = { fetched: today, slugs: current };

    for (const slug of diff.added) {
      const page = `${origin(vc.url)}${vc.path}${slug}`;
      lines.push(`• ${esc(vc.name)}：<a href="${esc(page)}">${esc(pretty(slug))}</a>`);
      cards.push({
        section: 'VC 新進投資組合',
        title: `🚀 新創融資｜VC 新進投資組合｜${vc.name}：${pretty(slug)}`,
        summary: `${vc.name} 投資組合頁面本月新出現 ${pretty(slug)}，上月名單沒有。是否為新一輪融資需另行查證。`,
        source: vc.name, feed: 'vc-portfolio', url: page,
        extra: { company: pretty(slug), slug, vc: vc.name, kind: 'portfolio-add' },
      });
    }
    if (diff.removed.length) lines.push(`• ${esc(vc.name)} 名單移除：${esc(diff.removed.map(pretty).join('、'))}`);
  }

  if (cards.length === 0) lines.push('本月各 VC 投資組合沒有新增公司（或首次建檔）。');
  lines.push('', `<i>抓取：${esc(status.join(' · '))} 家。名單直接取自 VC 網頁連結，未經模型處理。</i>`);
  const text = lines.join('\n');
  await writeFile(OUTPUT_FILE, text, 'utf-8');

  await mkdir(dirname(SNAPSHOT), { recursive: true });
  await writeFile(SNAPSHOT, JSON.stringify(snapshot, null, 1) + '\n', 'utf-8');
  const archived = await archiveCards('startup', cards, { date: today });
  console.log(`${status.join(' | ')}\nArchived ${archived.added} portfolio cards`);

  if (!DELIVER || !process.env.TELEGRAM_BOT_TOKEN) { console.log('Not sending.'); return; }
  await broadcastTelegram({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    destinations: [{ label: 'ai-chat', chatId: process.env.TELEGRAM_CHAT_ID }],
    text,
    extra: { parse_mode: 'HTML', disable_web_page_preview: true },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
}
