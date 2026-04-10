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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// Known-working free models (confirmed via 429 = endpoint exists).
// Used as fallback if the live model-list API fails.
// Models that return empty bodies (nvidia nemotron) are excluded.
const FALLBACK_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'z-ai/glm-4.5-air:free',
];

const MAX_TOKENS = 4096;

// Minimum response length — a valid digest (3–5 cards) must be at least ~600 chars.
// Models smaller than ~7B often produce truncated or off-format output; reject them.
const MIN_CONTENT_LENGTH = 600;

// Filter out models too small to follow structured prompts (≤4B params)
const TINY_MODEL_RE = /[-_](0\.\d+|1\.?\d*|2\.?\d*|3\.?\d*|4\.?\d*)b[-_:]/i;
function isCapableModel(id) {
  return !TINY_MODEL_RE.test(id);
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

function buildPrompt(data) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const podcasts = data.podcasts || [];
  const builders = data.x || [];
  const blogs = data.blogs || [];

  const podcastsSection = podcasts.slice(0, 5).map((p, i) => {
    const episodeTitle = p.title || p.name || 'Unknown Episode';
    const showName = p.name && p.title ? p.name : (p.author || 'Unknown');
    const desc = (p.description || p.transcript || '').replace(/\n/g, ' ').trim().slice(0, 600);
    const url = improvePodcastUrl(p.url, p.title || p.name);
    return `${i + 1}. Show: **${showName}**
   Episode: ${episodeTitle}
   Description: ${desc}
   URL: ${url}`;
  }).join('\n\n');

  const buildersSection = builders.slice(0, 8).map((b, i) => {
    const topTweet = (b.tweets || [])[0] || {};
    const text = (topTweet.text || b.bio || '')
      .replace(/https:\/\/t\.co\/\S+/g, '') // strip opaque t.co links
      .replace(/\n/g, ' ')
      .trim()
      .slice(0, 500);
    const url = topTweet.url || `https://x.com/${b.handle}`;
    return `${i + 1}. **@${b.handle}**${b.name ? ` (${b.name})` : ''}
   Tweet: ${text}
   URL: ${url}`;
  }).join('\n\n');

  const blogsSection = blogs.slice(0, 3).map((b, i) =>
`${i + 1}. **${b.title || 'Untitled'}**
   ${(b.summary || '').replace(/\n/g, ' ').trim().slice(0, 400)}
   URL: ${b.url || ''}`
  ).join('\n\n');

  return `You are writing the AI Builders Daily Digest for ${today}.

## Source Data

### Podcasts
${podcastsSection || '(no podcasts today)'}

### X / Twitter Builders
${buildersSection || '(no tweets today)'}

### Blog Posts
${blogsSection || '(no blog posts today)'}

## Instructions
- Pick 10 items total. Each item becomes exactly ONE card.
- Every card MUST have all three parts: 標題, 摘要, 連結. No exceptions.
- Language: traditional Chinese. The content must present in the content what native traditional chinese would speak. The style should similar to LatePost 晚點 article. English only for proper nouns / model names.
- Tone: insightful — tell the reader WHY it matters, not just what happened.
- 摘要 length: 150-250 Chinese characters (2–3 sentences). Be substantive.
- 連結: copy verbatim from the URL field in the source data. Do NOT invent or change any URL.
- Write each item ONCE. No bilingual repetition.

## Output Format

Output ONLY the cards below — nothing before the header, nothing after the footer.

🤖 **AI Builders Digest**
📅 ${today}

[repeat this block for each card — exactly 3 parts per card:]

━━━━━━━━━━━━━━━━━━━━
{emoji} **標題：{一句話事件標題，20字以內}**
📝 摘要：{2至3句話，說明事件背景與最新進展，100至150字. Synthesize the insight — why does this matter? What is actually new?}
🔗 連結：{exact URL copied verbatim from source data}

[end of all cards]

━━━━━━━━━━━━━━━━━━━━
_由 AI 自动生成 · AI Builders Digest_

Emoji guide: 🎙️ podcast  🐦 X/Twitter  📝 blog
`;

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
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`models API ${res.status}`);
    const data = await res.json();
    const free = (data.data || [])
      .filter(m => m.id.endsWith(':free') && isCapableModel(m.id))
      .map(m => m.id);
    console.log(`Discovered ${free.length} capable free models on OpenRouter`);
    // Cap at 10 to stay within 50 req/day free-tier budget (2 workflows × 10 = 20/day)
    return free.slice(0, 10);
  } catch (err) {
    console.warn(`Could not fetch model list (${err.message}), using fallback list`);
    return FALLBACK_MODELS;
  }
}

// -- Call one model -----------------------------------------------------------

/**
 * @param {string} model
 * @param {string} prompt
 * @param {AbortSignal} [raceSignal]  — set by raceModels() to cancel losers
 */
async function callOpenRouter(model, prompt, raceSignal) {
  // Combine per-model 90s timeout with the race-winner abort signal
  const signals = [AbortSignal.timeout(90_000)];
  if (raceSignal) signals.push(raceSignal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
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
    if (err.name === 'TimeoutError') throw new Error('Timed out after 90s');
    if (err.name === 'AbortError') throw new Error('Cancelled (another model won)');
    throw err;
  }
}

// -- Race all models in parallel ---------------------------------------------

/**
 * Fires requests to all models simultaneously.
 * The first model to return a non-empty response wins.
 * All other in-flight requests are aborted immediately.
 */
async function raceModels(models, prompt) {
  const controller = new AbortController();

  const attempts = models.map(async (model) => {
    try {
      const result = await callOpenRouter(model, prompt, controller.signal);
      // This model won — cancel everyone else
      controller.abort();
      console.log(`✓ Winner: ${model}`);
      return result;
    } catch (err) {
      // Don't log cancellation noise from aborted losers
      if (!err.message.includes('Cancelled') && !controller.signal.aborted) {
        console.warn(`✗ ${model}: ${err.message.slice(0, 100)}`);
      }
      throw err;
    }
  });

  try {
    return await Promise.any(attempts);
  } catch {
    // AggregateError — every model failed
    throw new Error('All OpenRouter models failed');
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log('Reading feed data...');
  const jsonContent = await readFile(PREPARE_JSON, 'utf-8');
  const data = JSON.parse(jsonContent);
  console.log(`Feed loaded: ${data.stats?.podcastEpisodes || 0} podcasts, ${data.stats?.xBuilders || 0} builders`);

  const models = await fetchFreeModels();
  console.log(`Racing ${models.length} models in parallel…`);

  const prompt = buildPrompt(data);
  let digest = await raceModels(models, prompt);

  // Strip any markdown code fences the model may have wrapped around output
  digest = digest.replace(/^```markdown\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  await writeFile(OUTPUT_FILE, digest, 'utf-8');
  console.log(`Digest written to ${OUTPUT_FILE} (${digest.length} chars)`);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
