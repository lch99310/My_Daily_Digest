#!/usr/bin/env node
// ============================================================================
// AI Builders Digest — Generate Digest
// Reads prepare-output.json, calls DeepSeek, outputs digest markdown.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { generate } from './lib/deepseek.mjs';
import { archiveCards } from './lib/archive.mjs';

// -- Config -------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.GITHUB_WORKSPACE || resolve(__dirname, '..');
const PREPARE_JSON = `${WORKSPACE}/scripts/prepare-output.json`;
const OUTPUT_FILE = '/tmp/follow-builders-digest.md';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

const MAX_TOKENS = 4096;

// Minimum response length — a valid digest (3–5 cards) must be at least ~600 chars.
const MIN_CONTENT_LENGTH = 600;

// On a thin day (2026-10-13: one builder, zero podcasts) a correct one-card
// digest is ~450 chars, and the 600 floor rejected every answer. main()
// lowers the floor to fit the number of source items.
const MIN_CHARS_BASE     = 200;   // header + footer
const MIN_CHARS_PER_ITEM = 150;

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
 * @returns {{ prompt: string, urlMap: Record<string, string>, sourceMap: Record<string, string> }}
 *   sourceMap names who each ID came from (show, @handle, blog) for the archive.
 */
function buildPrompt(data) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const podcasts = data.podcasts || [];
  const builders = data.x || [];
  const blogs = data.blogs || [];

  const urlMap = {};
  const sourceMap = {};

  // --- Podcasts ---
  const podcastLines = [];
  podcasts.slice(0, 5).forEach((p, i) => {
    const id = `P${i + 1}`;
    const episodeTitle = p.title || p.name || 'Unknown Episode';
    const showName = p.name && p.title ? p.name : (p.author || 'Unknown');
    const desc = (p.description || p.transcript || '')
      .replace(/\n/g, ' ').trim().slice(0, 600);
    urlMap[id] = improvePodcastUrl(p.url, p.title || p.name);
    sourceMap[id] = showName;
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
      sourceMap[id] = `@${b.handle}`;
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
    sourceMap[id] = bp.name || bp.author || 'Blog';
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
- **卡片數量**：從上述素材中挑選最具新聞價值的最多 10 則，每則一張卡片。素材不足就少寫，不得湊數、不得重複。
- **只寫素材裡的內容**：每張卡片的事實（人名、公司、產品、數字、觀點）只能來自它連結的那一則素材，不得用你自己的記憶補充細節，也不得把別人的觀點安到這位 builder 身上。
- **摘要字數**：每段 150 至 250 個繁體中文字，2 至 3 句話。
- **連結格式（關鍵）**：連結欄位**只能填入方括號 ID**（例如 [X1]、[P3]、[B2]），直接複製上方素材中的 ID。**嚴禁輸出任何 http 或 https 網址字串**，系統會在事後自動把 ID 換成真正的連結。若寫成 URL 會被視為錯誤輸出。
- 每張卡片必須包含三個欄位：標題、摘要、連結，一個都不可少。

## 輸出格式（嚴格遵守，僅輸出以下內容，前後不加任何說明）

🤖 **AI Builders Digest**
📅 ${today}

（每張卡片重複此區塊，最多 10 張）

━━━━━━━━━━━━━━━━━━━━
{emoji} **標題：{一句話事件標題，20 字以內}**
📝 摘要：{150 至 250 字的繁體中文晚點風格段落，講清楚事件本身與為何值得關注}
🔗 連結：{素材中的方括號 ID，例如 [X1]；不要寫 URL}

━━━━━━━━━━━━━━━━━━━━
_由 AI 自動生成 · AI Builders Digest_

Emoji 指引：🎙️ 播客 / 🐦 X/Twitter / 📝 部落格
`;

  return { prompt, urlMap, sourceMap };
}

// -- Substitute [ID] placeholders with real URLs -----------------------------

/**
 * Replace every `[ID]` token in the generated digest with a link to the
 * canonical URL captured in `urlMap`. Any token that doesn't resolve is stripped and its
 * containing line is replaced with a safe fallback so we never ship a raw
 * placeholder to users.
 */
function substituteUrls(digest, urlMap) {
  // deliver-telegram.js sends with parse_mode Markdown, so a short [原文](url)
  // link reads better than a raw 150-char YouTube search URL.
  let output = digest.replace(/\[([A-Z]\d{1,3})\]/g, (match, id) => {
    return urlMap[id] ? `[原文](${urlMap[id]})` : match;
  });

  // Some models ignore instructions and write URLs directly. Leave those
  // alone — they might still be valid. But strip any lingering [XN]-style
  // tokens that never matched a real ID, replacing them with a blank so the
  // line still reads cleanly.
  output = output.replace(/\[([A-Z]\d{1,3})\]/g, '');

  return output;
}

// -- Cards for the archive ----------------------------------------------------

const SECTION_BY_PREFIX = { P: '播客', X: 'X', B: '部落格' };

/**
 * Pull { section, title, summary, source, url } out of the model's digest
 * (before substituteUrls, while 連結 still holds the [X1]-style ID). A card
 * whose 連結 has no known ID is left out — it has no source to point at.
 */
function parseCards(digest, urlMap, sourceMap) {
  const cards = [];
  let card = null;
  let field = null;
  const close = () => {
    if (card?.title && card.summary && card.id) {
      cards.push({
        section: SECTION_BY_PREFIX[card.id[0]] || '',
        title:   card.title,
        summary: card.summary,
        source:  sourceMap[card.id] || '',
        url:     urlMap[card.id],
      });
    }
    card = null;
    field = null;
  };
  for (const line of digest.split('\n')) {
    const clean = line.replace(/\*\*/g, '').trim();
    let m;
    if ((m = /標題\s*[:：]\s*(.+)$/.exec(clean))) { close(); card = { title: m[1].trim() }; field = null; continue; }
    if (!card) continue;
    if ((m = /摘要\s*[:：]\s*(.*)$/.exec(clean))) { card.summary = m[1].trim(); field = 'summary'; continue; }
    if ((m = /連結\s*[:：]\s*(.*)$/.exec(clean))) {
      const id = /\[([A-Z]\d{1,3})\]/.exec(m[1])?.[1];
      if (id && urlMap[id]) card.id = id;
      close();
      continue;
    }
    if (/^[━─]{3,}/.test(clean)) { close(); continue; }
    if (field === 'summary' && clean) card.summary += clean;
  }
  close();
  return cards;
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log('Reading feed data...');
  const jsonContent = await readFile(PREPARE_JSON, 'utf-8');
  const data = JSON.parse(jsonContent);
  console.log(`Feed loaded: ${data.stats?.podcastEpisodes || 0} podcasts, ${data.stats?.xBuilders || 0} builders`);

  const { prompt, urlMap, sourceMap } = buildPrompt(data);
  console.log(`Prompt built: ${Object.keys(urlMap).length} source items with stable URL IDs`);

  // If upstream feeds returned 0 items (weekend, holiday, upstream outage,
  // or all sources >24h old) skip the LLM call entirely — asking it to
  // summarize nothing produces a sub-100-char response that just trips
  // MIN_CONTENT_LENGTH and exits the workflow red. Write a brief placeholder
  // so delivery steps still find a file and the run completes green.
  if (Object.keys(urlMap).length === 0) {
    const today = new Date().toLocaleDateString('zh-TW', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });
    const placeholder = `# 📭 ${today} — 沒有新內容\n\n` +
      `上游 feed (zarazhangrui/follow-builders) 過去 24 小時內未更新，或所有來源皆為空。明天再試。`;
    await writeFile(OUTPUT_FILE, placeholder, 'utf-8');
    console.log(`No source items in feeds — skipped LLM call, wrote placeholder to ${OUTPUT_FILE}.`);
    return;
  }

  const itemCount = Object.keys(urlMap).length;
  const minContentLength = Math.min(MIN_CONTENT_LENGTH, MIN_CHARS_BASE + MIN_CHARS_PER_ITEM * itemCount);

  let digest = await generate(prompt, {
    apiKey: DEEPSEEK_API_KEY, answerTokens: MAX_TOKENS, minContentLength,
  });

  // Strip any markdown code fences the model may have wrapped around output
  digest = digest.replace(/^```markdown\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  const archived = await archiveCards('ai', parseCards(digest, urlMap, sourceMap));
  console.log(`Archived ${archived.added} cards to ${archived.path} (${archived.skipped} already there)`);

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
