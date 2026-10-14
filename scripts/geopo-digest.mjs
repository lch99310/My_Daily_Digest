#!/usr/bin/env node
// ============================================================================
// Daily Geopolitical Briefing — geopo-digest.mjs
// Fetches global news RSS feeds, uses DeepSeek to generate a
// geopolitical risk briefing in Traditional Chinese, delivers via Telegram.
// ============================================================================

import { writeFile } from 'fs/promises';
import { broadcastTelegram } from './lib/telegram.mjs';
import { generate } from './lib/deepseek.mjs';
import { selectArticles, formatArticleList, groundBriefing } from './lib/grounding.mjs';

const DEEPSEEK_API_KEY   = process.env.DEEPSEEK_API_KEY || '';
const BOT_TOKEN          = process.env.GEOPO_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID            = process.env.GEOPO_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID    = process.env.GEOPO_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!DEEPSEEK_API_KEY)   { console.error('ERROR: DEEPSEEK_API_KEY is required'); process.exit(1); }
if (!BOT_TOKEN)          { console.error('ERROR: GEOPO_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of GEOPO_TELEGRAM_CHAT_ID / GEOPO_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

// Answer budget for the non-thinking DeepSeek attempts; the thinking attempt
// gets lib/deepseek.mjs's larger THINKING_MAX_TOKENS. The 8-card briefing runs
// ~3,000 Chinese characters, well inside this.
const MAX_TOKENS  = 8500;
const OUTPUT_FILE = '/tmp/geopo-briefing.md';

// Minimum acceptable response length. A full briefing (8 cards: 5 China-adjacent
// + 3 global, plus gold summary) must be at least ~2000 chars; anything shorter
// means the model truncated or couldn't follow the format, so we reject it and
// move to the next DeepSeek attempt.
const MIN_CONTENT_LENGTH = 2000;

// A response must keep at least this many cards after grounding (cards that
// cite no real article are dropped). Fewer means the model ignored the
// article-number format or invented its cards — try the next DeepSeek attempt.
const MIN_GROUNDED_CARDS = 5;

// Prompt budget: newest first, at most PER_SOURCE items per feed.
const PROMPT_PER_SOURCE = 8;
const PROMPT_MAX_ITEMS  = 60;

const GROUNDING = {
  cardSections:   ['🔴', '🌍'],
  summarySection: '💡',
  fields:         ['標題', '摘要', '風險'],
};

// Free RSS feeds for geopolitical news — no API key needed.
//
// Feed sourcing rules (learned the hard way):
//   1. Prefer the publisher's native RSS over Google News wrappers.
//   2. Google News `allinurl:` queries were silently nerfed around 2026-05-28 —
//      they now return 0 items consistently. Use `site:` instead (still works),
//      or fall back to a keyword search like the 鳳凰軍事 entry.
//   3. Sources that return 0 for many consecutive runs get dropped, not kept
//      "just in case" — empty feeds add latency without adding signal.
const NEWS_FEEDS = [
  // General international news — native RSS
  { name: 'BBC World',          url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera',         url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'WSJ World',          url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
  { name: 'Financial Times',    url: 'https://www.ft.com/world?format=rss' },
  { name: 'Nikkei Asia',        url: 'https://asia.nikkei.com/rss/feed/nar' },
  { name: 'SCMP China',         url: 'https://www.scmp.com/rss/91/feed' },

  // No public native RSS (or it 404s/403s) — Google News with `site:` operator.
  // We previously used `allinurl:` here; Google nerfed that around 2026-05-28
  // and it now returns 0. `site:` still works as of this commit.
  { name: 'Bloomberg',          url: 'https://news.google.com/rss/search?q=when:24h+site:bloomberg.com&hl=en-US&gl=US&ceid=US:en' },
  { name: '讀賣新聞',            url: 'https://news.google.com/rss/search?q=when:24h+site:yomiuri.co.jp&hl=ja&gl=JP&ceid=JP:ja' },
  { name: '產經新聞',            url: 'https://news.google.com/rss/search?q=when:24h+site:sankei.com&hl=ja&gl=JP&ceid=JP:ja' },

  // Military / defense specialists
  { name: 'The War Zone',       url: 'https://www.twz.com/feed/' },
  { name: 'USNI News',          url: 'https://news.usni.org/feed' },
  { name: 'Defense One',        url: 'https://www.defenseone.com/rss/all/' },
  { name: '鳳凰軍事',            url: 'https://news.google.com/rss/search?q=when:24h+%E5%87%A4%E5%87%B0%E5%86%9B%E4%BA%8B&hl=zh-CN&gl=CN&ceid=CN:zh-Hans' },

  // Think tanks & official sources — direct RSS endpoints either 404 or
  // return Cloudflare 403s for non-browser User-Agents, so we proxy through
  // Google News `site:` queries instead. Lower fidelity (snippets, not full
  // titles) but reliably reachable.
  { name: 'CSIS',               url: 'https://news.google.com/rss/search?q=when:24h+site:csis.org&hl=en-US&gl=US&ceid=US:en' },
  { name: 'ISW',                url: 'https://news.google.com/rss/search?q=when:24h+site:understandingwar.org&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Crisis Group',       url: 'https://news.google.com/rss/search?q=when:24h+site:crisisgroup.org&hl=en-US&gl=US&ceid=US:en' },
  { name: '台灣國防部',          url: 'https://news.google.com/rss/search?q=when:24h+site:mnd.gov.tw&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },

  // Regional European / Australian coverage
  { name: 'Euronews',           url: 'https://www.euronews.com/rss' },
  { name: 'ABC News Australia', url: 'https://www.abc.net.au/news/feed/51120/rss.xml' },
];

// -- RSS parser (no npm) -----------------------------------------------------

function parseRSSItems(xml) {
  const items = [];
  // All four tag patterns accept optional attributes — Atom feeds routinely
  // write `<entry xml:base=...>`, `<title type="text">`, `<updated foo="bar">`
  // etc., and a bare `<entry>` regex silently misses every item. Nikkei Asia
  // is the recurring offender that surfaced this.
  const itemRe  = /<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/g;
  const titleRe = /<title(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const descRe  = /<(description|summary|content(?::[^>]*)?)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/;
  const linkRe  = /<link(?:\s[^>]*)?>([^<\s]+)<\/link>|<link[^>]+href="([^"]+)"/;
  // RSS 2.0 uses <pubDate>, Atom uses <published>/<updated>, Dublin Core uses <dc:date>.
  const dateRe  = /<(pubDate|published|updated|dc:date)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/;

  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (titleRe.exec(block)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    // descRe now captures the tag name in group 1 and content in group 2.
    const desc  = (descRe.exec(block)?.[2]  || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim().slice(0, 250);
    const lm    = linkRe.exec(block);
    const link  = (lm?.[1] || lm?.[2] || '').trim();
    const dm    = dateRe.exec(block);
    const pubDate = (dm?.[2] || '').trim();
    if (title && title.length > 8) items.push({ title, desc, link, pubDate });
  }
  return items;
}

async function fetchFeed({ name, url }) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; geopo-digest/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml   = await res.text();
    // Tag each item with its originating feed so we can (a) filter by source
    // and (b) show 來源 on every card so readers can judge credibility.
    const items = parseRSSItems(xml).map(it => ({ ...it, source: name }));
    console.log(`  ${name}: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`  ${name}: failed (${err.message})`);
    return [];
  }
}

// -- Prompt ------------------------------------------------------------------

// `articles` is the exact list numbered in the prompt; groundBriefing() later
// resolves the [#N] references in each card's 來源 against the same list.
function buildPrompt(articles) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const articleList = formatArticleList(articles);

  return `你是一位資深的地緣政治記者，正在為台灣讀者撰寫每日地緣政治風險簡報。今天是 ${today}。

## 過去 24 小時國際新聞（每則有素材編號 [#N] 與原始媒體來源）

${articleList}

## 撰寫要求

- **語言**：全文繁體中文，貼近台灣讀者的自然語感。專有名詞、人名、地名可保留英文或通用譯名。
- **風格**：模仿《晚點 LatePost》的報導風格——
  - 冷靜克制的記者筆法，不煽情、不用驚嘆號
  - 每則先講「發生什麼事」，再剖析「為什麼重要」
  - 強調事實、脈絡與連動關係，拒絕模糊形容詞
  - 句子俐落、資訊密度高
- **取材鐵則（最優先）**：每張卡片必須對應上方至少一則素材，摘要中的事實（國家、人物、地點、數字、日期、武器/艦艇名稱）只能來自該素材，不得用你自己的記憶或訓練資料補充事件或細節。「風險」欄位可以做分析推論，但前提必須是素材中的事實。各分區標示的是「最多」張數，素材不足就少寫，不得湊數。
- **來源欄位只填素材編號**：例如「來源：#12」或「來源：#12、#40」。系統會自動把編號換成媒體名稱與原文連結；沒有有效編號的卡片會被整張刪除。不要在其他欄位寫編號，也不要寫網址。同一則素材只能用在一張卡片。
- **資料取材**：要選擇對地緣風險影響大的事件（包含：軍事、經濟等會對地緣格局影響大的事件）。「💡 總結」與黃金理由只能談論本份簡報卡片中已出現的事件。
- **地理分區規則（嚴格遵守）**：
  - 🔴「中國周邊高風險地緣政治事件 (Top 5)」：**僅限**發生在地理上中國周邊區域的重大地緣風險事件，挑出最重要的前 5 則。所謂「中國周邊」指：台灣海峽、南海、東海、朝鮮半島、中印邊境、中亞鄰國、東南亞、日本、菲律賓等與中國地理上直接相鄰或密切關聯的區域。挑選順序以對區域安全格局影響的嚴重性與時效性排序，最重大的放第 1 則。
  - 🌍「全球其他重大地緣政治事件 (Top 3)」：**僅限**發生在地理上非中國周邊的其他地區的重大地緣風險事件。例如：中東、歐洲、非洲、美洲、南亞（不含中印邊境）等地區。
  - 請勿將兩個分區的事件混淆歸類。判斷標準是事件的**地理發生地點**，而非涉及的國家。


## 輸出格式（嚴格遵守，逐字照抄標籤，每張卡片 4 個欄位缺一不可）

每個分區先寫分區標題，接著重複卡片區塊（不超過該分區上限）；若該分區沒有對應素材，分區標題下只寫「本日無相關更新」。

🔴 中國周邊高風險地緣政治事件 (Top 5)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，說明事件背景與最新進展，100 至 150 字，晚點風格}
風險：{說明對區域安全或全球秩序的具體威脅，80 至 120 字}
來源：{引用的素材編號，例如 #12；綜合多則可寫 #12、#40}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{素材編號}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{素材編號}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{素材編號}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{素材編號}

🌍 全球其他重大地緣政治事件 (Top 3)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{素材編號}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{素材編號}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{素材編號}

💡 總結與黃金市場影響評估
快速總結：{2 至 3 句話，綜合分析今日整體地緣政治態勢，點出最關鍵的連動風險}

對黃金的影響：{從以下選一：極度利多（強烈看漲）／利多（看漲）／中性／利空（看跌）／極度利空（強烈看跌）}
• {看多或看空理由一，帶具體事件}
• {看多或看空理由二，帶具體事件}
• {看多或看空理由三，帶具體事件}

結論：{一句話總結黃金短中期走勢展望}
`;
}

// -- Telegram delivery -------------------------------------------------------
// Chunking, retries and chat+channel fan-out live in lib/telegram.mjs, shared
// with the other digests.

async function sendTelegram(text) {
  await broadcastTelegram({
    botToken: BOT_TOKEN,
    destinations: [
      { label: 'chat',    chatId: CHAT_ID },
      { label: 'channel', chatId: CHANNEL_CHAT_ID },
    ],
    text,
    // groundBriefing() emits HTML: each 來源 media name is the article link.
    // Previews off so the first link doesn't become a big card.
    extra: { parse_mode: 'HTML', disable_web_page_preview: true },
  });
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log('Fetching news feeds...');
  const results     = await Promise.allSettled(NEWS_FEEDS.map(fetchFeed));
  const allArticles = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Deduplicate by first 40 chars of title
  const seen   = new Set();
  const unique = allArticles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Collected ${unique.length} unique articles`);

  // Hard 24-hour window: every article fed into the briefing must have been
  // published within the last 24 hours relative to this run. Items without a
  // parseable pubDate are dropped — we can't prove freshness, so we exclude
  // them rather than risk shipping stale news.
  const LOOKBACK_HOURS = 24;
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const fresh = unique.filter(a => {
    if (!a.pubDate) return false;
    const t = new Date(a.pubDate).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  console.log(`Within last ${LOOKBACK_HOURS}h: ${fresh.length} articles`);

  if (fresh.length < 3) {
    throw new Error(`Only ${fresh.length} articles within the last ${LOOKBACK_HOURS}h — not enough to generate briefing`);
  }

  // Sort newest first so the most recent items land at the top of the prompt
  fresh.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());

  const articles = selectArticles(fresh, { perSource: PROMPT_PER_SOURCE, max: PROMPT_MAX_ITEMS });
  console.log(`Prompt articles: ${articles.length} (≤${PROMPT_PER_SOURCE} per source)`);

  const prompt = buildPrompt(articles);

  // Every answer goes through grounding: cards that cite no real
  // article number are dropped, 來源 becomes media name + original link.
  const accept = raw => {
    const unfenced = raw.replace(/^```[\w]*\s*/i, '').replace(/```$/i, '').trim();
    const { text, kept, dropped } = groundBriefing(unfenced, articles, GROUNDING);
    for (const d of dropped) console.warn(`  dropped card — ${d}`);
    if (kept < MIN_GROUNDED_CARDS) {
      throw new Error(`only ${kept} grounded cards (${dropped.length} dropped), need ≥${MIN_GROUNDED_CARDS}`);
    }
    console.log(`  grounded: kept ${kept} cards, dropped ${dropped.length}`);
    return text;
  };

  const briefing = await generate(prompt, {
    apiKey: DEEPSEEK_API_KEY,
    answerTokens: MAX_TOKENS, minContentLength: MIN_CONTENT_LENGTH, accept,
  });

  await writeFile(OUTPUT_FILE, briefing, 'utf-8');
  console.log(`Briefing written to ${OUTPUT_FILE} (${briefing.length} chars)`);

  await sendTelegram(briefing);
  console.log('Delivered to Telegram successfully');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
