#!/usr/bin/env node
// ============================================================================
// Daily Geopolitical Briefing — geopo-digest.mjs
// Fetches global news RSS feeds, uses OpenRouter LLM to generate a
// geopolitical risk briefing in Traditional Chinese, delivers via Telegram.
// ============================================================================

import { writeFile } from 'fs/promises';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const BOT_TOKEN          = process.env.GEOPO_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID            = process.env.GEOPO_TELEGRAM_CHAT_ID || '';

if (!OPENROUTER_API_KEY) { console.error('ERROR: OPENROUTER_API_KEY is required'); process.exit(1); }
if (!BOT_TOKEN)          { console.error('ERROR: GEOPO_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID)            { console.error('ERROR: GEOPO_TELEGRAM_CHAT_ID is required'); process.exit(1); }

const MAX_TOKENS  = 4096;
const OUTPUT_FILE = '/tmp/geopo-briefing.md';

// Minimum acceptable response length. A full briefing (6 cards + summary)
// must be at least ~1500 chars; anything shorter means the model truncated
// or couldn't follow the format, so we reject it and let the race continue
// to a larger model.
const MIN_CONTENT_LENGTH = 1500;

// Free RSS feeds for geopolitical news — no API key needed
const NEWS_FEEDS = [
  { name: 'Reuters World',      url: 'https://feeds.reuters.com/reuters/worldNews' },
  { name: 'BBC World',          url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera',         url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'Reddit WorldNews',   url: 'https://www.reddit.com/r/worldnews/top/.rss?t=day' },
  { name: 'Reddit Geopolitics', url: 'https://www.reddit.com/r/geopolitics/top/.rss?t=day' },
];

// -- RSS parser (no npm) -----------------------------------------------------

function parseRSSItems(xml) {
  const items = [];
  const itemRe  = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  const titleRe = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
  const descRe  = /<(?:description|summary|content(?::[^>]*)?)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content(?::[^>]*)?)>/;
  const linkRe  = /<link(?:\s[^>]*)?>([^<\s]+)<\/link>|<link[^>]+href="([^"]+)"/;

  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (titleRe.exec(block)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const desc  = (descRe.exec(block)?.[1]  || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim().slice(0, 250);
    const lm    = linkRe.exec(block);
    const link  = (lm?.[1] || lm?.[2] || '').trim();
    if (title && title.length > 8) items.push({ title, desc, link });
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
    const items = parseRSSItems(xml);
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

  const articleList = articles
    .slice(0, 40)
    .map((a, i) => `${i + 1}. ${a.title}${a.desc ? '\n   ' + a.desc : ''}`)
    .join('\n\n');

  return `你是一位專業的地緣政治分析師，正在為台灣的專業投資人撰寫每日地緣政治風險簡報。今天是 ${today}。

## 今日國際新聞（來自 Reuters、BBC、Al Jazeera 等主流媒體）

${articleList}

## 你的任務

根據上述新聞及你對當前地緣政治局勢的深度掌握，撰寫一份結構嚴謹的風險簡報。

重要規則：
- 語言：**繁體中文**，風格貼近台灣母語使用者的自然書寫，避免大陸式用語（例如：用「網路」而非「网络」，用「軟體」而非「软件」）。
- 嚴格按照以下格式輸出，每個標籤逐字複製，不得增減任何欄位。
- 若新聞中找不到足夠的中國周邊事件，可結合你對近期局勢的背景知識補充，但須說明。

## 輸出格式（完整輸出，不省略任何部分）

🔴 中國周邊高風險地緣政治事件 (Top 3)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20字以內}
摘要：{2至3句話，說明事件背景與最新進展，100至150字}
風險：{說明對區域安全或全球秩序的具體威脅，80至120字}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20字以內}
摘要：{2至3句話，100至150字}
風險：{80至120字}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20字以內}
摘要：{2至3句話，100至150字}
風險：{80至120字}

🌍 全球其他重大地緣政治事件 (Top 3)

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20字以內}
摘要：{2至3句話，100至150字}
風險：{80至120字}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20字以內}
摘要：{2至3句話，100至150字}
風險：{80至120字}

━━━━━━━━━━━━━━━━━━━━
標題：{一句話事件標題，20字以內}
摘要：{2至3句話，100至150字}
風險：{80至120字}

💡 總結與黃金市場影響評估
快速總結：{2至3句話，綜合分析今日整體地緣政治態勢，點出最關鍵的連動風險}

對黃金的影響：{從以下選一：極度利多（強烈看漲）／利多（看漲）／中性／利空（看跌）／極度利空（強烈看跌）}
• {看多或看空理由一，帶具體事件}
• {看多或看空理由二，帶具體事件}
• {看多或看空理由三，帶具體事件}

結論：{一句話總結黃金短中期走勢展望}
`;
}

// -- OpenRouter (parallel race — same pattern as generate-digest.mjs) --------

const FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'z-ai/glm-4.5-air:free',
];

// Filter out models too small to follow a structured multi-card prompt.
// Patterns: param counts ≤ 4B tend to produce truncated or off-format output.
const TINY_MODEL_RE = /[-_](0\.\d+|1\.?\d*|2\.?\d*|3\.?\d*|4\.?\d*)b[-_:]/i;
function isCapableModel(id) {
  return !TINY_MODEL_RE.test(id);
}

async function fetchFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const free = (data.data || [])
      .filter(m => m.id.endsWith(':free') && isCapableModel(m.id))
      .map(m => m.id);
    console.log(`Discovered ${free.length} capable free models`);
    // Cap at 10 to stay within 50 req/day free-tier budget (2 workflows × 10 = 20/day)
    return free.slice(0, 10);
  } catch (err) {
    console.warn(`Model list failed (${err.message}), using fallback`);
    return FALLBACK_MODELS;
  }
}

async function callModel(model, prompt, raceSignal) {
  const signals = [AbortSignal.timeout(90_000)];
  if (raceSignal) signals.push(raceSignal);
  const signal = AbortSignal.any(signals);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://github.com/lch99310/ai-daily-digest-from-twitter-x',
        'X-Title': 'Geopo Digest',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`${response.status}: ${err}`);
    }
    const result  = await response.json();
    const content = (result.choices?.[0]?.message?.content || '').trim();
    if (!content) throw new Error('Empty response');
    if (content.length < MIN_CONTENT_LENGTH) {
      throw new Error(`Response too short (${content.length} chars, need ≥${MIN_CONTENT_LENGTH})`);
    }
    return content;
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('Timed out after 90s');
    if (err.name === 'AbortError')   throw new Error('Cancelled (another model won)');
    throw err;
  }
}

async function raceModels(models, prompt) {
  const controller = new AbortController();
  const attempts = models.map(async (model) => {
    try {
      const result = await callModel(model, prompt, controller.signal);
      controller.abort();
      console.log(`✓ Winner: ${model}`);
      return result;
    } catch (err) {
      if (!err.message.includes('Cancelled') && !controller.signal.aborted) {
        console.warn(`✗ ${model}: ${err.message.slice(0, 100)}`);
      }
      throw err;
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error('All OpenRouter models failed');
  }
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
  if (unique.length < 5) {
    throw new Error(`Only ${unique.length} articles fetched — not enough to generate briefing`);
  }

  const models = await fetchFreeModels();
  console.log(`Racing ${models.length} models in parallel...`);

  const prompt   = buildPrompt(unique);
  let   briefing = await raceModels(models, prompt);

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
