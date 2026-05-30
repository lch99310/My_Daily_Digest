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
const NEWS_LOOKBACK_HOURS = 24;
const NEWS_PER_TICKER     = 3;

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
  return {
    price:        pickNumber(quote?.regularMarketPrice, quote?.postMarketPrice),
    prevClose:    pickNumber(quote?.regularMarketPreviousClose),
    eps:          pickNumber(fund?.eps, cache.eps),
    fcfPerShare:  pickNumber(fcfPerShareFromYahoo(fund), cache.fcfPerShare),
    beta:         pickNumber(fund?.beta, cache.beta),
    growth:       pickNumber(fund?.growth5y, cache.growth5y),
    riskFree:     pickNumber(treasury10y, globals.fallbackRiskFree),
    erp:          globals.equityRiskPremium,
    pegMult:      globals.pegMultiplier,
    horizon:      globals.horizonYears,
  };
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

function renderCard(ticker, params, fairEps, fairFcf) {
  const epsFair = fairEps?.fairToday;
  const fcfFair = fairFcf?.fairToday;
  const epsGap  = Number.isFinite(epsFair) && Number.isFinite(params.price) ? (params.price - epsFair) / epsFair : NaN;
  const fcfGap  = Number.isFinite(fcfFair) && Number.isFinite(params.price) ? (params.price - fcfFair) / fcfFair : NaN;
  const reqReturn = fairEps?.requiredReturn ?? fairFcf?.requiredReturn;

  // Vertical layout — avoids CJK monospace alignment headaches on mobile fonts.
  const lines = [
    `收盤      USD ${money(params.price)}`,
    `EPS 合理價  USD ${money(epsFair)}  (${pct(epsGap)})`,
    `FCF 合理價  USD ${money(fcfFair)}  (${pct(fcfGap)})`,
  ];

  const meta = `成長 ${pctRaw(params.growth)} · Beta ${num1(params.beta)} · 要求報酬 ${pctRaw(reqReturn)}`;

  return `🔹 ${ticker.symbol} — ${ticker.zhName}\n${ticker.description}\n\n${lines.join('\n')}\n\n${meta}`;
}

function pctRaw(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function num1(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function renderNewsBlock(items) {
  if (!items || items.length === 0) return '📰 近 24h 重要新聞: 無';
  const lines = items.map(it => {
    const link = it.link ? ` (${it.link})` : '';
    return `• ${it.title} — ${it.source}${link}`;
  });
  return `📰 近 24h 重要新聞:\n${lines.join('\n')}`;
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
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunks[i], disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15_000),
        });
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
    return [tickers[i].symbol, fresh.slice(0, NEWS_PER_TICKER)];
  }));

  // -- Compose briefing -----------------------------------------------------
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const header = `📈 每日股票合理價速報\n${today}\n━━━━━━━━━━━━━━━━━━━━`;

  const cards = tickers.map(ticker => {
    const params = mergeParams(ticker, quotesBySymbol[ticker.symbol], fundamentalsBySymbol[ticker.symbol], treasury10y, globals);
    const fairEps = calcFairPriceEPS(params);
    const fairFcf = calcFairPriceFCF(params);
    const card    = renderCard(ticker, params, fairEps, fairFcf);
    const news    = renderNewsBlock(newsBySymbol[ticker.symbol]);
    const health  = renderHealthBlock(params);
    return [card, news, health].filter(Boolean).join('\n\n');
  });

  const briefing = [header, ...cards.map(c => `${c}\n━━━━━━━━━━━━━━━━━━━━`)].join('\n\n');

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
