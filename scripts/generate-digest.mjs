#!/usr/bin/env node
// ============================================================================
// AI Builders Digest — Generate Digest
// Reads prepare-output.json, calls OpenRouter LLM, outputs digest markdown.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';

// -- Config -------------------------------------------------------------------

// GITHUB_WORKSPACE is set by the workflow step (github.workspace)
// Falls back to local path derived from script location
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.GITHUB_WORKSPACE || resolve(__dirname, '..');
const PREPARE_JSON = `${WORKSPACE}/scripts/prepare-output.json`;
const OUTPUT_FILE = '/tmp/follow-builders-digest.md';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// Model priority list — avoid models known to hang on free tier
const MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'z-ai/glm-4.5-air:free',
];

const MAX_TOKENS = 4096;

// -- Build prompt from feed data --------------------------------------------

function buildPrompt(data) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const podcasts = data.podcasts || [];
  const builders = data.x || [];
  const blogs = data.blogs || [];
  const stats = data.stats || {};

  const podcastsSection = podcasts.slice(0, 5).map((p, i) =>
`${i + 1}. **${p.name || 'Unknown Podcast'}** by ${p.author || 'Unknown'}
   ${(p.description || '').replace(/\n/g, ' ').trim().slice(0, 280)}
   ${p.url ? `\n   Link: ${p.url}` : ''}`
  ).join('\n\n');

  const buildersSection = builders.slice(0, 8).map((b, i) => {
    const topTweet = (b.tweets || [])[0] || {};
    // Strip t.co shortened links from display text — they're opaque without expansion
    const text = (topTweet.text || b.bio || '')
      .replace(/https:\/\/t\.co\/\S+/g, '')
      .replace(/\n/g, ' ')
      .trim()
      .slice(0, 280);
    const url = topTweet.url || `https://x.com/${b.handle}`;
    return `${i + 1}. **@${b.handle}**${b.name ? ` (${b.name})` : ''}\n   ${text}\n   URL: ${url}`;
  }).join('\n\n');

  const blogsSection = blogs.slice(0, 3).map((b, i) =>
`${i + 1}. **${b.title || 'Untitled'}**
   ${(b.summary || '').replace(/\n/g, ' ').trim().slice(0, 200)}
   ${b.url ? `\n   Link: ${b.url}` : ''}`
  ).join('\n\n');

  return `You are writing the AI Builders Daily Digest for ${today}.

## Source Data

### Podcasts
${podcastsSection}

### X / Twitter Builders
${buildersSection}

### Blog Posts
${blogsSection}

## Instructions
- Pick the 3–5 most interesting items total across all sources
- Write each item ONCE — no bilingual repetition, no parallel paragraphs
- Language: Simplified Chinese (use English only for proper nouns/model names)
- Tone: concise, insightful — like a smart friend's WeChat message
- Each card summary: maximum 150 Chinese characters
- URLs: copy the exact URL from the source data above — do NOT invent, shorten, or modify any URL

## Output Format (strict — nothing before or after)

🤖 AI Builders Digest · ${today}

[For each item use exactly this card layout:]

{section-emoji} **{Title or @handle}**
{1–2 sentences, max 150 Chinese characters}
🔗 {exact URL from source data}

[blank line between cards]

---
_由 AI 自动生成 · AI Builders Digest_

Section emojis: 🎙️ for podcasts · 🐦 for X/Twitter · 📝 for blogs
`;
}

// -- Call OpenRouter ---------------------------------------------------------

async function callOpenRouter(model, prompt) {
  // AbortSignal.timeout() covers the FULL request lifecycle (headers + body).
  // The previous AbortController approach had a bug: clearTimeout() fired in
  // the finally block as soon as fetch() returned response headers, leaving
  // response.json() (body streaming) completely unguarded — slow models like
  // minimax could hang the body read for the entire 30-min workflow timeout.
  const signal = AbortSignal.timeout(90_000);

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`${response.status}: ${err}`);
    }

    const result = await response.json();
    return result.choices?.[0]?.message?.content || '';
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Timed out after 90s`);
    }
    throw err;
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log('Reading feed data...');
  const jsonContent = await readFile(PREPARE_JSON, 'utf-8');
  const data = JSON.parse(jsonContent);

  console.log(`Feed loaded: ${data.stats?.podcastEpisodes || 0} podcasts, ${data.stats?.xBuilders || 0} builders`);

  const prompt = buildPrompt(data);
  let digest = '';
  let usedModel = '';

  for (const model of MODELS) {
    console.log(`Trying model: ${model}...`);
    try {
      digest = await callOpenRouter(model, prompt);
      usedModel = model;
      console.log(`Success with ${model}`);
      break;
    } catch (err) {
      console.warn(`  failed: ${err.message}`);
    }
  }

  if (!digest) {
    throw new Error('All OpenRouter models failed');
  }

  // Strip any markdown code fences if the model wrapped output
  digest = digest.replace(/^```markdown\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  await writeFile(OUTPUT_FILE, digest, 'utf-8');
  console.log(`Digest written to ${OUTPUT_FILE} (${digest.length} chars, model: ${usedModel})`);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
