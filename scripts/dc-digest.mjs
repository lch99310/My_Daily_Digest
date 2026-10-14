#!/usr/bin/env node
// ============================================================================
// Daily Data Center Briefing — dc-digest.mjs
// Fetches data center industry RSS feeds, uses DeepSeek to generate a
// briefing in Traditional Chinese, delivers via Telegram.
// ============================================================================

import { writeFile } from 'fs/promises';
import { broadcastTelegram } from './lib/telegram.mjs';
import { generate } from './lib/deepseek.mjs';
import { selectArticles, formatArticleList, groundBriefing } from './lib/grounding.mjs';

const DEEPSEEK_API_KEY   = process.env.DEEPSEEK_API_KEY || '';
const BOT_TOKEN          = process.env.DC_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID            = process.env.DC_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID    = process.env.DC_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!DEEPSEEK_API_KEY)   { console.error('ERROR: DEEPSEEK_API_KEY is required'); process.exit(1); }
if (!BOT_TOKEN)          { console.error('ERROR: DC_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of DC_TELEGRAM_CHAT_ID / DC_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

// Answer budget for the non-thinking DeepSeek attempts; the thinking attempt
// gets lib/deepseek.mjs's larger THINKING_MAX_TOKENS.
const MAX_TOKENS  = 8500;
const OUTPUT_FILE = '/tmp/dc-briefing.md';

// Minimum acceptable response length. Section limits are maximums now (the
// model writes fewer cards rather than padding a thin day), so this only
// catches truncated or off-format output.
const MIN_CONTENT_LENGTH = 1500;

// A response must keep at least this many cards after grounding (cards that
// cite no real article are dropped). Fewer means the model ignored the
// article-number format or invented most of its cards — try the next DeepSeek attempt.
const MIN_GROUNDED_CARDS = 4;

// Prompt budget: at most PER_SOURCE items per feed so DC Post / DCK / the
// hyperscaler trackers can't push the small Australia and ByteDance feeds out.
const PROMPT_PER_SOURCE = 10;
const PROMPT_MAX_ITEMS  = 120;

const GROUNDING = {
  cardSections:   ['🏗', '🇦🇺', '🌐', '⚡', '🔥'],
  summarySection: '💡',
  fields:         ['標題', '摘要', '影響'],
};

// Data center industry RSS feeds — no API key needed
const NEWS_FEEDS = [
  // Industry-wide sources
  { name: 'DCD',          url: 'https://www.datacenterdynamics.com/en/atom/' },
  { name: 'DCK',          url: 'https://www.datacenterknowledge.com/rss.xml' },
  { name: 'TechDay Asia', url: 'https://datacenternews.asia/feed' },
  { name: 'DC Post',      url: 'https://datacenterpost.com/feed/' },

  // Hyperscaler trackers — global English locale to catch worldwide
  // hyperscaler moves (PPAs, nuclear deals, region expansions). These
  // feed the cross-region "hyperscaler ≥3 stories/day" rule and the
  // AI×Energy card.
  { name: 'AWS Infra',          url: 'https://news.google.com/rss/search?q=when:24h+%22AWS%22+(%22data+center%22+OR+%22data+centre%22+OR+PPA+OR+nuclear+OR+Susquehanna)&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Microsoft Infra',    url: 'https://news.google.com/rss/search?q=when:24h+%22Microsoft%22+(%22data+center%22+OR+%22data+centre%22+OR+PPA+OR+%22Three+Mile+Island%22+OR+Helion)&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google Cloud Infra', url: 'https://news.google.com/rss/search?q=when:24h+%22Google%22+(%22data+center%22+OR+%22data+centre%22+OR+PPA+OR+Kairos+OR+SMR+OR+%2224%2F7+CFE%22)&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Meta Infra',         url: 'https://news.google.com/rss/search?q=when:24h+%22Meta%22+(%22data+center%22+OR+%22data+centre%22+OR+Llama+OR+Hyperion+OR+PPA)&hl=en-US&gl=US&ceid=US:en' },

  // ByteDance tracker — feeds the 🔥 Bytedance / TikTok card. Without it the
  // card only had whatever the industry feeds happened to carry that day.
  { name: 'ByteDance Infra',    url: 'https://news.google.com/rss/search?q=when:24h+(ByteDance+OR+TikTok+OR+Douyin+OR+Volcano+Engine)+(%22data+center%22+OR+%22data+centre%22+OR+datacenter+OR+GPU+OR+%22AI+chips%22+OR+%22AI+infrastructure%22)&hl=en-US&gl=US&ceid=US:en' },

  // Australia-focused company trackers — Google News RSS proxy (AU locale).
  // These surface both corporate press releases and media coverage, so a
  // single feed per company captures most 24-hour signal without needing
  // to scrape each corporate site (many block bot fetches).
  { name: 'NEXTDC',             url: 'https://news.google.com/rss/search?q=when:24h+%22NEXTDC%22&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'AirTrunk',           url: 'https://news.google.com/rss/search?q=when:24h+%22AirTrunk%22&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'DCI Data Centers',   url: 'https://news.google.com/rss/search?q=when:24h+%22DCI+Data+Centers%22&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Equinix AU',         url: 'https://news.google.com/rss/search?q=when:24h+%22Equinix%22+Australia&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Digital Realty AU',  url: 'https://news.google.com/rss/search?q=when:24h+%22Digital+Realty%22+Australia&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Global Switch',      url: 'https://news.google.com/rss/search?q=when:24h+%22Global+Switch%22&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Goodman Group',      url: 'https://news.google.com/rss/search?q=when:24h+%22Goodman+Group%22+%22data+centre%22&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Macquarie Tech',     url: 'https://news.google.com/rss/search?q=when:24h+%22Macquarie+Technology+Group%22&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Vocus',              url: 'https://news.google.com/rss/search?q=when:24h+%22Vocus%22+Australia&hl=en-AU&gl=AU&ceid=AU:en' },

  // Tier 1 — emerging AU operators + sovereign DC track
  { name: 'Firmus',             url: 'https://news.google.com/rss/search?q=when:24h+%22Firmus%22+(%22data+centre%22+OR+%22data+center%22+OR+%22AI+factory%22+OR+Tasmania+OR+Soluna)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'CDC Data Centres',   url: 'https://news.google.com/rss/search?q=when:24h+%22CDC+Data+Centres%22&hl=en-AU&gl=AU&ceid=AU:en' },

  // Tier 1 — AU sustainability rating + NSW power infrastructure
  { name: 'NABERS DC',          url: 'https://news.google.com/rss/search?q=when:24h+NABERS+(%22data+centre%22+OR+%22data+center%22)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'NSW REZ',            url: 'https://news.google.com/rss/search?q=when:24h+%22Renewable+Energy+Zone%22+NSW&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Ausgrid',            url: 'https://news.google.com/rss/search?q=when:24h+%22Ausgrid%22+(%22data+centre%22+OR+%22data+center%22+OR+%22grid+connection%22+OR+substation)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Endeavour Energy',   url: 'https://news.google.com/rss/search?q=when:24h+%22Endeavour+Energy%22+(%22data+centre%22+OR+%22data+center%22+OR+%22grid+connection%22)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'WS Aerotropolis',    url: 'https://news.google.com/rss/search?q=when:24h+%22Western+Sydney+Aerotropolis%22+(%22data+centre%22+OR+%22data+center%22+OR+digital+OR+infrastructure)&hl=en-AU&gl=AU&ceid=AU:en' },

  // AU energy regulator/operator — DC power supply, large-load connections,
  // ISP updates. AEMC (rule maker) and AEMO (operator) both block bot
  // access on their sites, so we ride on media coverage via Google News.
  { name: 'AEMC',               url: 'https://news.google.com/rss/search?q=when:24h+(AEMC+OR+%22Australian+Energy+Market+Commission%22)+(%22data+centre%22+OR+%22data+center%22)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'AEMO',               url: 'https://news.google.com/rss/search?q=when:24h+(AEMO+OR+%22Australian+Energy+Market+Operator%22)+(%22data+centre%22+OR+%22data+center%22)&hl=en-AU&gl=AU&ceid=AU:en' },

  // Tier 2 — AU energy x DC intersection (PPA counterparties, firming, coal phase-out)
  { name: 'Snowy Hydro',        url: 'https://news.google.com/rss/search?q=when:24h+(%22Snowy+2.0%22+OR+%22Snowy+Hydro%22)+(%22pumped+hydro%22+OR+grid+OR+NEM+OR+delay)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Spark Renewables',   url: 'https://news.google.com/rss/search?q=when:24h+%22Spark+Renewables%22&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'Climate Active',     url: 'https://news.google.com/rss/search?q=when:24h+%22Climate+Active%22+(%22data+centre%22+OR+%22data+center%22+OR+certification)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'AU Coal Phase-out',  url: 'https://news.google.com/rss/search?q=when:24h+(%22Eraring%22+OR+%22Liddell%22+OR+%22Bayswater%22)+(closure+OR+retirement+OR+extension+OR+grid)&hl=en-AU&gl=AU&ceid=AU:en' },

  // Tier 3 — global PPA/regulatory trend signals
  { name: 'BloombergNEF PPA',   url: 'https://news.google.com/rss/search?q=when:24h+%22BloombergNEF%22+(%22corporate+PPA%22+OR+PPA+OR+renewable)&hl=en-US&gl=US&ceid=US:en' },
  { name: 'FERC DC',            url: 'https://news.google.com/rss/search?q=when:24h+FERC+(%22behind+the+meter%22+OR+%22co-location%22+OR+hyperscaler+OR+%22data+center%22)&hl=en-US&gl=US&ceid=US:en' },
];

// -- RSS parser (no npm) -----------------------------------------------------

function parseRSSItems(xml) {
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

async function fetchFeed({ name, url }) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dc-digest/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml   = await res.text();
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

  const card = (summaryHint = '2 至 3 句話，100 至 150 字', impactHint = '80 至 120 字') => `━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{${summaryHint}}
影響：{${impactHint}}
來源：{引用的素材編號，例如 #12；綜合多則可寫 #12、#40}`;

  return `你是一位資深的資料中心產業分析師，正在為台灣讀者撰寫每日資料中心產業簡報。今天是 ${today}。

## 過去 24 小時資料中心產業新聞（每則有素材編號 [#N] 與原始媒體來源）

${articleList}

## 取材鐵則（最優先，違反即視為錯誤輸出）

- **只寫上方素材裡的事**：每張卡片必須對應上方至少一則素材，摘要與影響中的事實（公司、地點、金額、容量、日期、人名、政策名稱）只能來自該素材。不得使用你自己的記憶或訓練資料補充任何事件，也不得添加素材中沒有的數字或細節。
- **寧缺勿濫**：各分區標示的是「最多」張數，不是必須寫滿。素材不足就少寫；某分區完全沒有對應素材，就只寫「本日無相關更新」。湊數或編造的卡片會被系統刪除。
- **來源欄位只填素材編號**：例如「來源：#12」或「來源：#12、#40」。系統會自動把編號換成媒體名稱與原文連結；沒有有效編號的卡片會被整張刪除。不要在其他欄位寫編號，也不要寫網址。
- **同一則素材只能用在一張卡片**，不得重複。
- 「💡 總結」只能談論本份簡報卡片中已出現的事件。

## 撰寫要求

- **語言**：全文繁體中文，貼近台灣讀者的自然語感。專有名詞、公司名、技術術語可保留英文或通用譯名。
- **風格**：模仿《晚點 LatePost》的報導風格——
  - 冷靜克制的記者筆法，不煽情、不用驚嘆號
  - 每則先講「發生什麼事」，再剖析「為什麼重要」
  - 強調事實、脈絡與連動關係，拒絕模糊形容詞
  - 句子俐落、資訊密度高
- **選材**：選擇對資料中心產業影響大的事件（新建/擴建案、併購、技術突破、政策法規、供電/冷卻/AI 算力、雲端服務商動態等）。「影響」欄位可以做分析推論，但推論的前提必須是素材中的事實。
- **Hyperscaler 優先**：AWS、Microsoft、Google、Meta 是讀者重點追蹤對象。素材中若有這四家的相關事件，優先選入（可分散在任一分區）；素材中沒有就不要硬湊。並在「💡 總結」點名本日素材中四家誰最積極、誰沒有消息。
- **地理分區與公司追蹤規則（嚴格遵守）**：
  - 🏗️「APAC 資料中心動態」（最多 5 則）：**僅限**地理上發生在亞太地區（APAC），但**不含澳洲與紐西蘭**的資料中心產業重大事件。包含：日本、韓國、台灣、中國、香港、東南亞（新加坡、馬來西亞、印尼、泰國、越南、菲律賓等）、印度等亞太區域。
  - 🇦🇺「澳洲資料中心動態」（最多 5 則）：**僅限**地理上發生在澳洲（Australia）或紐西蘭（New Zealand）的資料中心產業重大事件。**取材來源不受限制**：只要事件地點在澳洲/紐西蘭，無論是來自 DCD、DCK、TechDay Asia、DC Post 等綜合產業媒體，或是 NEXTDC、AirTrunk、DCI Data Centers、Equinix AU、Digital Realty AU、Global Switch、Goodman Group、Macquarie Tech、Vocus、Firmus、CDC Data Centres 等公司專屬 feed，都應優先放入本區。重點追蹤：NEXTDC、AirTrunk、DCI Data Centers、Equinix（澳洲業務）、Digital Realty（澳洲業務）、Global Switch（澳洲業務）、Goodman Group（資料中心相關）、Macquarie Technology Group、Vocus Group、**Firmus（Tasmania/Victoria 液冷 AI factory 新興業者）**、**CDC Data Centres（主權政府聚焦）** 等業者；同時涵蓋主權機房、AI 算力擴建、綠色融資、ASX 公告、併購與土地/電力供應等動態。**能源/電網層面**：AEMC、AEMO、Ausgrid、Endeavour Energy 等大型負載併網、ISP、市場規則變更，以及 **NABERS for Data Centres** 評等、**NSW REZ（Renewable Energy Zone）** 進度、**Western Sydney Aerotropolis** 規劃，只要牽涉資料中心用電或選址，都屬於本區高優先事件。素材允許時，盡量讓各卡在子題上分散（業者動態、電網/接入、NABERS/REZ/政策、聚落新建），避免全部都是同一家業者的 ASX 公告。
  - 🌐「ROW 資料中心動態」（最多 3 則）：**僅限**地理上發生在**非 APAC 且非澳洲/紐西蘭**地區的資料中心產業重大事件。ROW = Rest of World，包含：北美、歐洲、中東、非洲、拉丁美洲等。
  - ⚡「AI 算力 × 能源動態」（最多 3 則）：**跨地理區**的「DC × 電力」主題卡。**僅限**以下類型事件：①hyperscaler 簽署的大規模 PPA（再生能源或核能）；②核能 restart / SMR / 核融合相關交易（Constellation、Talen、Kairos、Helion、X-energy、Oklo 等）；③電網層級的監管變化（FERC behind-the-meter 裁決、AEMO ISP 更新、Capacity Investment Scheme 等）；④BloombergNEF 等權威機構的企業 PPA / 清潔能源排名與分析；⑤大型資料中心 PUE / 冷卻技術突破與其能源影響。**只要主軸是「電力如何餵養 AI 算力」就放這裡**，可跨越地理區；同一則新聞若同時符合地理區與本卡，優先放本卡。
  - 🔥「Bytedance / TikTok 資料中心動態」（最多 3 則）：**僅限**素材中明確提到 ByteDance、TikTok 或抖音的資料中心相關消息（不限地區）。素材沒有提到這家公司，就寫「本日無相關更新」，絕不可自行推測或編造。
  - APAC、澳洲、ROW 三區的分區判斷標準是事件的**地理發生地點**；同一事件只能出現在其中一區，不得重複。AI×能源、Bytedance/TikTok 的判斷標準是**主題或公司**，不限地區，但同一事件不得同時出現在地理區與這兩張主題卡——主題卡優先。


## 輸出格式（嚴格遵守，逐字照抄標籤，每張卡片 4 個欄位缺一不可）

每個分區先寫分區標題，接著重複卡片區塊（不超過該分區上限）；若該分區沒有對應素材，分區標題下只寫「本日無相關更新」。

🏗️ APAC 資料中心動態 (Top 5)

${card('2 至 3 句話，說明事件背景與最新進展，100 至 150 字，晚點風格', '說明對區域資料中心市場或產業格局的具體影響，80 至 120 字')}

🇦🇺 澳洲資料中心動態 (Top 5)

${card()}

🌐 ROW 資料中心動態 (Top 3)

${card()}

⚡ AI 算力 × 能源動態 (Top 3)

${card('2 至 3 句話，100 至 150 字，聚焦 PPA / SMR / 核能 / 電網監管 / 冷卻能效突破', '80 至 120 字，說明對 hyperscaler 電力策略或整體 DC 產業電力供需的影響')}

🔥 Bytedance / TikTok 資料中心動態 (Top 3)

${card()}

💡 總結與產業趨勢觀察
快速總結：{2 至 3 句話，綜合分析今日資料中心產業整體動態，點出最關鍵的趨勢}

Hyperscaler 觀察：{1 至 2 句話，點名本日素材中 AWS / Microsoft / Google / Meta 四家誰最積極、誰沒有消息，並提及具體事件}

關鍵趨勢：
• {趨勢一，帶本份簡報中的具體事件}
• {趨勢二，帶本份簡報中的具體事件}
• {趨勢三，帶本份簡報中的具體事件}

結論：{一句話總結資料中心產業短中期展望}
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
  console.log('Fetching data center news feeds...');
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

  // Hard 24-hour window
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

  // Sort newest first
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
