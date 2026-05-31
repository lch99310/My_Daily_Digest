#!/usr/bin/env node
// ============================================================================
// Daily Stock Fair-Price Digest — stock-digest.mjs
// Pulls live quotes + fundamentals from Yahoo, applies CK three-step formula
// to compute EPS-based and FCF-based fair prices, attaches recent per-ticker
// news, delivers via the FinanceDigest Telegram bot.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchQuotesResilient, fetchFundamentals, fetch10YTreasury } from './lib/yahoo.mjs';
import { calcFairPriceEPS, calcFairPriceFCF } from './lib/fair-price.mjs';
import { fetchFeed, dedupeByTitle, filterByAge, sortByDateDesc } from './lib/rss.mjs';
import { callLLMReliable } from './lib/llm.mjs';

const BOT_TOKEN       = process.env.FINANCE_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID         = process.env.FINANCE_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID = process.env.FINANCE_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!BOT_TOKEN) { console.error('ERROR: FINANCE_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of FINANCE_TELEGRAM_CHAT_ID / FINANCE_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../config/stock-tickers.json');
const OUTPUT_FILE = '/tmp/stock-briefing.md';
const NEWS_LOOKBACK_HOURS  = 24;
const NEWS_PER_TICKER_RAW  = 5;   // raw items fed to LLM
const NEWS_MAX_TICKER_CHARS = 250; // truncate each item before sending to LLM

// -- Data merge: prefer Yahoo live, fall back to config cache ---------------

function pickNumber(...candidates) {
  for (const c of candidates) {
    if (Number.isFinite(c) && c > 0) return c;
  }
  return undefined;
}

function fcfPerShareFromYahoo(fund) {
  if (Number.isFinite(fund?.freeCashflow) && Number.isFinite(fund?.sharesOutstanding) && fund.sharesOutstanding > 0) {
    return fund.freeCashflow / fund.sharesOutstanding;
  }
  if (Number.isFinite(fund?.operatingCashflow) && Number.isFinite(fund?.sharesOutstanding) && fund.sharesOutstanding > 0) {
    return fund.operatingCashflow / fund.sharesOutstanding;
  }
  return undefined;
}

function mergeParams(ticker, quote, fund, treasury10y, globals) {
  const cache = ticker.cache || {};
  // pegOverride per ticker > global default. Per-ticker values come from the
  // sell-side framework (AI hyper-growth ≈ 2.0, cyclical memory ≈ 1.1, etc.)
  // and are refreshed monthly by scripts/peg-review.mjs based on news + capex.
  const pegMult = Number.isFinite(ticker.pegOverride) ? ticker.pegOverride : globals.pegMultiplier;
  return {
    price:        pickNumber(quote?.regularMarketPrice, quote?.postMarketPrice),
    prevClose:    pickNumber(quote?.regularMarketPreviousClose),
    eps:          pickNumber(fund?.eps, cache.eps),
    fcfPerShare:  pickNumber(fcfPerShareFromYahoo(fund), cache.fcfPerShare),
    beta:         pickNumber(fund?.beta, cache.beta),
    growth:       pickNumber(fund?.growth5y, cache.growth5y),
    riskFree:     pickNumber(treasury10y, globals.fallbackRiskFree),
    erp:          globals.equityRiskPremium,
    pegMult,
    horizon:      globals.horizonYears,
  };
}

// PEG change rationale fades after N days (default 3). After that the card
// reverts to a clean look; rationale re-appears when monthly review actually
// changes the value.
function renderPegFooter(ticker, globals) {
  const displayDays = globals.pegReview?.displayDays ?? 3;
  if (!ticker.pegLastChange || !ticker.pegRationale) return '';
  const changedAt = Date.parse(ticker.pegLastChange);
  if (!Number.isFinite(changedAt)) return '';
  const daysOld = (Date.now() - changedAt) / 86_400_000;
  if (daysOld > displayDays) return '';
  return `📐 PEG ${ticker.pegOverride} 調整 (${ticker.pegLastChange})：${ticker.pegRationale}`;
}

// -- Card rendering ---------------------------------------------------------

function pct(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}%`;
}

function money(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

// Apply a scenario's lever multipliers. Beta stays constant (systematic risk,
// not a view variable); growth, PEG-derived P/E, and equity risk premium all
// move — that's the sell-side scenario framework.
function applyScenario(params, scenario) {
  if (!scenario) return params;
  return {
    ...params,
    growth:  Number.isFinite(params.growth)  ? params.growth  * (scenario.growthMult ?? 1) : params.growth,
    pegMult: Number.isFinite(params.pegMult) ? params.pegMult * (scenario.pegMult    ?? 1) : params.pegMult,
    erp:     Number.isFinite(params.erp)     ? params.erp     * (scenario.erpMult    ?? 1) : params.erp,
  };
}

function renderScenarioBlock(label, params) {
  const fairEps = calcFairPriceEPS(params);
  const fairFcf = calcFairPriceFCF(params);
  const epsFair = fairEps?.fairToday;
  const fcfFair = fairFcf?.fairToday;
  const epsGap  = Number.isFinite(epsFair) && Number.isFinite(params.price) ? (params.price - epsFair) / epsFair : NaN;
  const fcfGap  = Number.isFinite(fcfFair) && Number.isFinite(params.price) ? (params.price - fcfFair) / fcfFair : NaN;
  const reqReturn = fairEps?.requiredReturn ?? fairFcf?.requiredReturn;

  return [
    label,
    `EPS  USD ${money(epsFair)}  (${pct(epsGap)})`,
    `FCF  USD ${money(fcfFair)}  (${pct(fcfGap)})`,
    `成長 ${pctRaw(params.growth)} · Beta ${num1(params.beta)} · 要求報酬 ${pctRaw(reqReturn)}`,
  ].join('\n');
}

function renderCard(ticker, params, quote, scenarios) {
  // Quote epoch → MM-DD label. Yahoo returns regularMarketTime as Unix
  // seconds; Stooq fills it in too. Fallback to today if missing.
  let dateLabel = new Date().toISOString().slice(5, 10);
  if (Number.isFinite(quote?.regularMarketTime)) {
    dateLabel = new Date(quote.regularMarketTime * 1000).toISOString().slice(5, 10);
  }

  const priceLine = `收盤 (${dateLabel})  USD ${money(params.price)}`;

  const blocks = [];
  for (const key of ['base', 'bull', 'bear']) {
    const s = scenarios[key];
    if (!s) continue;
    const label = key === 'base' ? '合理價' : s.label;
    const scenarioParams = applyScenario(params, s);
    blocks.push(renderScenarioBlock(label, scenarioParams));
  }

  return `🔹 ${ticker.symbol} — ${ticker.zhName}\n${ticker.description}\n\n${priceLine}\n\n${blocks.join('\n\n')}`;
}

function pctRaw(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function num1(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function renderNewsBlock(summary) {
  if (!summary) return '📰 近 24h 重要新聞：無';
  return `📰 近 24h 重要新聞：\n${summary}`;
}

// Batched LLM news summarization. One call covers all tickers; returns a map
// of symbol → zh-TW summary string (or null when there's nothing material).
async function summarizeNewsBatch(tickers, newsBySymbol) {
  const blocks = [];
  for (const t of tickers) {
    const items = newsBySymbol[t.symbol] || [];
    if (items.length === 0) continue;
    const lines = items.slice(0, NEWS_PER_TICKER_RAW).map((it, i) =>
      `${i + 1}. ${it.title}${it.desc ? ' — ' + it.desc.slice(0, NEWS_MAX_TICKER_CHARS) : ''}`,
    );
    blocks.push(`## ${t.symbol} — ${t.zhName}\n${lines.join('\n')}`);
  }
  if (blocks.length === 0) return {};

  const prompt = `你是台灣財經編輯。閱讀以下各檔個股「近 24 小時」的英文新聞素材，用繁體中文（台灣用語）為每檔寫一段 2-3 句的精簡總結，重點放在對股價/基本面/產業地位的實際影響。冷靜克制、晚點 LatePost 風格，不要套話、不要驚嘆號、不要附連結。

若該股票的新聞都是無關緊要的雜訊（例如純技術線型、analyst 例行升降評），則該股票的值給 null。

# 新聞素材

${blocks.join('\n\n')}

# 輸出格式（嚴格遵守）

回傳純 JSON 物件，鍵為股票代號（大寫），值為繁體中文總結字串或 null。不要任何 markdown 程式區塊、不要額外文字，只回傳 JSON 本身。範例：

{"NVDA": "公司...影響...", "AMD": null}`;

  try {
    const raw = await callLLMReliable(prompt, { maxTokens: 3000, minContentLength: 50 });
    // Some models still wrap JSON in code fences; strip them.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`News LLM summarization failed: ${err.message}`);
    return {};
  }
}

function renderHealthBlock(params) {
  const missing = [];
  if (!Number.isFinite(params.eps))         missing.push('EPS');
  if (!Number.isFinite(params.fcfPerShare)) missing.push('FCF/sh');
  if (!Number.isFinite(params.beta))        missing.push('Beta');
  if (!Number.isFinite(params.growth))      missing.push('5Y growth');
  if (missing.length === 0) return '';
  return `⚠️ 缺資料 (採 config 快取): ${missing.join('、')}`;
}

// -- Telegram delivery ------------------------------------------------------

async function fetchWithRetry(url, opts, { label, attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      console.warn(`[${label}] fetch attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  return null;
}

async function sendTelegram(text) {
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  const destinations = [
    { label: 'chat',    chatId: CHAT_ID },
    { label: 'channel', chatId: CHANNEL_CHAT_ID },
  ].filter(d => d.chatId);

  const errors = [];
  let delivered = 0;

  for (const { label, chatId } of destinations) {
    try {
      for (let i = 0; i < chunks.length; i++) {
        const res = await fetchWithRetry(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: chunks[i], disable_web_page_preview: true }),
            signal: AbortSignal.timeout(15_000),
          },
          { label },
        );
        if (!res) throw new Error('all retries exhausted');
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Telegram API error: ${err.slice(0, 200)}`);
        }
        console.log(`[${label}] Sent chunk ${i + 1}/${chunks.length}`);
      }
      delivered++;
    } catch (err) {
      console.warn(`[${label}] delivery failed: ${err.message}`);
      errors.push(`${label}: ${err.message}`);
    }
  }

  if (delivered === 0) throw new Error(`All Telegram destinations failed — ${errors.join('; ')}`);
}

// -- Main -------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const globals = config.globals;
  const tickers = config.tickers;
  const symbols = tickers.map(t => t.symbol);

  console.log(`Fetching live quotes for ${symbols.length} tickers...`);
  const quotes = await fetchQuotesResilient(symbols);
  const quotesBySymbol = Object.fromEntries(quotes.map(q => [q.symbol, q]));
  const okCount = quotes.filter(q => Number.isFinite(q.regularMarketPrice)).length;
  console.log(`  got prices for ${okCount}/${symbols.length} tickers`);
  if (okCount === 0) throw new Error('Could not fetch any live quotes (Yahoo + Stooq both failed)');

  console.log('Fetching fundamentals (best-effort, falls back to config cache)...');
  const fundResults = await Promise.allSettled(tickers.map(t => fetchFundamentals(t.symbol)));
  const fundamentalsBySymbol = Object.fromEntries(
    fundResults.map((r, i) => [tickers[i].symbol, r.status === 'fulfilled' ? r.value : {}]),
  );

  console.log('Fetching 10Y treasury yield...');
  const treasury10y = await fetch10YTreasury();
  if (Number.isFinite(treasury10y)) {
    console.log(`  10Y treasury: ${(treasury10y * 100).toFixed(2)}%`);
  } else {
    console.warn(`  10Y treasury unavailable; using fallback ${(globals.fallbackRiskFree * 100).toFixed(2)}%`);
  }

  console.log('Fetching per-ticker news RSS...');
  const newsResults = await Promise.allSettled(tickers.map(t => fetchFeed({
    name: t.symbol,
    url: `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(t.symbol)}`,
    ua: 'finance-digest/1.0',
  })));
  const newsBySymbol = Object.fromEntries(newsResults.map((r, i) => {
    const items = r.status === 'fulfilled' ? r.value : [];
    const fresh = sortByDateDesc(dedupeByTitle(filterByAge(items, NEWS_LOOKBACK_HOURS)));
    return [tickers[i].symbol, fresh.slice(0, NEWS_PER_TICKER_RAW)];
  }));

  console.log('Summarizing news via LLM (DeepSeek → OpenRouter fallback)...');
  const newsSummaries = await summarizeNewsBatch(tickers, newsBySymbol);

  // -- Compose briefing -----------------------------------------------------
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const header = `📈 每日股票合理價速報\n${today}\n━━━━━━━━━━━━━━━━━━━━`;

  const cards = tickers.map(ticker => {
    const quote   = quotesBySymbol[ticker.symbol];
    const params  = mergeParams(ticker, quote, fundamentalsBySymbol[ticker.symbol], treasury10y, globals);
    const card    = renderCard(ticker, params, quote, globals.scenarios);
    const peg     = renderPegFooter(ticker, globals);
    const news    = renderNewsBlock(newsSummaries[ticker.symbol]);
    const health  = renderHealthBlock(params);
    return [card, peg, news, health].filter(Boolean).join('\n\n');
  });

  const footer = globals.scenarioFootnote
    ? `📐 ${globals.scenarioFootnote}`
    : '';
  const briefing = [
    header,
    ...cards.map(c => `${c}\n━━━━━━━━━━━━━━━━━━━━`),
    footer,
  ].filter(Boolean).join('\n\n');

  await writeFile(OUTPUT_FILE, briefing, 'utf-8');
  console.log(`Briefing written to ${OUTPUT_FILE} (${briefing.length} chars)`);

  await sendTelegram(briefing);
  console.log('Delivered to Telegram successfully');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
