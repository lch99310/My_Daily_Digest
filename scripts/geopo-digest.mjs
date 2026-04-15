#!/usr/bin/env node
// ============================================================================
// Daily Geopolitical Briefing — geopo-digest.mjs
// Fetches global news RSS feeds, uses OpenRouter LLM to generate a
// geopolitical risk briefing in Traditional Chinese, delivers via Telegram.
// ============================================================================

import { writeFile } from 'fs/promises';

const OPENROUTER_FREE_API_KEY = process.env.OPENROUTER_FREE_API_KEY || '';
const DEEPSEEK_API_KEY       = process.env.DEEPSEEK_API_KEY || '';
const BOT_TOKEN          = process.env.GEOPO_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID            = process.env.GEOPO_TELEGRAM_CHAT_ID || '';

if (!OPENROUTER_FREE_API_KEY) { console.error('ERROR: OPENROUTER_FREE_API_KEY is required'); process.exit(1); }
if (!BOT_TOKEN)          { console.error('ERROR: GEOPO_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID)            { console.error('ERROR: GEOPO_TELEGRAM_CHAT_ID is required'); process.exit(1); }

const MAX_TOKENS  = 5500;
const OUTPUT_FILE = '/tmp/geopo-briefing.md';

// Minimum acceptable response length. A full briefing (8 cards: 5 China-adjacent
// + 3 global, plus gold summary) must be at least ~2000 chars; anything shorter
// means the model truncated or couldn't follow the format, so we reject it and
// let the race continue to a larger model.
const MIN_CONTENT_LENGTH = 2000;

// Free RSS feeds for geopolitical news — no API key needed
const NEWS_FEEDS = [
  // General international news
  { name: 'Reuters World',      url: 'https://feeds.reuters.com/reuters/worldNews' },
  { name: 'BBC World',          url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera',         url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'Financial Times',    url: 'https://news.google.com/rss/search?q=when:24h+allinurl:ft.com&hl=en-US&gl=US&ceid=US:en' },
  { name: 'SCMP',               url: 'https://news.google.com/rss/search?q=when:24h+allinurl:scmp.com&hl=en-US&gl=US&ceid=US:en' },
  { name: 'WSJ',                url: 'https://news.google.com/rss/search?q=when:24h+allinurl:wsj.com&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Bloomberg',          url: 'https://news.google.com/rss/search?q=when:24h+allinurl:bloomberg.com&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Nikkei Asia',        url: 'https://news.google.com/rss/search?q=when:24h+allinurl:asia.nikkei.com&hl=en-US&gl=US&ceid=US:en' },

  // Military / defense specialists
  { name: 'The War Zone',       url: 'https://www.twz.com/feed/' },
  { name: 'ミリレポ',            url: 'https://news.google.com/rss/search?q=when:24h+%E3%83%9F%E3%83%AA%E3%83%AC%E3%83%9D&hl=ja&gl=JP&ceid=JP:ja' },
  { name: '鳳凰軍事',            url: 'https://news.google.com/rss/search?q=when:24h+%E5%87%A4%E5%87%B0%E5%86%9B%E4%BA%8B&hl=zh-CN&gl=CN&ceid=CN:zh-Hans' },

  // Japanese mainstream press (Google News JP locale — site filter)
  { name: '產經新聞',            url: 'https://news.google.com/rss/search?q=when:24h+allinurl:sankei.com&hl=ja&gl=JP&ceid=JP:ja' },
  { name: '讀賣新聞',            url: 'https://news.google.com/rss/search?q=when:24h+allinurl:yomiuri.co.jp&hl=ja&gl=JP&ceid=JP:ja' },

  // Regional European / Australian coverage
  { name: 'Euronews',           url: 'https://www.euronews.com/rss' },
  { name: 'ABC News Australia', url: 'https://www.abc.net.au/news/feed/51120/rss.xml' },
];

// -- RSS parser (no npm) -----------------------------------------------------

function parseRSSItems(xml) {
  const items = [];
  const itemRe  = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  const titleRe = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const descRe  = /<(?:description|summary|content(?::[^>]*)?)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content(?::[^>]*)?)>/;
  const linkRe  = /<link(?:\s[^>]*)?>([^<\s]+)<\/link>|<link[^>]+href="([^"]+)"/;
  // RSS 2.0 uses <pubDate>, Atom uses <published>/<updated>, Dublin Core uses <dc:date>.
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

function buildPrompt(articles) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  // Enumerate the distinct source names so the model can only pick from
  // real media we actually pulled — prevents hallucinated sources.
  const sourceSet = [...new Set(articles.map(a => a.source).filter(Boolean))];
  const sourceList = sourceSet.join('、');

  const articleList = articles
    .slice(0, 60)
    .map((a, i) => {
      const src = a.source ? ` [來源：${a.source}]` : '';
      return `${i + 1}.${src} ${a.title}${a.desc ? '\n   ' + a.desc : ''}`;
    })
    .join('\n\n');

  return `你是一位資深的地緣政治記者，正在為台灣讀者撰寫每日地緣政治風險簡報。今天是 ${today}。

## 過去 24 小時國際新聞（已標註原始媒體來源）

${articleList}

## 撰寫要求

- **語言**：全文繁體中文，貼近台灣讀者的自然語感。專有名詞、人名、地名可保留英文或通用譯名。
- **風格**：模仿《晚點 LatePost》的報導風格——
  - 冷靜克制的記者筆法，不煽情、不用驚嘆號
  - 每則先講「發生什麼事」，再剖析「為什麼重要」
  - 強調事實、脈絡與連動關係，拒絕模糊形容詞
  - 句子俐落、資訊密度高
- **來源欄位（重要）**：每張卡片的「來源」欄位**只能**從下列清單中挑選，且必須與上方素材中標註的來源一致：${sourceList}。如需綜合多個來源，以頓號分隔（例如「Reuters、BBC」）。不得自行編造來源。
- **資料取材**：要選擇對地緣風險影響大的事件（包含：軍事、經濟等會對地緣格局影響大的事件）。盡量以上方提供的新聞素材為主；若需補充背景脈絡，可帶入你對近期局勢的掌握，但當前卡片仍須對應到真實的新聞事件。
- **地理分區規則（嚴格遵守）**：
  - 🔴「中國周邊高風險地緣政治事件 (Top 5)」：**僅限**發生在地理上中國周邊區域的重大地緣風險事件，挑出最重要的前 5 則。所謂「中國周邊」指：台灣海峽、南海、東海、朝鮮半島、中印邊境、中亞鄰國、東南亞、日本、菲律賓等與中國地理上直接相鄰或密切關聯的區域。挑選順序以對區域安全格局影響的嚴重性與時效性排序，最重大的放第 1 則。
  - 🌍「全球其他重大地緣政治事件 (Top 3)」：**僅限**發生在地理上非中國周邊的其他地區的重大地緣風險事件。例如：中東、歐洲、非洲、美洲、南亞（不含中印邊境）等地區。
  - 請勿將兩個分區的事件混淆歸類。判斷標準是事件的**地理發生地點**，而非涉及的國家。


## 輸出格式（嚴格遵守，逐字照抄標籤，每張卡片 4 個欄位缺一不可）

🔴 中國周邊高風險地緣政治事件 (Top 5)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，說明事件背景與最新進展，100 至 150 字，晚點風格}
風險：{說明對區域安全或全球秩序的具體威脅，80 至 120 字}
來源：{從上方清單挑選的媒體名稱，供讀者自行判斷可信度}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{媒體名稱}

🌍 全球其他重大地緣政治事件 (Top 3)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{媒體名稱}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20 字以內}
摘要：{2 至 3 句話，100 至 150 字}
風險：{80 至 120 字}
來源：{媒體名稱}

💡 總結與黃金市場影響評估
快速總結：{2 至 3 句話，綜合分析今日整體地緣政治態勢，點出最關鍵的連動風險}

對黃金的影響：{從以下選一：極度利多（強烈看漲）／利多（看漲）／中性／利空（看跌）／極度利空（強烈看跌）}
• {看多或看空理由一，帶具體事件}
• {看多或看空理由二，帶具體事件}
• {看多或看空理由三，帶具體事件}

結論：{一句話總結黃金短中期走勢展望}
`;
}

// -- OpenRouter (parallel race — same pattern as generate-digest.mjs) --------

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
// ≤4B params tend to produce truncated or off-format output.
// Catches both conventional naming (-2b-, _4b:) and "effective params" naming (e2b, e4b)
// used by models like gemma-3n-e2b-it and gemma-3n-e4b-it.
const TINY_MODEL_RE = /[-_e](0\.\d+|1\.?\d*|2\.?\d*|3\.?\d*|4\.?\d*)b[-_:]/i;

// Only block models known to return empty/broken responses.
// Do NOT block slow models here — a 60s timeout handles those.
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
    // Cap at 20. OpenRouter free tier: 50 RPD (no credits).
    // 2 workflows × 20 = 40 max/day, leaving a 10-request buffer.
    // On a good day only 1 model attempt fires per workflow (2 total).
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
        'HTTP-Referer': 'https://github.com/lch99310/ai-daily-digest-from-twitter-x',
        'X-Title': 'Geopo Digest',
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
  // Every time data arrives we reset the idle timer.
  // If nothing arrives for IDLE_TIMEOUT → model stalled → abort early.
  let content = '';
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT);
  };
  resetIdle(); // start first idle countdown

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle(); // data arrived — reset idle timer
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
// Sequential fallback costs only 1 request on a good day, vs N for parallel racing.
// Dead models are detected quickly via idle timeout (30s), while active models
// get up to 180s to finish generating.
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
    // Split on newline closest to MAX_LEN
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: chunks[i] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram API error: ${err}`);
    }
    console.log(`Sent chunk ${i + 1}/${chunks.length}`);
  }
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
