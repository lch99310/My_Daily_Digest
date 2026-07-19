#!/usr/bin/env node
// ============================================================================
// Daily Data Center Briefing — dc-digest.mjs
// Fetches data center industry RSS feeds, uses OpenRouter LLM to generate a
// briefing in Traditional Chinese, delivers via Telegram.
// ============================================================================

import { writeFile } from 'fs/promises';

const AGNES_AI_API_KEY        = process.env.AGNES_AI_API_KEY || '';
const OPENROUTER_FREE_API_KEY = process.env.OPENROUTER_FREE_API_KEY || '';
const DEEPSEEK_API_KEY       = process.env.DEEPSEEK_API_KEY || '';
const BOT_TOKEN          = process.env.DC_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID            = process.env.DC_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID    = process.env.DC_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!AGNES_AI_API_KEY && !OPENROUTER_FREE_API_KEY) {
  console.error('ERROR: at least one of AGNES_AI_API_KEY / OPENROUTER_FREE_API_KEY is required');
  process.exit(1);
}
if (!BOT_TOKEN)          { console.error('ERROR: DC_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of DC_TELEGRAM_CHAT_ID / DC_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const MAX_TOKENS  = 8500;
const OUTPUT_FILE = '/tmp/dc-briefing.md';

// Minimum acceptable response length. A full briefing (19 cards across
// APAC×5 / Australia×5 / ROW×3 / AI×Energy×3 / Bytedance×3 + summary)
// must be at least ~3000 chars; anything shorter means the model
// truncated or couldn't follow the format.
const MIN_CONTENT_LENGTH = 3000;

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

function buildPrompt(articles) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const sourceSet = [...new Set(articles.map(a => a.source).filter(Boolean))];
  const sourceList = sourceSet.join('、');

  const articleList = articles
    .slice(0, 120)
    .map((a, i) => {
      const src = a.source ? ` [來源：${a.source}]` : '';
      return `${i + 1}.${src} ${a.title}${a.desc ? '\n   ' + a.desc : ''}`;
    })
    .join('\n\n');

  return `你是一位資深的資料中心產業分析師，正在為台灣讀者撰寫每日資料中心產業簡報。今天是 ${today}。

## 過去 24 小時資料中心產業新聞（已標註原始媒體來源）

${articleList}

## 撰寫要求

- **語言**：全文繁體中文，貼近台灣讀者的自然語感。專有名詞、公司名、技術術語可保留英文或通用譯名。
- **風格**：模仿《晚點 LatePost》的報導風格——
  - 冷靜克制的記者筆法，不煽情、不用驚嘆號
  - 每則先講「發生什麼事」，再剖析「為什麼重要」
  - 強調事實、脈絡與連動關係，拒絕模糊形容詞
  - 句子俐落、資訊密度高
- **來源欄位（重要）**：每張卡片的「來源」欄位**只能**從下列清單中挑選，且必須與上方素材中標註的來源一致：${sourceList}。如需綜合多個來源，以頓號分隔（例如「DCD、DCK」）。不得自行編造來源。
- **資料取材**：要選擇對資料中心產業影響大的事件（包含：新建/擴建案、併購、技術突破、政策法規、供電/冷卻/AI算力相關、雲端服務商動態等）。盡量以上方提供的新聞素材為主；若需補充背景脈絡，可帶入你對近期產業動態的掌握，但當前卡片仍須對應到真實的新聞事件。
- **Hyperscaler 強制條款（重要）**：每日整份簡報必須至少**累計 3 則**事件與 AWS、Microsoft、Google、Meta 四家其中之一直接相關（可分散在 APAC / 澳洲 / ROW / AI×能源 任一卡片中累計，不要求集中）。理由：這四家是讀者重點追蹤對象。若上方素材四家動態不足 3 則，可結合你對近期已公開的真實事件補充，但仍須對應到真實新聞；並在「💡 總結」段落點名提及本日四家中誰最積極/最沉默。
- **地理分區與公司追蹤規則（嚴格遵守）**：
  - 🏗️「APAC 資料中心動態 (Top 5)」：**僅限**地理上發生在亞太地區（APAC），但**不含澳洲與紐西蘭**的資料中心產業重大事件。包含：日本、韓國、台灣、中國、香港、東南亞（新加坡、馬來西亞、印尼、泰國、越南、菲律賓等）、印度等亞太區域。若素材不足 5 則，可結合近期真實重大事件補充。
  - 🇦🇺「澳洲資料中心動態 (Top 5)」：**僅限**地理上發生在澳洲（Australia）或紐西蘭（New Zealand）的資料中心產業重大事件。**取材來源不受限制**：只要事件地點在澳洲/紐西蘭，無論是來自 DCD、DCK、TechDay Asia、DC Post 等綜合產業媒體，或是 NEXTDC、AirTrunk、DCI Data Centers、Equinix AU、Digital Realty AU、Global Switch、Goodman Group、Macquarie Tech、Vocus、Firmus、CDC Data Centres 等公司專屬 feed，都應優先放入本區；重點追蹤：NEXTDC、AirTrunk、DCI Data Centers、Equinix（澳洲業務）、Digital Realty（澳洲業務）、Global Switch（澳洲業務）、Goodman Group（資料中心相關）、Macquarie Technology Group、Vocus Group、**Firmus（Tasmania/Victoria 液冷 AI factory 新興業者）**、**CDC Data Centres（主權政府聚焦）** 等業者；同時涵蓋主權機房、AI 算力擴建、綠色融資、ASX 公告、併購與土地/電力供應等動態。**能源/電網層面**：AEMC、AEMO、Ausgrid、Endeavour Energy 等大型負載併網、ISP、市場規則變更，以及 **NABERS for Data Centres** 評等、**NSW REZ（Renewable Energy Zone）** 進度、**Western Sydney Aerotropolis** 規劃，只要牽涉資料中心用電或選址，都屬於本區高優先事件。**力求 5 張卡之間在子題上分散**：理想分配是 2 則業者動態 + 1 則電網/接入 + 1 則 NABERS/REZ/政策 + 1 則 Aerotropolis/聚落新建；若某類素材缺乏可調整，但避免 5 張全部都是同一家業者的 ASX 公告。若素材不足 5 則，可結合你對近期澳洲資料中心產業動態的掌握補充，但仍須對應到真實事件；若確實完全無任何消息，則寫「本日無相關更新」。
  - 🌐「ROW 資料中心動態 (Top 3)」：**僅限**地理上發生在**非 APAC 且非澳洲/紐西蘭**地區的資料中心產業重大事件。ROW = Rest of World，包含：北美、歐洲、中東、非洲、拉丁美洲等。
  - ⚡「AI 算力 × 能源動態 (Top 3)」：**跨地理區**的「DC × 電力」主題卡。**僅限**以下類型事件：①hyperscaler 簽署的大規模 PPA（再生能源或核能）；②核能 restart / SMR / 核融合相關交易（Constellation、Talen、Kairos、Helion、X-energy、Oklo 等）；③電網層級的監管變化（FERC behind-the-meter 裁決、AEMO ISP 更新、Capacity Investment Scheme 等）；④BloombergNEF 等權威機構的企業 PPA / 清潔能源排名與分析；⑤大型資料中心 PUE / 冷卻技術突破與其能源影響。本卡與地理區的判斷標準不同：**只要主軸是「電力如何餵養 AI 算力」就放這裡**，可跨越地理區。**重要**：不要與其他卡片重複事件；同一則新聞若同時符合地理區與本卡，優先放本卡。若素材不足 3 則，可結合你對近期重大趨勢的掌握補充，但仍須對應到真實事件；若確實完全無任何消息，則寫「本日無相關更新」。
  - 🔥「Bytedance / TikTok 資料中心動態 (Top 3)」：**僅限**與 ByteDance、TikTok、抖音這家公司相關的資料中心重大消息（不限地區，只看是否與該公司有關）。從上方素材中挑出相關新聞；若素材不足 3 則，可結合你對近期 ByteDance 資料中心動態的掌握補充，但仍須對應到真實事件。如果確實完全無相關消息，則寫「本日無相關更新」。
  - APAC、澳洲、ROW 三區的分區判斷標準是事件的**地理發生地點**；同一事件只能出現在其中一區，不得重複。AI×能源、Bytedance/TikTok 的判斷標準是**主題或公司**，不限地區，但同一事件不得同時出現在地理區與這兩張主題卡——主題卡優先。


## 輸出格式（嚴格遵守，逐字照抄標籤，每張卡片 4 個欄位缺一不可）

🏗️ APAC 資料中心動態 (Top 5)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，說明事件背景與最新進展，100 至 150 字，晚點風格}
影響：{說明對區域資料中心市場或產業格局的具體影響，80 至 120 字}
來源：{從上方清單挑選的媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

🇦🇺 澳洲資料中心動態 (Top 5)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

{如確實完全無任何澳洲/紐西蘭相關消息，以上卡片替換為：「本日無相關更新」}

🌐 ROW 資料中心動態 (Top 3)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

⚡ AI 算力 × 能源動態 (Top 3)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字，聚焦 PPA / SMR / 核能 / 電網監管 / 冷卻能效突破}
影響：{80 至 120 字，說明對 hyperscaler 電力策略或整體 DC 產業電力供需的影響}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

{如確實完全無任何 AI 算力×能源相關消息，以上卡片替換為：「本日無相關更新」}

🔥 Bytedance / TikTok 資料中心動態 (Top 3)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
影響：{80 至 120 字}
來源：{媒體名稱}

{如確實完全無任何 Bytedance/TikTok 相關消息，以上卡片替換為：「本日無相關更新」}

💡 總結與產業趨勢觀察
快速總結：{2 至 3 句話，綜合分析今日資料中心產業整體動態，點出最關鍵的趨勢}

Hyperscaler 觀察：{1 至 2 句話，點名本日 AWS / Microsoft / Google / Meta 四家中誰最積極、誰最沉默，並提及具體事件}

關鍵趨勢：
• {趨勢一，帶具體事件}
• {趨勢二，帶具體事件}
• {趨勢三，帶具體事件}

結論：{一句話總結資料中心產業短中期展望}
`;
}

// -- OpenRouter (streaming with idle detection) -------------------------------

const FALLBACK_MODELS = [
  'minimax/minimax-m2.5:free',
  'deepseek/deepseek-r1:free',
  'google/gemma-3-27b-it:free',
  'microsoft/phi-4:free',
  'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

// Models to try first — sorted to the front of the discovered list.
const PREFERRED_MODELS = [
  'minimax/minimax-m2.5:free',
];

// Filter out models too small to follow a structured multi-card prompt.
const TINY_MODEL_RE = /[-_e](0\.\d+|1\.?\d*|2\.?\d*|3\.?\d*|4\.?\d*)b[-_:]/i;

// Only block models known to return empty/broken responses.
const BLOCKED_MODEL_RE = /^nvidia\/nemotron/;

function isCapableModel(id) {
  return !TINY_MODEL_RE.test(id) && !BLOCKED_MODEL_RE.test(id);
}

async function fetchFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_FREE_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const free = (data.data || [])
      .filter(m => m.id.endsWith(':free') && isCapableModel(m.id))
      .map(m => m.id);
    // Sort preferred models to the front so they get tried first
    free.sort((a, b) => {
      const aPref = PREFERRED_MODELS.indexOf(a);
      const bPref = PREFERRED_MODELS.indexOf(b);
      if (aPref !== -1 && bPref !== -1) return aPref - bPref;
      if (aPref !== -1) return -1;
      if (bPref !== -1) return 1;
      return 0;
    });
    console.log(`Discovered ${free.length} capable free models`);
    // Cap at 20. On a good day only 1 model attempt fires (3 workflows = 3 total).
    return free.slice(0, 20);
  } catch (err) {
    console.warn(`Model list failed (${err.message}), using fallback`);
    return FALLBACK_MODELS;
  }
}

// Streaming timeout constants:
// - IDLE_TIMEOUT: if no SSE data arrives for this long, model is unresponsive → abort fast
// - ABSOLUTE_TIMEOUT: hard cap on total generation time, even if tokens are still flowing
const IDLE_TIMEOUT     = 30_000;   // 30s — no data = dead model, move on
const ABSOLUTE_TIMEOUT = 180_000;  // 3min — hard cap even for active models

async function callModel(model, prompt) {
  const controller = new AbortController();
  const absoluteTimer = setTimeout(() => controller.abort(), ABSOLUTE_TIMEOUT);

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_FREE_API_KEY}`,
        'HTTP-Referer': 'https://github.com/lch99310/Daily_Digest_for_geopolitics_and_AI',
        'X-Title': 'DC Digest',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(absoluteTimer);
    if (err.name === 'AbortError') throw new Error('Connection timed out (180s)');
    throw err;
  }

  if (!response.ok) {
    clearTimeout(absoluteTimer);
    const err = await response.text();
    throw new Error(`${response.status}: ${err}`);
  }

  // Read SSE stream with idle detection.
  let content = '';
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT);
  };
  resetIdle();

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          content += delta;
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (content.length > 0) {
        throw new Error(`Stalled after ${content.length} chars (idle >${IDLE_TIMEOUT / 1000}s)`);
      }
      throw new Error(`No tokens received within ${IDLE_TIMEOUT / 1000}s — model unresponsive`);
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
  }

  content = content.trim();
  if (!content) throw new Error('Empty response');
  if (content.length < MIN_CONTENT_LENGTH) {
    throw new Error(`Response too short (${content.length} chars, need ≥${MIN_CONTENT_LENGTH})`);
  }
  return content;
}

// Try models one at a time — stop at the first success.
async function tryModelsSequentially(models, prompt) {
  for (const model of models) {
    try {
      console.log(`Trying ${model}...`);
      const result = await callModel(model, prompt);
      console.log(`✓ Success: ${model}`);
      return result;
    } catch (err) {
      console.warn(`✗ ${model}: ${err.message.slice(0, 120)}`);
    }
  }
  throw new Error('All OpenRouter models failed');
}

// -- Agnes AI (first-priority provider) --------------------------------------
// Tried before any OpenRouter free model. Falls through to the existing flow
// (OpenRouter free → DeepSeek paid) on any failure.
//
// Agnes occasionally returns "Invalid model name" 400s for a model name that
// it accepts on other concurrent requests (observed across simultaneous
// dc/geopo/stock runs in the same minute). Treat that error — plus 429/5xx —
// as transient and retry once before falling through.

const AGNES_MAX_ATTEMPTS = 2;
const AGNES_RETRY_DELAY  = 2_000;
const AGNES_TRANSIENT_RE = /^Agnes (?:400|408|409|425|429|5\d\d)|Invalid model name|fetch failed|network|ECONN/i;

async function callAgnes(prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= AGNES_MAX_ATTEMPTS; attempt++) {
    try {
      return await callAgnesOnce(prompt);
    } catch (err) {
      lastErr = err;
      const transient = AGNES_TRANSIENT_RE.test(err.message);
      if (!transient || attempt === AGNES_MAX_ATTEMPTS) throw err;
      console.warn(`✗ Agnes attempt ${attempt}/${AGNES_MAX_ATTEMPTS} (transient): ${err.message.slice(0, 200)} — retrying in ${AGNES_RETRY_DELAY / 1000}s`);
      await new Promise(r => setTimeout(r, AGNES_RETRY_DELAY));
    }
  }
  throw lastErr;
}

async function callAgnesOnce(prompt) {
  console.log('Trying Agnes AI...');
  const response = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
    signal: AbortSignal.timeout(ABSOLUTE_TIMEOUT),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AGNES_AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'agnes-2.0-flash',
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Agnes ${response.status}: ${err.slice(0, 1000)}`);
  }

  const result = await response.json();
  const content = (result.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('Agnes returned empty response');
  if (content.length < MIN_CONTENT_LENGTH) {
    throw new Error(`Agnes response too short (${content.length} chars, need ≥${MIN_CONTENT_LENGTH})`);
  }
  return content;
}

// -- DeepSeek paid fallback ---------------------------------------------------
// Only called when ALL free OpenRouter models fail. DeepSeek-chat is ~0.05 CNY/day.

async function callDeepSeek(prompt) {
  console.log('Falling back to DeepSeek (paid)...');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    signal: AbortSignal.timeout(120_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${err}`);
  }

  const result = await response.json();
  const content = (result.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('DeepSeek returned empty response');
  if (content.length < MIN_CONTENT_LENGTH) {
    throw new Error(`DeepSeek response too short (${content.length} chars, need ≥${MIN_CONTENT_LENGTH})`);
  }
  console.log('✓ Success: DeepSeek (paid fallback)');
  return content;
}

// -- Telegram delivery -------------------------------------------------------

// Telegram's edge occasionally drops a connection mid-delivery, surfacing as a
// bare `fetch failed` (undici network error) or a transient 429/5xx. A single
// blip on one chunk must not abandon the whole briefing, so each chunk send is
// retried with exponential backoff before giving up.
const TG_MAX_ATTEMPTS   = 4;
const TG_BACKOFF_MS      = [1_000, 2_000, 4_000];   // waits between attempts 1→2, 2→3, 3→4
const TG_TRANSIENT_RE    = /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket|terminated|aborted|timed out/i;

async function sendChunkWithRetry(label, chatId, chunk, index, total) {
  let lastErr;
  for (let attempt = 1; attempt <= TG_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Telegram API error ${res.status}: ${body.slice(0, 300)}`);
        // 429 (rate limit) and 5xx are transient; 4xx (bad token/chat) are not.
        err.retryable = res.status === 429 || res.status >= 500;
        // Honour Telegram's retry_after hint when present.
        if (res.status === 429) {
          try { err.retryAfterMs = (JSON.parse(body).parameters?.retry_after || 1) * 1000; }
          catch { /* fall back to default backoff */ }
        }
        throw err;
      }
      console.log(`[${label}] Sent chunk ${index + 1}/${total}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable ?? TG_TRANSIENT_RE.test(err.message);
      if (!retryable || attempt === TG_MAX_ATTEMPTS) throw err;
      const wait = err.retryAfterMs ?? TG_BACKOFF_MS[attempt - 1] ?? 4_000;
      console.warn(`[${label}] chunk ${index + 1}/${total} attempt ${attempt}/${TG_MAX_ATTEMPTS} failed (${err.message.slice(0, 120)}) — retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function sendTelegram(text) {
  const MAX_LEN = 4000;
  const chunks  = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  // Fan out to every configured destination (private chat + channel).
  // One destination failing must not block the others, so we collect errors
  // and only throw at the end if every destination failed.
  const destinations = [
    { label: 'chat',    chatId: CHAT_ID },
    { label: 'channel', chatId: CHANNEL_CHAT_ID },
  ].filter(d => d.chatId);

  const errors = [];
  let   delivered = 0;

  for (const { label, chatId } of destinations) {
    try {
      for (let i = 0; i < chunks.length; i++) {
        await sendChunkWithRetry(label, chatId, chunks[i], i, chunks.length);
      }
      delivered++;
    } catch (err) {
      console.warn(`[${label}] delivery failed: ${err.message}`);
      errors.push(`${label}: ${err.message}`);
    }
  }

  if (delivered === 0) {
    throw new Error(`All Telegram destinations failed — ${errors.join('; ')}`);
  }
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

  const prompt   = buildPrompt(fresh);
  let   briefing;

  // 1) Agnes AI (first priority)
  if (AGNES_AI_API_KEY) {
    try {
      briefing = await callAgnes(prompt);
      console.log('✓ Success: Agnes AI');
    } catch (err) {
      console.warn(`✗ Agnes AI: ${err.message}`);
    }
  }

  // 2) OpenRouter free models (existing order preserved)
  if (!briefing && OPENROUTER_FREE_API_KEY) {
    const models = await fetchFreeModels();
    console.log(`Trying up to ${models.length} models sequentially...`);
    try {
      briefing = await tryModelsSequentially(models, prompt);
    } catch (err) {
      console.warn(`✗ OpenRouter free models: ${err.message.slice(0, 120)}`);
    }
  }

  // 3) DeepSeek paid fallback (last resort)
  if (!briefing) {
    if (!DEEPSEEK_API_KEY) throw new Error('All upstream LLM providers failed and DEEPSEEK_API_KEY not configured');
    briefing = await callDeepSeek(prompt);
  }

  // Strip code fences if model wrapped the output
  briefing = briefing.replace(/^```[\w]*\s*/i, '').replace(/```$/i, '').trim();

  await writeFile(OUTPUT_FILE, briefing, 'utf-8');
  console.log(`Briefing written to ${OUTPUT_FILE} (${briefing.length} chars)`);

  await sendTelegram(briefing);
  console.log('Delivered to Telegram successfully');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
