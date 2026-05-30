#!/usr/bin/env node
// ============================================================================
// Weekly Macro Indicators Digest — macro-digest.mjs
// One Telegram card per indicator (FRED + FX + computed Buffett), each
// followed by a single-indicator QuickChart line photo. Closes with an
// SEC EDGAR XBRL-sourced AI capex table.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchSeries, summarizeSeries, toYoYSeries, fetchNextReleaseDate } from './lib/fred.mjs';
import { fetchHistory } from './lib/yahoo.mjs';
import { buildSparklineUrl, shortenChartUrl } from './lib/quickchart.mjs';
import { fetchLatestQuarterlyCapex, formatCapexB } from './lib/sec-edgar.mjs';

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

// -- Transforms -------------------------------------------------------------

function applyTransform(obs, transform) {
  if (transform === 'yoy') return toYoYSeries(obs);
  if (transform === 'mom_diff_k') {
    return obs.map((o, i) => {
      const prev = obs[i - 1];
      if (!prev) return null;
      return { date: o.date, value: o.value - prev.value };  // PAYEMS already in thousands
    }).filter(Boolean);
  }
  return obs;
}

// -- Formatting helpers -----------------------------------------------------

function fmt(value, unit, precision) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(precision)}${unit || ''}`;
}

function fmtDeltaText(curr, prev, unit, precision) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return '—';
  const d = curr - prev;
  const eps = Math.pow(10, -precision - 1);
  if (Math.abs(d) < eps) return `→ 持平 (上期 ${prev.toFixed(precision)}${unit || ''})`;
  const arrow = d > 0 ? '↑' : '↓';
  return `${arrow} ${Math.abs(d).toFixed(precision)}${unit || ''} (上期 ${prev.toFixed(precision)}${unit || ''})`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -- Card renderer ----------------------------------------------------------
// Telegram HTML mode supports <b> / <i>; we use bold for title and the
// current value to draw the eye to what matters most.

function renderCard({ shortName, zhName, description, summary, nextRelease, unit, precision, dataLabel = '數據日期' }) {
  const latestStr = fmt(summary.latest, unit, precision);
  const deltaStr  = fmtDeltaText(summary.latest, summary.previous, unit, precision);

  return [
    `🔹 <b>${escapeHtml(shortName)}</b> — ${escapeHtml(zhName)}`,
    escapeHtml(description),
    '',
    `• 最新值　　<b>${escapeHtml(latestStr)}</b>`,
    `• 變動　　　${escapeHtml(deltaStr)}`,
    `• ${dataLabel}　${escapeHtml(summary.latestDate || '—')}`,
    `• 下次發布　${escapeHtml(nextRelease || '—')}`,
  ].join('\n');
}

// -- Telegram delivery ------------------------------------------------------

const DESTINATIONS = [
  { label: 'chat',    chatId: CHAT_ID },
  { label: 'channel', chatId: CHANNEL_CHAT_ID },
].filter(d => d.chatId);

async function sendMessage(text, parseMode) {
  for (const { label, chatId } of DESTINATIONS) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendMessage failed: ${err.slice(0, 300)}`);
    }
  }
}

async function sendPhoto(photoUrl, caption) {
  for (const { label, chatId } of DESTINATIONS) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendPhoto failed: ${err.slice(0, 300)}`);
    }
  }
}

async function sendCardWithChart({ card, series, color, yUnit, captionLabel }) {
  await sendMessage(card, 'HTML');
  if (!series || series.length === 0) return;
  const longUrl = buildSparklineUrl(series, { label: captionLabel, color, yUnit });
  if (!longUrl) return;
  const url = longUrl.length > 3500 ? await shortenChartUrl(longUrl) : longUrl;
  await sendPhoto(url, captionLabel);
}

// -- Main -------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  console.log(`Fetching ${config.fred.length} FRED series + release dates...`);
  const fredObsResults = await Promise.allSettled(
    config.fred.map(cfg => fetchSeries(cfg.seriesId, { years: 5, apiKey: FRED_API_KEY })),
  );
  const fredReleaseResults = await Promise.allSettled(
    config.fred.map(cfg => fetchNextReleaseDate(cfg.seriesId, FRED_API_KEY)),
  );
  const fredEntries = config.fred.map((cfg, i) => {
    const obsR = fredObsResults[i];
    const relR = fredReleaseResults[i];
    if (obsR.status !== 'fulfilled' || obsR.value.length === 0) {
      console.warn(`  FRED ${cfg.seriesId}: ${obsR.reason?.message || 'empty'}`);
      return { cfg, error: true };
    }
    const series = applyTransform(obsR.value, cfg.transform);
    const summary = summarizeSeries(series);
    const nextRelease = relR.status === 'fulfilled' ? relR.value : null;
    return { cfg, series, summary, nextRelease };
  });

  console.log(`Fetching ${config.fx.length} Yahoo FX series...`);
  const fxResults = await Promise.allSettled(
    config.fx.map(cfg => fetchHistory(cfg.symbol, { range: '5y', interval: '1mo' })),
  );
  const fxEntries = config.fx.map((cfg, i) => {
    const r = fxResults[i];
    const series = r.status === 'fulfilled' ? r.value : [];
    if (series.length === 0) console.warn(`  FX ${cfg.symbol}: ${r.reason?.message || 'empty'}`);
    return { cfg, series, summary: summarizeSeries(series) };
  });

  console.log('Computing Buffett indicator (WILL5000IND / GDP)...');
  const wilshire = fredEntries.find(e => e.cfg.seriesId === 'WILL5000IND');
  let buffett = null;
  if (wilshire?.series?.length > 0) {
    try {
      const gdp = await fetchSeries('GDP', { years: 5, apiKey: FRED_API_KEY });
      const ratioSeries = [];
      for (const w of wilshire.series) {
        const matchingGdp = [...gdp].reverse().find(g => g.date <= w.date);
        if (!matchingGdp || matchingGdp.value === 0) continue;
        ratioSeries.push({ date: w.date, value: w.value / matchingGdp.value });
      }
      buffett = { series: ratioSeries, summary: summarizeSeries(ratioSeries) };
    } catch (err) {
      console.warn(`  Buffett compute failed: ${err.message}`);
    }
  }

  // -- Header ------------------------------------------------------------
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  await sendMessage(`📊 <b>每週總經速報</b>\n${today}`, 'HTML');

  // -- FRED cards --------------------------------------------------------
  for (const entry of fredEntries) {
    const { cfg, series, summary, nextRelease, error } = entry;
    if (error) {
      await sendMessage(`🔹 <b>${escapeHtml(cfg.shortName)}</b> — ${escapeHtml(cfg.zhName)}\n${escapeHtml(cfg.description || '')}\n\n⚠️ FRED 抓取失敗`, 'HTML');
      continue;
    }
    const card = renderCard({
      shortName: cfg.shortName,
      zhName: cfg.zhName,
      description: cfg.description || '',
      summary,
      nextRelease,
      unit: cfg.unit,
      precision: cfg.precision,
    });
    await sendCardWithChart({
      card,
      series: cfg.chart ? series : null,
      color: cfg.color,
      yUnit: cfg.unit,
      captionLabel: `${cfg.shortName} — 近 5 年`,
    });
  }

  // -- FX cards ----------------------------------------------------------
  for (const entry of fxEntries) {
    const { cfg, series, summary } = entry;
    const card = renderCard({
      shortName: cfg.shortName,
      zhName: cfg.zhName,
      description: cfg.description || '',
      summary,
      nextRelease: '即時 (交易時段內持續更新)',
      unit: cfg.unit,
      precision: cfg.precision,
      dataLabel: '參考日期',
    });
    await sendCardWithChart({
      card,
      series: cfg.chart ? series : null,
      color: cfg.color,
      yUnit: cfg.unit,
      captionLabel: `${cfg.shortName} — 近 5 年`,
    });
  }

  // -- Buffett card ------------------------------------------------------
  if (buffett) {
    const cfg = config.computed.find(c => c.id === 'buffett');
    const card = renderCard({
      shortName: cfg.shortName,
      zhName: cfg.zhName,
      description: cfg.description,
      summary: buffett.summary,
      nextRelease: '隨 Wilshire 5000 日頻更新；GDP 每季修正',
      unit: cfg.unit,
      precision: cfg.precision,
      dataLabel: '計算日期',
    });
    await sendCardWithChart({
      card,
      series: buffett.series,
      color: cfg.color,
      yUnit: cfg.unit,
      captionLabel: `${cfg.shortName} — 近 5 年`,
    });
  }

  // -- AI Capex section --------------------------------------------------
  console.log('Fetching AI capex from SEC EDGAR...');
  const publicCapex = config.capex.filter(c => !c.isPrivate && c.cik);
  const capexResults = await Promise.allSettled(
    publicCapex.map(c => fetchLatestQuarterlyCapex(c.cik)),
  );

  const capexLines = [];
  for (let i = 0; i < publicCapex.length; i++) {
    const cfg = publicCapex[i];
    const r = capexResults[i];
    if (r.status !== 'fulfilled' || !r.value) {
      capexLines.push(`• ${escapeHtml(cfg.company)}　<i>抓取失敗</i>`);
      continue;
    }
    const v = r.value;
    const deltaPct = (Number.isFinite(v.previousValue) && v.previousValue !== 0)
      ? ((v.value - v.previousValue) / v.previousValue) * 100
      : null;
    const deltaStr = deltaPct == null ? '—' : `${deltaPct >= 0 ? '↑' : '↓'} ${Math.abs(deltaPct).toFixed(0)}% vs 上一季`;
    capexLines.push(
      `• <b>${escapeHtml(cfg.company)}</b>　${formatCapexB(v.value)}  (${escapeHtml(deltaStr)})\n　${escapeHtml(v.end)} ${escapeHtml(v.fp)} 10-Q`
      + (cfg.note ? `\n　<i>${escapeHtml(cfg.note)}</i>` : '')
    );
  }
  for (const c of config.capex.filter(c => c.isPrivate)) {
    capexLines.push(`• <b>${escapeHtml(c.company)}</b>　🔒 Pre-IPO\n　<i>${escapeHtml(c.note || '依新聞估算')}</i>`);
  }

  const capexMsg = `💰 <b>AI Capex 追蹤 (最新 10-Q)</b>\n資料：SEC EDGAR XBRL\n\n${capexLines.join('\n\n')}`;
  await sendMessage(capexMsg, 'HTML');

  // -- Artifact ----------------------------------------------------------
  const briefing = [
    `📊 每週總經速報 — ${today}`,
    '',
    ...fredEntries.map(e => e.error ? `${e.cfg.shortName}: FRED 抓取失敗` : `${e.cfg.shortName}: ${fmt(e.summary.latest, e.cfg.unit, e.cfg.precision)} @ ${e.summary.latestDate} | next: ${e.nextRelease || '—'}`),
    ...fxEntries.map(e => `${e.cfg.shortName}: ${fmt(e.summary.latest, e.cfg.unit, e.cfg.precision)} @ ${e.summary.latestDate}`),
    buffett ? `Buffett: ${fmt(buffett.summary.latest, 'x', 2)} @ ${buffett.summary.latestDate}` : 'Buffett: failed',
    '',
    capexLines.map(l => l.replace(/<[^>]+>/g, '')).join('\n'),
  ].join('\n');
  await writeFile(OUTPUT_FILE, briefing, 'utf-8');
  console.log(`Briefing written to ${OUTPUT_FILE} (${briefing.length} chars)`);
  console.log('Delivered to Telegram successfully');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
