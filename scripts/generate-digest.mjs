#!/usr/bin/env node
// ============================================================================
// AI Builders Digest — Generate Digest
// Reads prepare-output.json, calls OpenRouter LLM, outputs digest markdown.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// -- Config -------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.GITHUB_WORKSPACE || resolve(__dirname, '..');
const PREPARE_JSON = `${WORKSPACE}/scripts/prepare-output.json`;
const OUTPUT_FILE = '/tmp/follow-builders-digest.md';
const OPENROUTER_FREE_API_KEY = process.env.OPENROUTER_FREE_API_KEY || '';

// Known-working free models (confirmed via 429 = endpoint exists).
// Used as fallback if the live model-list API fails.
// Models that return empty bodies (nvidia nemotron) are excluded.
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

const MAX_TOKENS = 4096;

// Minimum response length — a valid digest (3–5 cards) must be at least ~600 chars.
// Models smaller than ~7B often produce truncated or off-format output; reject them.
const MIN_CONTENT_LENGTH = 600;

// Filter out models too small to follow structured prompts (≤4B params).
// Catches both conventional naming (-2b-, _4b:) and "effective params" naming (e2b, e4b)
// used by models like gemma-3n-e2b-it and gemma-3n-e4b-it.
const TINY_MODEL_RE = /[-_e](0\.\d+|1\.?\d*|2\.?\d*|3\.?\d*|4\.?\d*)b[-_:]/i;

// Only block models known to return empty/broken responses.
// Do NOT block slow models here — a 60s timeout handles those.
const BLOCKED_MODEL_RE = /^nvidia\/nemotron/;

function isCapableModel(id) {
  return !TINY_MODEL_RE.test(id) && !BLOCKED_MODEL_RE.test(id);
}

// -- URL helpers -------------------------------------------------------------

/**
 * Improve podcast URL: the feed only gives channel/playlist URLs, never the
 * specific episode. If the URL is a channel (@handle) or playlist, rewrite it
 * to a YouTube channel-search URL built from the episode title, so clicking
 * lands the user on the actual episode instead of the channel homepage.
 */
function improvePodcastUrl(url, title) {
  const query = encodeURIComponent((title || '').trim());
  if (!url) {
    return query ? `https://www.youtube.com/results?search_query=${query}` : '';
  }
  if (url.includes('/watch?v=') || url.includes('/shorts/') || url.includes('youtu.be/')) {
    return url; // Already an episode URL
  }
  const channelMatch = url.match(/youtube\.com\/(@[\w.-]+)/);
  if (channelMatch && query) {
    return `https://www.youtube.com/${channelMatch[1]}/search?query=${query}`;
  }
  return query ? `https://www.youtube.com/results?search_query=${query}` : url;
}

// -- Build prompt from feed data --------------------------------------------

/**
 * Build the LLM prompt and a URL lookup table.
 *
 * Every source item is given an opaque ID (e.g. [X1], [P1], [B1]). The prompt
 * instructs the model to emit the ID — never the URL itself — in the 連結
 * field. After the model responds, we substitute the IDs with the canonical
 * URLs we captured here. This completely eliminates URL hallucination, which
 * is why previous digests shipped broken X links.
 *
 * @returns {{ prompt: string, urlMap: Record<string, string> }}
 */
function buildPrompt(data) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const podcasts = data.podcasts || [];
  const builders = data.x || [];
  const blogs = data.blogs || [];

  const urlMap = {};

  // --- Podcasts ---
  const podcastLines = [];
  podcasts.slice(0, 5).forEach((p, i) => {
    const id = `P${i + 1}`;
    const episodeTitle = p.title || p.name || 'Unknown Episode';
    const showName = p.name && p.title ? p.name : (p.author || 'Unknown');
    const desc = (p.description || p.transcript || '')
      .replace(/\n/g, ' ').trim().slice(0, 600);
    urlMap[id] = improvePodcastUrl(p.url, p.title || p.name);
    podcastLines.push(
`[${id}] 節目：${showName}
    集名：${episodeTitle}
    內容：${desc}`
    );
  });

  // --- X / Twitter ---
  // Pass up to 2 recent tweets per builder so the model has a richer pool
  // and always references a real, captured URL via the ID.
  const xLines = [];
  let xCounter = 0;
  builders.slice(0, 15).forEach((b) => {
    const tweets = (b.tweets || []).slice(0, 2);
    tweets.forEach((tw) => {
      xCounter += 1;
      const id = `X${xCounter}`;
      const text = (tw.text || b.bio || '')
        .replace(/https:\/\/t\.co\/\S+/g, '') // strip opaque t.co links
        .replace(/\n/g, ' ')
        .trim()
        .slice(0, 500);
      urlMap[id] = tw.url || `https://x.com/${b.handle}`;
      xLines.push(
`[${id}] @${b.handle}${b.name ? ` (${b.name})` : ''}
    推文：${text}`
      );
    });
  });

  // --- Blogs ---
  const blogLines = [];
  blogs.slice(0, 5).forEach((bp, i) => {
    const id = `B${i + 1}`;
    urlMap[id] = bp.url || '';
    blogLines.push(
`[${id}] ${bp.title || 'Untitled'}
    摘要：${(bp.summary || '').replace(/\n/g, ' ').trim().slice(0, 400)}`
    );
  });

  const podcastsSection = podcastLines.join('\n\n') || '（今日無播客）';
  const buildersSection = xLines.join('\n\n') || '（今日無推文）';
  const blogsSection = blogLines.join('\n\n') || '（今日無部落格文章）';

  const prompt = `你是一位資深科技記者，正在為台灣讀者撰寫《AI Builders Daily Digest》。今天是 ${today}。

## 原始素材（過去 24 小時內）

### 播客
${podcastsSection}

### X / Twitter
${buildersSection}

### 部落格
${blogsSection}

## 撰寫要求

- **語言**：全文繁體中文，遵循台灣讀者的自然語感與用字（例如「軟體」「程式」「網路」「雲端」「人工智慧」）。專有名詞、模型名稱、公司名稱可保留英文。嚴禁簡體字。
- **風格**：模仿《晚點 LatePost》的報導風格——
  - 冷靜克制的記者筆法，不煽情、不行銷、不用驚嘆號
  - 每則先講「發生什麼事」，再剖析「為什麼重要」或「背後邏輯」
  - 資訊密度高，強調事實、數據、脈絡，避免模糊形容詞
  - 句子俐落，一段話能講清楚的絕不繞路
- **卡片數量**：從上述素材中挑選最具新聞價值的 8 至 10 則，每則一張卡片。不得重複、不得虛構事實。
- **摘要字數**：每段 150 至 250 個繁體中文字，2 至 3 句話。
- **連結格式（關鍵）**：連結欄位**只能填入方括號 ID**（例如 [X1]、[P3]、[B2]），直接複製上方素材中的 ID。**嚴禁輸出任何 http 或 https 網址字串**，系統會在事後自動把 ID 換成真正的連結。若寫成 URL 會被視為錯誤輸出。
- 每張卡片必須包含三個欄位：標題、摘要、連結，一個都不可少。

## 輸出格式（嚴格遵守，僅輸出以下內容，前後不加任何說明）

🤖 **AI Builders Digest**
📅 ${today}

（每張卡片重複此區塊，共 8 至 10 張）

━━━━━━━━━━━━━━━━━━━━
{emoji} **標題：{一句話事件標題，20 字以內}**
📝 摘要：{150 至 250 字的繁體中文晚點風格段落，講清楚事件本身與為何值得關注}
🔗 連結：{素材中的方括號 ID，例如 [X1]；不要寫 URL}

━━━━━━━━━━━━━━━━━━━━
_由 AI 自動生成 · AI Builders Digest_

Emoji 指引：🎙️ 播客 / 🐦 X/Twitter / 📝 部落格
`;

  return { prompt, urlMap };
}

// -- Substitute [ID] placeholders with real URLs -----------------------------

/**
 * Replace every `[ID]` token in the generated digest with the canonical URL
 * captured in `urlMap`. Any token that doesn't resolve is stripped and its
 * containing line is replaced with a safe fallback so we never ship a raw
 * placeholder to users.
 */
function substituteUrls(digest, urlMap) {
  let output = digest.replace(/\[([A-Z]\d{1,3})\]/g, (match, id) => {
    return urlMap[id] || match;
  });

  // Some models ignore instructions and write URLs directly. Leave those
  // alone — they might still be valid. But strip any lingering [XN]-style
  // tokens that never matched a real ID, replacing them with a blank so the
  // line still reads cleanly.
  output = output.replace(/\[([A-Z]\d{1,3})\]/g, '');

  return output;
}

// -- Fetch current free models from OpenRouter API --------------------------

/**
 * Returns a fresh list of all :free model IDs from OpenRouter.
 * Falls back to FALLBACK_MODELS if the API call fails.
 * Caps at 20 models to avoid firing too many parallel requests.
 */
async function fetchFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENROUTER_FREE_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`models API ${res.status}`);
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
    console.log(`Discovered ${free.length} capable free models on OpenRouter`);
    // Cap at 20. OpenRouter free tier: 50 RPD (no credits).
    // 2 workflows × 20 = 40 max/day, leaving a 10-request buffer.
    // On a good day only 1 model attempt fires per workflow (2 total).
    return free.slice(0, 20);
  } catch (err) {
    console.warn(`Could not fetch model list (${err.message}), using fallback list`);
    return FALLBACK_MODELS;
  }
}

// -- Call one model -----------------------------------------------------------

async function callOpenRouter(model, prompt) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      signal: AbortSignal.timeout(60_000),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_FREE_API_KEY}`,
        'HTTP-Referer': 'https://github.com/lch99310/ai-daily-digest-from-twitter-x',
        'X-Title': 'AI Builders Digest',
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

    const result = await response.json();
    const content = (result.choices?.[0]?.message?.content || '').trim();
    if (!content) throw new Error('Empty response body from model');
    if (content.length < MIN_CONTENT_LENGTH) {
      throw new Error(`Response too short (${content.length} chars, need ≥${MIN_CONTENT_LENGTH})`);
    }
    return content;
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('Timed out after 60s');
    throw err;
  }
}

// -- Try models sequentially -------------------------------------------------

// Try each model one at a time — stop at the first success.
// This costs only 1 API request on a good day, vs N for parallel racing,
// which is critical for staying within the 50 req/day free-tier budget.
async function tryModelsSequentially(models, prompt) {
  for (const model of models) {
    try {
      console.log(`Trying ${model}...`);
      const result = await callOpenRouter(model, prompt);
      console.log(`✓ Success: ${model}`);
      return result;
    } catch (err) {
      console.warn(`✗ ${model}: ${err.message.slice(0, 120)}`);
    }
  }
  throw new Error('All OpenRouter models failed');
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log('Reading feed data...');
  const jsonContent = await readFile(PREPARE_JSON, 'utf-8');
  const data = JSON.parse(jsonContent);
  console.log(`Feed loaded: ${data.stats?.podcastEpisodes || 0} podcasts, ${data.stats?.xBuilders || 0} builders`);

  const models = await fetchFreeModels();
  console.log(`Trying up to ${models.length} models sequentially…`);

  const { prompt, urlMap } = buildPrompt(data);
  console.log(`Prompt built: ${Object.keys(urlMap).length} source items with stable URL IDs`);

  let digest = await tryModelsSequentially(models, prompt);

  // Strip any markdown code fences the model may have wrapped around output
  digest = digest.replace(/^```markdown\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  // Substitute [X1] / [P2] / [B1] placeholders with the canonical URLs
  // captured during buildPrompt — this is the single source of truth for
  // URLs in the final digest and is why links never drift from the source.
  digest = substituteUrls(digest, urlMap);

  await writeFile(OUTPUT_FILE, digest, 'utf-8');
  console.log(`Digest written to ${OUTPUT_FILE} (${digest.length} chars)`);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
