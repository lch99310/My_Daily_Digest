#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest.
// Supports both local config (~/.follow-builders) and environment variables,
// making it CI-friendly (GitHub Actions).
//
// Environment variables (CI override):
//   FEED_X_URL         — URL to feed-x.json
//   FEED_PODCASTS_URL  — URL to feed-podcasts.json
//   FEED_BLOGS_URL     — URL to feed-blogs.json
//   CONFIG_LANGUAGE           — e.g. "bilingual" | "en" | "zh-CN"
//   CONFIG_FREQUENCY          — e.g. "daily"
//   CONFIG_DELIVERY_METHOD    — "telegram" | "email" | "stdout"
//   CONFIG_DELIVERY_CHAT_ID   — Telegram chat ID
//   CONFIG_DELIVERY_EMAIL     — Email address
//   CONFIG_DELIVERY_USE_BOTH  — "true" to send both channels
//   PROMPT_SUMMARIZE_PODCAST  — inline prompt (overrides file)
//   PROMPT_SUMMARIZE_TWEETS   — inline prompt (overrides file)
//   PROMPT_SUMMARIZE_BLOGS    — inline prompt (overrides file)
//   PROMPT_DIGEST_INTRO       — inline prompt (overrides file)
//   PROMPT_TRANSLATE          — inline prompt (overrides file)
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const EXTRA_BUILDERS_PATH = join(REPO_ROOT, 'config', 'extra-builders.json');

// Default feed URLs (zarazhangrui/follow-builders)
const FEED_X_URL_DEFAULT = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL_DEFAULT = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL_DEFAULT = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';

const PROMPTS_BASE = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// -- Extra builders ---------------------------------------------------------
//
// Handles listed in config/extra-builders.json are appended to the X feed so
// the AI digest can include tweets from accounts beyond the upstream list.
// Tweets are fetched via the public Twitter syndication CDN (no API key
// required); if the fetch fails, the builder is still included with an empty
// tweet array, which the 24-hour filter downstream will then drop.

async function fetchTweetsForHandle(handle) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ai-builders-digest/1.0)',
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const entries = data?.props?.pageProps?.timeline?.entries || [];
    const tweets = [];
    for (const entry of entries) {
      const t = entry?.content?.tweet || entry?.tweet || entry?.content?.item?.content?.tweet;
      if (!t) continue;
      const id = t.id_str || t.id;
      if (!id) continue;
      tweets.push({
        id,
        text: t.full_text || t.text || '',
        createdAt: t.created_at || t.createdAt || null,
        url: `https://x.com/${handle}/status/${id}`,
        likes: t.favorite_count ?? 0,
        retweets: t.retweet_count ?? 0,
        replies: t.reply_count ?? 0,
      });
    }
    return tweets;
  } catch {
    return [];
  }
}

async function loadExtraBuilders() {
  if (!existsSync(EXTRA_BUILDERS_PATH)) return [];
  try {
    const raw = await readFile(EXTRA_BUILDERS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.x) ? parsed.x : [];
    const builders = await Promise.all(list.map(async (b) => {
      if (!b?.handle) return null;
      const tweets = await fetchTweetsForHandle(b.handle);
      return {
        source: 'x',
        name: b.name || b.handle,
        handle: b.handle,
        bio: b.bio || '',
        tweets,
      };
    }));
    return builders.filter(Boolean);
  } catch (err) {
    console.warn(`Could not load extra builders: ${err.message}`);
    return [];
  }
}

function mergeBuilders(remote, extra) {
  const seen = new Set(remote.map(b => b.handle?.toLowerCase()).filter(Boolean));
  const merged = [...remote];
  for (const b of extra) {
    if (seen.has(b.handle.toLowerCase())) continue;
    merged.push(b);
  }
  return merged;
}

// -- Load env vars from .env if present (CI scenario) -----------------------

async function loadDotEnv() {
  if (existsSync(ENV_PATH)) {
    const content = await readFile(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  await loadDotEnv();

  const errors = [];

  // 1. Resolve config — env vars take priority, then local file
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };

  // Layer 1: local config file
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // Layer 2: environment variables (CI override)
  const envConfig = {
    language:          process.env.CONFIG_LANGUAGE,
    frequency:         process.env.CONFIG_FREQUENCY,
    delivery: {
      method:          process.env.CONFIG_DELIVERY_METHOD,
      chatId:          process.env.CONFIG_DELIVERY_CHAT_ID,
      email:           process.env.CONFIG_DELIVERY_EMAIL,
      useBoth:         process.env.CONFIG_DELIVERY_USE_BOTH === 'true'
    }
  };

  if (envConfig.language)           config.language  = envConfig.language;
  if (envConfig.frequency)           config.frequency  = envConfig.frequency;
  if (envConfig.delivery.method)    config.delivery.method   = envConfig.delivery.method;
  if (envConfig.delivery.chatId)    config.delivery.chatId   = envConfig.delivery.chatId;
  if (envConfig.delivery.email)     config.delivery.email    = envConfig.delivery.email;
  if (envConfig.delivery.useBoth !== undefined) {
    config.delivery.useBoth = envConfig.delivery.useBoth;
  }

  // 2. Feed URLs — env vars override defaults
  const feedXUrl        = process.env.FEED_X_URL        || FEED_X_URL_DEFAULT;
  const feedPodcastsUrl = process.env.FEED_PODCASTS_URL || FEED_PODCASTS_URL_DEFAULT;
  const feedBlogsUrl    = process.env.FEED_BLOGS_URL    || FEED_BLOGS_URL_DEFAULT;

  const [feedX, feedPodcasts, feedBlogs, extraBuilders] = await Promise.all([
    fetchJSON(feedXUrl),
    fetchJSON(feedPodcastsUrl),
    fetchJSON(feedBlogsUrl),
    loadExtraBuilders()
  ]);

  if (!feedX)        errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs)    errors.push('Could not fetch blog feed');

  const mergedX = mergeBuilders(feedX?.x || [], extraBuilders);

  // 2a. Filter every source to the last 24 hours — the feeds ship much older
  // items (podcasts use a 14-day lookback, blogs use 72h), so we re-filter
  // strictly here to guarantee the digest only contains items from the past
  // 24 hours relative to the time this script runs.
  const LOOKBACK_HOURS = 24;
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const isRecent = (dateStr) => {
    if (!dateStr) return false;
    const t = new Date(dateStr).getTime();
    return Number.isFinite(t) && t >= cutoff;
  };

  const recentPodcasts = (feedPodcasts?.podcasts || [])
    .filter(p => isRecent(p.publishedAt || p.pubDate || p.date));

  const recentX = mergedX
    .map(b => ({
      ...b,
      tweets: (b.tweets || []).filter(t => isRecent(t.createdAt || t.created_at || t.date))
    }))
    .filter(b => b.tweets.length > 0);

  const recentBlogs = (feedBlogs?.blogs || [])
    .filter(b => isRecent(b.publishedAt || b.pubDate || b.date || b.published));

  // 3. Load prompts — priority: env var > user custom > remote > local default
  const promptKeys = [
    'summarize_podcast', 'summarize_tweets', 'summarize_blogs',
    'digest_intro', 'translate'
  ];

  const prompts = {};
  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const envKey = `PROMPT_${key.toUpperCase()}`;

    // Priority 1: environment variable (CI / GitHub Actions)
    if (process.env[envKey]) {
      prompts[key] = process.env[envKey];
      continue;
    }

    // Priority 2: user custom at ~/.follow-builders/prompts/<file>
    const userPath = join(USER_DIR, 'prompts', filename);
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 3: latest from GitHub (central updates)
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    // Priority 4: local copy shipped with the skill
    const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
    const localPath = join(scriptDir, '..', 'prompts', filename);
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build output
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    lookbackHours: LOOKBACK_HOURS,

    podcasts: recentPodcasts,
    x: recentX,
    blogs: recentBlogs,

    stats: {
      podcastEpisodes: recentPodcasts.length,
      xBuilders: recentX.length,
      totalTweets: recentX.reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: recentBlogs.length,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    prompts,

    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
