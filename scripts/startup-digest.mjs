#!/usr/bin/env node
// ============================================================================
// Weekly Australian startup funding + government grant digest.
//
// Sunday 6am Sydney. Pulls the past week's funding news, asks DeepSeek to
// extract one record per deal, then checks every field against the article
// text (lib/startup-grounding.mjs) before anything ships. A second call picks,
// per company, which of the past year's headlines are about that company; it
// can only choose numbered headlines, so it cannot add events.
//
// Sources (all fetched by code, verified reachable 2026-11-19):
//   Startup Daily funding feed  — per-deal stories, incl. NSW grant rounds
//   SmartCompany startups feed  — the weekly "N startups that raised" wrap
//   Google News AU               — catches what the two miss; grant news
// GrantConnect (grants.gov.au) refuses scripted requests (CloudFront 403), so
// grants come from news coverage for now.
//
// Output: Telegram (AI digest chat), archive/startup/YYYY-MM.jsonl.
// ============================================================================

import { writeFile } from 'fs/promises';
import { generate } from './lib/deepseek.mjs';
import { archiveCards, sydneyDate } from './lib/archive.mjs';
import { fetchFeed, dedupeByTitle, filterByAge, sortByDateDesc } from './lib/rss.mjs';
import { groundDeals, groundTimeline, NOT_STATED } from './lib/startup-grounding.mjs';
import { broadcastTelegram } from './lib/telegram.mjs';

const OUTPUT_FILE = '/tmp/startup-digest.html';
const DELIVER = process.env.DELIVER !== 'false';
const WINDOW_HOURS = 7 * 24 + 12;   // a week plus slack for late-stamped feeds
const MAX_ARTICLES = 40;
const BODY_CHARS = 2500;
const ROUNDUP_BODY_CHARS = 7000;    // the weekly wraps carry several deals each
const MAX_TIMELINE_COMPANIES = 15;
const MAX_TIMELINE_CANDIDATES = 12;

const gn = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-AU&gl=AU&ceid=AU:en`;

export const FEEDS = [
  { name: 'Startup Daily', url: 'https://www.startupdaily.net/topic/funding/feed/', body: true },
  { name: 'SmartCompany',  url: 'https://www.smartcompany.com.au/startupsmart/feed/', body: true },
  { name: 'Google News 融資', url: gn('when:7d (raises OR "seed round" OR "pre-seed" OR "Series A" OR "Series B" OR "Series C") (Australian OR Sydney OR Melbourne OR Brisbane) startup') },
  { name: 'Google News 補助', url: gn('when:7d (grant OR grants OR "Industry Growth Program" OR "MVP Ventures" OR "CRC-P") (startup OR startups OR scaleup) Australia') },
];

// -- Fetching ----------------------------------------------------------------

const decode = s => s.replace(/&#8217;|&#8216;|&#039;|&apos;|[‘’]/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"')
  .replace(/&#8211;|&#8212;/g, '-').replace(/&#038;|&amp;/g, '&');

/** Google News titles end in " - Publisher"; split it off. Decode entities so dedupe sees one title. */
function splitPublisher(item) {
  const title = decode(item.title);
  if (!item.source.startsWith('Google News')) return { ...item, title, publisher: item.source };
  const m = title.match(/^(.*) - ([^-]{2,60})$/);
  return m ? { ...item, title: m[1].trim(), publisher: m[2].trim() } : { ...item, title, publisher: '' };
}

// Grant searches mostly return open calls for applications, not awards.
const NOISE_PUBLISHERS = /fundsforngos|grants and resources for sustainability|opportunity desk|tracxn/i;
const NOISE_TITLES = /\b(call for|apply now|applications?:|request for|rfps?\b|submit applications|deadline|how to apply)/i;
const isNoise = a => NOISE_PUBLISHERS.test(`${a.publisher} ${a.title}`) || NOISE_TITLES.test(a.title);

/** Paragraph text of an article page, or '' when it cannot be read. */
export function extractBody(html, maxChars) {
  const clean = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
  const paras = [...clean.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '')
      .replace(/&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;|&#8212;/g, '-')
      .replace(/&#038;|&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 60 && /[.!?]["')]?(\s|$)/.test(p)   // sentences, not menus
      && !/^(By continuing|Subscribe|Sign up|Create a free account)/i.test(p))
    .map(p => p.replace(/^Prefer (Startup Daily|SmartCompany)\s*/, ''));
  return paras.join('\n').slice(0, maxChars);
}

async function fetchBody(url, maxChars) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; startup-digest/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return extractBody(await res.text(), maxChars);
  } catch (err) {
    console.warn(`  body ${url.slice(0, 80)}: ${err.message}`);
    return '';
  }
}

export async function collectArticles() {
  const stats = {};
  const all = [];
  for (const feed of FEEDS) {
    const items = filterByAge(await fetchFeed({ ...feed, ua: 'startup-digest/1.0' }), WINDOW_HOURS)
      .map(it => ({ ...splitPublisher(it), wantBody: !!feed.body }))
      .filter(a => !isNoise(a));
    stats[feed.name] = items.length;
    all.push(...items);
  }
  // Direct feeds first so their copy (which has a readable body) wins the dedupe.
  const articles = dedupeByTitle(sortByDateDesc(all).sort((a, b) => b.wantBody - a.wantBody))
    .slice(0, MAX_ARTICLES);
  for (const a of articles) {
    if (!a.wantBody || !a.link) continue;
    const roundup = /startups? (that )?raised|cheque-in/i.test(a.title);
    a.body = await fetchBody(a.link.replace(/&amp;/g, '&'), roundup ? ROUNDUP_BODY_CHARS : BODY_CHARS);
  }
  stats.bodies = articles.filter(a => a.body).length;
  return { articles, stats };
}

// -- Extraction --------------------------------------------------------------

function extractionPrompt(articles) {
  const list = articles.map((a, i) =>
    `[#${i + 1}] (${a.publisher || a.source}, ${a.pubDate.slice(0, 16)}) ${a.title}` +
    (a.desc && a.desc !== a.title ? `\n摘要: ${a.desc}` : '') +
    (a.body ? `\n內文:\n${a.body}` : '')).join('\n\n');

  return `你負責從下列新聞中抽取「澳洲新創的融資與政府補助」，只抽取，不分析，不補充。

## 新聞（每篇有編號 [#N]）
${list}

## 收錄
- 總部在澳洲的新創或 scaleup：股權融資（pre-seed 到 Series D）、創投債（kind=debt）、政府補助或政府基金投資（kind=grant）。
- 一篇彙整文（例如「Six startups that raised…」）裡的每一家，各自一筆。

## 不收
- 紐西蘭或其他國家總部的公司；ASX 上市公司的配股增資；收購、裁員、產品發表等非融資新聞。

## 每個欄位的規則（違反的欄位會被程式清空，整筆沒有編號會被丟棄）
- refs：這筆資料出現在哪幾篇，填編號數字。
- company：公司名，照原文拼法。
- city：原文寫的城市（英文，照原文）。原文沒寫就填空字串，不要從公司背景推測。
- round：照原文，例如 "Seed"、"Series A extension"。
- amount：照原文的幣別與數字，例如 "A$5.6 million"、"US$290 million"。不要換算。
- investors：原文點名的投資方，照原文拼法；補助則填出資的政府機關或基金。
- program：補助計畫名稱（只有 grant 才填），照原文。
- what_quote：從原文**逐字複製**一句英文，說明這家公司做什麼（至少 20 個字元）。
- what_zh：根據 what_quote 和同篇原文，用繁體中文三句話寫：解決什麼問題、賣給誰、怎麼做到。新創的東西往往前衛，第一次出現的專有名詞用括號加一句白話解釋。只能寫原文有的內容。
- use_quote：從原文**逐字複製**說明資金用途的英文句子；原文沒寫就填空字串。
- use_zh：use_quote 的繁體中文說明；原文沒寫就填空字串。
- 原文沒有的資訊一律留空字串，不要寫「未知」，也不要用你自己的知識補。

## 輸出
只輸出 JSON：
{"deals":[{"refs":[1],"company":"","kind":"equity","city":"","round":"","amount":"","investors":[],"program":"","what_quote":"","what_zh":"","use_quote":"","use_zh":""}]}
沒有符合的新聞就輸出 {"deals":[]}。`;
}

function parseJson(raw) {
  return JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim());
}

async function extractDeals(articles) {
  if (articles.length === 0) return [];
  const raw = await generate(extractionPrompt(articles), {
    answerTokens: 8000, minContentLength: 10, responseFormat: 'json', accept: r => { parseJson(r); return r; },
  });
  return parseJson(raw).deals || [];
}

// -- Timeline ----------------------------------------------------------------

/**
 * Past-year headlines naming the company, older than this week's window so the
 * same raise reported by other outlets does not show up as "history".
 */
async function timelineCandidates(deals, now = Date.now()) {
  const cutoff = now - WINDOW_HOURS * 3600_000;
  const out = {};
  for (const d of deals.slice(0, MAX_TIMELINE_COMPANIES)) {
    const items = await fetchFeed({ name: `Google News ${d.company}`, url: gn(`"${d.company}" when:1y`), ua: 'startup-digest/1.0' });
    out[d.company] = dedupeByTitle(sortByDateDesc(items.map(splitPublisher)))
      .filter(it => it.title.toLowerCase().includes(d.company.toLowerCase()))
      .filter(it => new Date(it.pubDate).getTime() < cutoff)
      .slice(0, MAX_TIMELINE_CANDIDATES);
  }
  return out;
}

function timelinePrompt(deals, candidates) {
  const blocks = deals.filter(d => candidates[d.company]?.length).map(d => {
    const list = candidates[d.company]
      .map((it, i) => `  ${i + 1}. (${sydneyDate(new Date(it.pubDate))}) ${it.title} — ${it.publisher}`).join('\n');
    return `### ${d.company}\n這家公司：${d.what !== NOT_STATED ? d.what : d.what_quote || '（無描述）'}\n候選新聞：\n${list}`;
  }).join('\n\n');

  return `下面每家公司各有一組過去一年的新聞標題。請挑出**確定是在講這家公司**的標題（同名的其他公司、產品或一般名詞都不要），每家最多 5 則，並為每則寫一句繁體中文翻譯。只能挑編號，不得新增事件。

${blocks}

只輸出 JSON：{"公司名":[{"n":1,"zh":"一句中文"}]}；某家公司沒有符合的就給空陣列。`;
}

async function buildTimelines(deals) {
  const candidates = await timelineCandidates(deals);
  if (!Object.values(candidates).some(l => l.length)) return {};
  try {
    const raw = await generate(timelinePrompt(deals, candidates), {
      answerTokens: 4000, minContentLength: 2, responseFormat: 'json', accept: r => { parseJson(r); return r; },
    });
    return groundTimeline(parseJson(raw), candidates);
  } catch (err) {
    console.warn(`Timeline step failed, cards ship without it: ${err.message}`);
    return {};
  }
}

// -- Rendering ---------------------------------------------------------------

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (url, text) => `<a href="${esc(url.replace(/&amp;/g, '&'))}">${esc(text)}</a>`;
const SEP = '━━━━━━━━━━━━━━━━━━━━';
const isSydney = d => /sydney|nsw|new south wales/i.test(d.city);

export function cardTitle(d) {
  const where = d.city !== NOT_STATED ? `[${d.city}] ` : '';
  if (d.kind === 'grant') {
    const what = [d.program || '政府補助', d.amount !== NOT_STATED ? d.amount : ''].filter(Boolean).join(' ');
    return `🏛️ 政府補助｜${where}${d.company} 獲 ${what}`;
  }
  const what = [d.round !== NOT_STATED ? d.round : '融資', d.amount !== NOT_STATED ? d.amount : '']
    .filter(Boolean).join(' ');
  return `🚀 新創融資｜${where}${d.company}${d.kind === 'debt' ? '（債）' : ''} ${what}`;
}

function renderCard(d, articles, timeline) {
  const cited = d.refs.map(n => articles[n - 1]);
  const lines = [SEP, `<b>${esc(cardTitle(d))}</b>`, `• 做什麼：${esc(d.what)}`];
  if (d.kind !== 'grant') lines.push(`• 投資方：${esc(d.investors.length ? d.investors.join('、') : NOT_STATED)}`);
  else lines.push(`• 出資方：${esc(d.investors.length ? d.investors.join('、') : NOT_STATED)}`);
  lines.push(`• 資金用途：${esc(d.use)}`);
  if (timeline?.length) {
    lines.push('• 近一年：');
    for (const t of timeline) lines.push(`   ${sydneyDate(new Date(t.pubDate))}｜${link(t.link, t.zh || t.title)}（${esc(t.publisher || '原文')}）`);
  } else {
    lines.push('• 近一年：本週以前的新聞中找不到這家公司的其他報導');
  }
  lines.push(`• 宣布：${esc(sydneyDate(new Date(cited[0].pubDate)))}`);
  lines.push(`• 來源：${cited.slice(0, 3).map(a => link(a.link, a.publisher || a.source)).join('、')}`);
  return lines.join('\n');
}

function weekRange(today) {
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end.getTime() - 6 * 86400_000);
  const f = d => d.toISOString().slice(5, 10).replace('-', '/');
  return `${f(start)}–${f(end)}`;
}

export function renderDigest({ deals, articles, timelines, stats, grounding, today }) {
  const sorted = [...deals].sort((a, b) => isSydney(b) - isSydney(a) || (a.kind === 'grant') - (b.kind === 'grant'));
  const grants = deals.filter(d => d.kind === 'grant').length;
  const out = [
    `<b>🚀 新創融資｜週報 ${weekRange(today)}</b>`,
    `本週 ${deals.length - grants} 筆融資、${grants} 筆補助（雪梨 ${deals.filter(isSydney).length}）` +
      (grounding.dc.length ? `· 數據中心相關 ${grounding.dc.length} 筆留給 DC 簡報` : ''),
    '',
  ];
  if (deals.length === 0) out.push('本週沒有通過原文比對的融資或補助。');
  for (const d of sorted) out.push(renderCard(d, articles, timelines[d.company]), '');

  const feeds = FEEDS.map(f => `${f.name} ${stats[f.name] ?? 0}`).join(' · ');
  out.push(SEP,
    `<i>抓取：${esc(feeds)} 則；讀到內文 ${stats.bodies} 篇</i>`,
    `<i>模型提出 ${grounding.proposed} 筆 → 保留 ${deals.length}，丟棄 ${grounding.dropped.length}` +
      (grounding.dropped.length ? `（${esc(grounding.dropped.slice(0, 4).join('；'))}）` : '') +
      `；欄位因比對不到原文而清空 ${grounding.cleared.length} 處</i>`,
    '<i>所有欄位都已和原文比對；「未載明」= 原文沒寫或比對不到，不是推測。</i>');
  return out.join('\n');
}

// -- Archive -----------------------------------------------------------------

function archiveCard(d, articles, timeline) {
  const cited = d.refs.map(n => articles[n - 1]);
  return {
    section: d.kind === 'grant' ? '政府補助' : '新創融資',
    title: cardTitle(d),
    summary: d.what,
    source: cited[0].publisher || cited[0].source,
    feed: cited[0].source,
    url: (cited[0].link || '').replace(/&amp;/g, '&'),
    extra: {
      company: d.company, kind: d.kind, city: d.city, round: d.round, amount: d.amount,
      investors: d.investors, program: d.program, use_of_funds: d.use,
      what_quote: d.what_quote, use_quote: d.use_quote,
      announced: sydneyDate(new Date(cited[0].pubDate)),
      sources: cited.map(a => ({ source: a.publisher || a.source, url: (a.link || '').replace(/&amp;/g, '&') })),
      timeline: (timeline || []).map(t => ({
        date: sydneyDate(new Date(t.pubDate)), title: t.title, zh: t.zh, source: t.publisher,
        url: (t.link || '').replace(/&amp;/g, '&'),
      })),
    },
  };
}

// -- Main --------------------------------------------------------------------

async function main() {
  const today = sydneyDate();
  console.log('Fetching feeds...');
  const { articles, stats } = await collectArticles();
  console.log(`${articles.length} articles in window, ${stats.bodies} with body text`);

  const proposed = await extractDeals(articles);
  const grounding = { ...groundDeals(proposed, articles), proposed: proposed.length };
  console.log(`Model proposed ${proposed.length}; kept ${grounding.kept.length}`);
  for (const r of grounding.dropped) console.log(`  dropped: ${r}`);
  for (const r of grounding.cleared) console.log(`  cleared: ${r}`);
  if (grounding.dc.length) console.log(`  to DC briefing: ${grounding.dc.join(', ')}`);

  const timelines = await buildTimelines(grounding.kept);
  const text = renderDigest({ deals: grounding.kept, articles, timelines, stats, grounding, today });
  await writeFile(OUTPUT_FILE, text, 'utf-8');

  const archived = await archiveCards('startup',
    grounding.kept.map(d => archiveCard(d, articles, timelines[d.company])), { date: today });
  console.log(`Archived ${archived.added} cards to ${archived.path}`);

  if (!DELIVER) { console.log('DELIVER=false — not sending.'); return; }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { console.log('No TELEGRAM_BOT_TOKEN — not sending.'); return; }
  await broadcastTelegram({
    botToken,
    destinations: [{ label: 'ai-chat', chatId: process.env.TELEGRAM_CHAT_ID }],
    text,
    extra: { parse_mode: 'HTML', disable_web_page_preview: true },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
}
