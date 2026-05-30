#!/usr/bin/env node
// ============================================================================
// Weekly Macro Indicators Digest — macro-digest.mjs
// Pulls FRED series + Yahoo indices, renders a card per indicator with an
// ASCII sparkline + latest reading, delivers via FinanceDigest Telegram bot.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchSeries, summarizeSeries, toYoYSeries } from './lib/fred.mjs';
import { fetchHistory } from './lib/yahoo.mjs';
import { renderSparkline } from './lib/sparkline.mjs';

const FRED_API_KEY    = process.env.FRED_API_KEY || '';
const BOT_TOKEN       = process.env.FINANCE_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID         = process.env.FINANCE_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID = process.env.FINANCE_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!FRED_API_KEY) { console.error('ERROR: FRED_API_KEY is required'); process.exit(1); }
if (!BOT_TOKEN)    { console.error('ERROR: FINANCE_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of FINANCE_TELEGRAM_CHAT_ID / FINANCE_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../config/macro-indicators.json');
const OUTPUT_FILE = '/tmp/macro-briefing.md';

// -- Series transforms ------------------------------------------------------

function applyTransform(obs, transform) {
  if (transform === 'yoy')      return toYoYSeries(obs);
  if (transform === 'mom_diff') {
    return obs.map((o, i) => {
      const prev = obs[i - 1];
      if (!prev) return null;
      return { date: o.date, value: (o.value - prev.value) / 1000 };  // thousands
    }).filter(Boolean);
  }
  return obs;
}

// -- Card renderers ---------------------------------------------------------

function fmt(value, unit, precision = 1) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(precision)}${unit || ''}`;
}

function renderFredCard(cfg, series) {
  const summary = summarizeSeries(series);
  const prevTxt = Number.isFinite(summary.previous)
    ? ` (${summary.deltaSign || ''} vs 上期 ${fmt(summary.previous, cfg.unit)})`
    : '';

  const spark = renderSparkline(series, { unit: cfg.unit, precision: 1 });

  return [
    `🔹 ${cfg.zhName}`,
    cfg.description,
    '',
    `最新值：${fmt(summary.latest, cfg.unit)}${prevTxt}`,
    `發布日：${summary.latestDate || '—'}    排程：${cfg.releaseSchedule || '—'}`,
    '',
    '```',
    spark,
    '```',
  ].join('\n');
}

function renderYahooCard(cfg, series) {
  if (!series || series.length === 0) {
    return `🔹 ${cfg.zhName}\n${cfg.description}\n\n(資料抓取失敗)`;
  }
  const summary = summarizeSeries(series);
  const prevTxt = Number.isFinite(summary.previous)
    ? ` (${summary.deltaSign || ''} vs 上月 ${fmt(summary.previous, cfg.unit, 2)})`
    : '';
  const spark = renderSparkline(series, { unit: cfg.unit, precision: 2 });

  return [
    `🔹 ${cfg.zhName}`,
    cfg.description,
    '',
    `最新值：${fmt(summary.latest, cfg.unit, 2)}${prevTxt}`,
    `日期：${summary.latestDate || '—'}`,
    '',
    '```',
    spark,
    '```',
  ].join('\n');
}

function renderCapexCard(cfg) {
  const tag = cfg.isPrivate ? '🔒 未上市' : `📊 上市 (${cfg.ticker})`;
  return [
    `🔹 ${cfg.company}  ${tag}`,
    cfg.note,
    cfg.isPrivate ? '⚠️ Pre-IPO，下一版預計引入新聞估算' : '⚠️ 季報數據解析尚未實作 (v2)',
  ].join('\n');
}

// -- Telegram delivery (shared shape with stock-digest) ---------------------

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

  console.log(`Fetching ${config.fred.length} FRED series...`);
  const fredResults = await Promise.allSettled(
    config.fred.map(cfg => fetchSeries(cfg.seriesId, { years: 5, apiKey: FRED_API_KEY })),
  );

  const fredCards = config.fred.map((cfg, i) => {
    const r = fredResults[i];
    if (r.status !== 'fulfilled' || r.value.length === 0) {
      console.warn(`  ${cfg.seriesId}: failed (${r.reason?.message || 'empty'})`);
      return `🔹 ${cfg.zhName}\n${cfg.description}\n\n(FRED 抓取失敗)`;
    }
    const transformed = applyTransform(r.value, cfg.transform);
    return renderFredCard(cfg, transformed);
  });

  console.log(`Fetching ${config.yahoo.length} Yahoo indices...`);
  const yahooResults = await Promise.allSettled(
    config.yahoo.map(cfg => fetchHistory(cfg.symbol, { range: '5y', interval: '1mo' })),
  );
  const yahooCards = config.yahoo.map((cfg, i) => {
    const r = yahooResults[i];
    const series = r.status === 'fulfilled' ? r.value : [];
    if (series.length === 0) {
      console.warn(`  ${cfg.symbol}: failed (${r.reason?.message || 'empty'})`);
    }
    return renderYahooCard(cfg, series);
  });

  const capexCards = config.capex.map(renderCapexCard);

  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const sections = [
    `📊 每週總經速報\n${today}\n━━━━━━━━━━━━━━━━━━━━`,
    '【宏觀指標 (FRED)】',
    ...fredCards.map(c => `${c}\n━━━━━━━━━━━━━━━━━━━━`),
    '【市場指數 / 匯率 (Yahoo)】',
    ...yahooCards.map(c => `${c}\n━━━━━━━━━━━━━━━━━━━━`),
    '【AI Capex 追蹤】',
    ...capexCards.map(c => `${c}\n━━━━━━━━━━━━━━━━━━━━`),
  ];

  const briefing = sections.join('\n\n');
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
