#!/usr/bin/env node
// ============================================================================
// Daily Data Center Briefing — dc-digest.mjs
// Fetches data center industry RSS feeds, uses OpenRouter LLM to generate a
// briefing in Traditional Chinese, delivers via Telegram.
// ============================================================================

import { writeFile } from 'fs/promises';

const OPENROUTER_FREE_API_KEY = process.env.OPENROUTER_FREE_API_KEY || '';
const DEEPSEEK_API_KEY       = process.env.DEEPSEEK_API_KEY || '';
const BOT_TOKEN          = process.env.DC_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID            = process.env.DC_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID    = process.env.DC_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!OPENROUTER_FREE_API_KEY) { console.error('ERROR: OPENROUTER_FREE_API_KEY is required'); process.exit(1); }
if (!BOT_TOKEN)          { console.error('ERROR: DC_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of DC_TELEGRAM_CHAT_ID / DC_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const MAX_TOKENS  = 6000;
const OUTPUT_FILE = '/tmp/dc-briefing.md';

// Minimum acceptable response length. A full briefing (12 cards across
// APAC / Australia / ROW / Bytedance + summary) must be at least ~2000
// chars; anything shorter means the model truncated or couldn't follow
// the format.
const MIN_CONTENT_LENGTH = 2000;

// Data center industry RSS feeds — no API key needed
const NEWS_FEEDS = [
  // Industry-wide sources
  { name: 'DCD',          url: 'https://www.datacenterdynamics.com/en/atom/' },
  { name: 'DCK',          url: 'https://www.datacenterknowledge.com/rss.xml' },
  { name: 'TechDay Asia', url: 'https://datacenternews.asia/feed' },
  { name: 'DC Post',      url: 'https://datacenterpost.com/feed/' },

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

  // AU energy regulator/operator — DC power supply, large-load connections,
  // ISP updates. AEMC (rule maker) and AEMO (operator) both block bot
  // access on their sites, so we ride on media coverage via Google News.
  { name: 'AEMC',               url: 'https://news.google.com/rss/search?q=when:24h+(AEMC+OR+%22Australian+Energy+Market+Commission%22)+(%22data+centre%22+OR+%22data+center%22)&hl=en-AU&gl=AU&ceid=AU:en' },
  { name: 'AEMO',               url: 'https://news.google.com/rss/search?q=when:24h+(AEMO+OR+%22Australian+Energy+Market+Operator%22)+(%22data+centre%22+OR+%22data+center%22)&hl=en-AU&gl=AU&ceid=AU:en' },
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
    .slice(0, 80)
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
- **地理分區與公司追蹤規則（嚴格遵守）**：
  - 🏗️「APAC 資料中心動態 (Top 3)」：**僅限**地理上發生在亞太地區（APAC），但**不含澳洲與紐西蘭**的資料中心產業重大事件。包含：日本、韓國、台灣、中國、香港、東南亞（新加坡、馬來西亞、印尼、泰國、越南、菲律賓等）、印度等亞太區域。
  - 🇦🇺「澳洲資料中心動態 (Top 3)」：**僅限**地理上發生在澳洲（Australia）或紐西蘭（New Zealand）的資料中心產業重大事件。**取材來源不受限制**：只要事件地點在澳洲/紐西蘭，無論是來自 DCD、DCK、TechDay Asia、DC Post 等綜合產業媒體，或是 NEXTDC、AirTrunk、DCI Data Centers、Equinix AU、Digital Realty AU、Global Switch、Goodman Group、Macquarie Tech、Vocus 等公司專屬 feed，都應優先放入本區；重點追蹤：NEXTDC、AirTrunk、DCI Data Centers、Equinix（澳洲業務）、Digital Realty（澳洲業務）、Global Switch（澳洲業務）、Goodman Group（資料中心相關）、Macquarie Technology Group、Vocus Group 等業者；同時涵蓋主權機房、AI 算力擴建、綠色融資、ASX 公告、併購與土地/電力供應等動態。**能源/電網層面**：AEMC（Australian Energy Market Commission，市場規則制定者）與 AEMO（Australian Energy Market Operator，電網與市場運營者）相關的大型負載（large load）併網、ISP（Integrated System Plan）、市場規則變更等，只要牽涉資料中心用電或選址，都屬於本區高優先事件。若素材不足 3 則，可結合你對近期澳洲資料中心產業動態的掌握補充，但仍須對應到真實事件；若確實完全無任何消息，則寫「本日無相關更新」。
  - 🌐「ROW 資料中心動態 (Top 3)」：**僅限**地理上發生在**非 APAC 且非澳洲/紐西蘭**地區的資料中心產業重大事件。ROW = Rest of World，包含：北美、歐洲、中東、非洲、拉丁美洲等。
  - 🔥「Bytedance / TikTok 資料中心動態 (Top 3)」：**僅限**與 ByteDance、TikTok、抖音這家公司相關的資料中心重大消息（不限地區，只看是否與該公司有關）。從上方素材中挑出相關新聞；若素材不足 3 則，可結合你對近期 ByteDance 資料中心動態的掌握補充，但仍須對應到真實事件。如果確實完全無相關消息，則寫「本日無相關更新」。
  - APAC、澳洲、ROW 三區的分區判斷標準是事件的**地理發生地點**；同一事件只能出現在其中一區，不得重複。Bytedance / TikTok 的判斷標準是**是否與該公司相關**，不限地區，可與地理區並列。


## 輸出格式（嚴格遵守，逐字照抄標籤，每張卡片 4 個欄位缺一不可）

🏗️ APAC 資料中心動態 (Top 3)

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

🇦🇺 澳洲資料中心動態 (Top 3)

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
      model: 'deepseek-chat',
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
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunks[i] }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Telegram API error: ${err}`);
        }
        console.log(`[${label}] Sent chunk ${i + 1}/${chunks.length}`);
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

  const models = await fetchFreeModels();
  console.log(`Trying up to ${models.length} models sequentially...`);

  const prompt   = buildPrompt(fresh);
  let   briefing;
  try {
    briefing = await tryModelsSequentially(models, prompt);
  } catch {
    // All free models failed — try DeepSeek as paid fallback
    if (!DEEPSEEK_API_KEY) throw new Error('All free models failed and DEEPSEEK_API_KEY not configured');
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
