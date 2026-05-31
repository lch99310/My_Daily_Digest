#!/usr/bin/env node
// ============================================================================
// Weekly Macro Indicators Digest — macro-digest.mjs
// One Telegram card per indicator (FRED + FX + computed Buffett), each
// followed by a single-indicator QuickChart line photo. Closes with an
// AI capex table sourced from SEC EDGAR XBRL + manual estimates for
// pre-IPO entities (OpenAI / Anthropic).
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchSeries, summarizeSeries, toYoYSeries, fetchNextReleaseDate } from './lib/fred.mjs';
import { fetchHistory } from './lib/yahoo.mjs';
import { buildSparklineUrl, buildMultiSparklineUrl, shortenChartUrl } from './lib/quickchart.mjs';
import { fetchLatestQuarterlyCapex, formatCapexB, shortPeriodLabel } from './lib/sec-edgar.mjs';

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
      return { date: o.date, value: o.value - prev.value };
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

// Visual width = 2 cols for CJK ideographs, punctuation, full-width forms,
// common pictographs, and emoji (which Telegram renders at 2× width in
// monospace blocks). Everything else = 1 col.
const WIDE_RE = /[☀-➿　-〿㐀-鿿＀-￯\u{1F300}-\u{1FAFF}]/u;
function visualWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += (WIDE_RE.test(ch) ? 2 : 1);
  return w;
}
function padTo(s, width, align = 'left') {
  const pad = Math.max(0, width - visualWidth(s));
  return align === 'right' ? ' '.repeat(pad) + s : s + ' '.repeat(pad);
}

// Throttle parallel Promises to a max concurrency. FRED's stated rate is
// 120 req/min — bursts of 20 in 1s sometimes get 429. Limit to 4 in-flight.
async function pLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (err) { out[i] = { status: 'rejected', reason: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// -- Card renderer ----------------------------------------------------------

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

// -- Telegram delivery (with retry) ----------------------------------------

const DESTINATIONS = [
  { label: 'chat',    chatId: CHAT_ID },
  { label: 'channel', chatId: CHANNEL_CHAT_ID },
].filter(d => d.chatId);

async function fetchWithRetry(url, opts, { label, attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, opts);
      return res;
    } catch (err) {
      console.warn(`[${label}] fetch attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  return null;
}

// previewUrl (Bot API 7.0+): when set, Telegram renders a preview of that URL
// BELOW the message text in the same bubble (show_above_text: false).
// We use this to put chart photos beneath each indicator card without sending
// two messages.
async function sendMessage(text, parseMode, previewUrl) {
  for (const { label, chatId } of DESTINATIONS) {
    const body = { chat_id: chatId, text, parse_mode: parseMode };
    if (previewUrl) {
      body.link_preview_options = {
        is_disabled: false,
        url: previewUrl,
        show_above_text: false,
        prefer_large_media: true,
      };
    } else {
      body.disable_web_page_preview = true;
    }
    const res = await fetchWithRetry(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
      { label },
    );
    if (!res) {
      console.warn(`[${label}] sendMessage gave up after retries`);
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendMessage HTTP ${res.status}: ${err.slice(0, 300)}`);
    }
  }
}

// Telegram caption max length when parse_mode is HTML/MarkdownV2.
const CAPTION_MAX = 1024;

async function sendPhoto(photoUrl, caption, parseMode) {
  for (const { label, chatId } of DESTINATIONS) {
    const body = { chat_id: chatId, photo: photoUrl };
    if (caption) body.caption = caption;
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetchWithRetry(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
      { label },
    );
    if (!res) {
      console.warn(`[${label}] sendPhoto gave up after retries`);
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendPhoto HTTP ${res.status}: ${err.slice(0, 300)}`);
    }
  }
}

// Send the card text with the chart attached as a *link preview* below the
// text. Single bubble, text on top, chart image on bottom — which is the
// natural reading order (sendPhoto + caption would put image first).
// QuickChart short URLs (image/png) generate Telegram previews reliably.
async function sendCardWithChart({ card, series, color, yUnit, captionLabel }) {
  let previewUrl = null;
  if (series && series.length > 0) {
    const longUrl = buildSparklineUrl(series, { label: captionLabel, color, yUnit });
    if (longUrl) {
      // Always shorten so the URL is small + cacheable by Telegram's preview
      // fetcher; long URLs (>3.5KB) often fail preview generation entirely.
      previewUrl = await shortenChartUrl(longUrl);
    }
  }
  await sendMessage(card, 'HTML', previewUrl);
}

// -- Buffett indicator: market cap (NCBEILQ027S, $B) ÷ GDP ($B) -----------

async function computeBuffett(cfg) {
  try {
    const [num, den] = await Promise.all([
      fetchSeries(cfg.numeratorSeriesId, { years: 5, apiKey: FRED_API_KEY }),
      fetchSeries(cfg.denominatorSeriesId, { years: 5, apiKey: FRED_API_KEY }),
    ]);
    if (!num.length || !den.length) return null;

    // Both quarterly — align by date prefix (YYYY-MM).
    const denByMonth = new Map(den.map(d => [d.date.slice(0, 7), d.value]));
    const series = num.map(n => {
      const v = denByMonth.get(n.date.slice(0, 7));
      if (!Number.isFinite(v) || v === 0) return null;
      return { date: n.date, value: n.value / v };
    }).filter(Boolean);

    return { series, summary: summarizeSeries(series) };
  } catch (err) {
    console.warn(`  Buffett compute failed: ${err.message}`);
    return null;
  }
}

// -- Capex table renderer --------------------------------------------------

function renderCapexTable(rows) {
  // Sort by capex value desc; failed rows sink to the bottom.
  const sorted = [...rows].sort((a, b) => {
    const av = Number.isFinite(a.sortValue) ? a.sortValue : -Infinity;
    const bv = Number.isFinite(b.sortValue) ? b.sortValue : -Infinity;
    return bv - av;
  });

  // Five short columns. Total width ~38-40 cols — wider than v1 (was 30)
  // to use more of the Telegram bubble's horizontal real estate, narrower
  // than the surrounding HTML text so we don't force the bubble to grow.
  const headers = ['公司', 'Capex', 'QoQ', 'YoY', '期間'];
  const cols = ['name', 'value', 'qoq', 'yoy', 'period'];
  const widths = headers.map((h, i) => Math.max(
    visualWidth(h),
    ...sorted.map(r => visualWidth(String(r[cols[i]] || '—'))),
  ));

  const sep = widths.map(w => '─'.repeat(w)).join(' ');
  const lines = [
    headers.map((h, i) => padTo(h, widths[i])).join(' '),
    sep,
    ...sorted.map(r => [
      padTo(r.name   || '—', widths[0]),
      padTo(r.value  || '—', widths[1], 'right'),
      padTo(r.qoq    || '—', widths[2], 'right'),
      padTo(r.yoy    || '—', widths[3], 'right'),
      padTo(r.period || '—', widths[4]),
    ].join(' ')),
  ];
  return lines.join('\n');
}

// "2026-03-31" → "26Q1"; "2025-12-31" → "25Q4". Used for chart x-axis ticks
// so MSFT (fiscal Q3 ending Mar) and AMZN (calendar Q1 ending Mar) share the
// same tick at calendar Q1. Table column keeps each company's reported fp.
function endDateToCalQ(end) {
  if (!end || end.length < 7) return end || '—';
  const yr = end.slice(2, 4);
  const m  = parseInt(end.slice(5, 7), 10);
  if (m <= 3)  return `${yr}Q1`;
  if (m <= 6)  return `${yr}Q2`;
  if (m <= 9)  return `${yr}Q3`;
  return `${yr}Q4`;
}

function fmtDeltaPct(curr, base) {
  if (!Number.isFinite(curr) || !Number.isFinite(base) || base === 0) return '—';
  const pct = ((curr - base) / base) * 100;
  return `${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(0)}%`;
}

// -- Main -------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  console.log(`Fetching ${config.fred.length} FRED series + release dates (concurrency 2, ~1.4 req/sec)…`);
  const fredObsResults = await pLimit(
    config.fred, 2,
    cfg => fetchSeries(cfg.seriesId, { years: 5, apiKey: FRED_API_KEY }),
  );
  const fredReleaseResults = await pLimit(
    config.fred, 2,
    cfg => fetchNextReleaseDate(cfg.seriesId, FRED_API_KEY),
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

  console.log(`Fetching ${config.fx.length} Yahoo FX/index series...`);
  const fxResults = await Promise.allSettled(
    config.fx.map(cfg => fetchHistory(cfg.symbol, { range: '5y', interval: '1mo' })),
  );
  const fxEntries = config.fx.map((cfg, i) => {
    const r = fxResults[i];
    const series = r.status === 'fulfilled' ? r.value : [];
    if (series.length === 0) console.warn(`  FX ${cfg.symbol}: ${r.reason?.message || 'empty'}`);
    return { cfg, series, summary: summarizeSeries(series) };
  });

  console.log('Computing Buffett indicator (NCBEILQ027S / GDP)...');
  const buffettCfg = config.computed.find(c => c.id === 'buffett');
  const buffett = await computeBuffett(buffettCfg);

  // -- Header ------------------------------------------------------------
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  await sendMessage(`📊 <b>每週總經速報</b>\n${today}`, 'HTML');

  // -- FRED cards --------------------------------------------------------
  for (const entry of fredEntries) {
    const { cfg, series, summary, nextRelease, error } = entry;
    if (error) {
      await sendMessage(
        `🔹 <b>${escapeHtml(cfg.shortName)}</b> — ${escapeHtml(cfg.zhName)}\n${escapeHtml(cfg.description || '')}\n\n⚠️ FRED 抓取失敗`,
        'HTML',
      );
      continue;
    }
    const card = renderCard({
      shortName: cfg.shortName,
      zhName: cfg.zhName,
      description: cfg.description || '',
      summary, nextRelease,
      unit: cfg.unit, precision: cfg.precision,
    });
    await sendCardWithChart({
      card,
      series: cfg.chart ? series : null,
      color: cfg.color,
      yUnit: cfg.unit,
      captionLabel: `${cfg.shortName} — 近 5 年`,
    });
  }

  // -- FX / index cards --------------------------------------------------
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
    const card = renderCard({
      shortName: buffettCfg.shortName,
      zhName: buffettCfg.zhName,
      description: buffettCfg.description,
      summary: buffett.summary,
      nextRelease: '每季 Flow of Funds 與 GDP 更新時同步',
      unit: buffettCfg.unit,
      precision: buffettCfg.precision,
      dataLabel: '計算日期',
    });
    await sendCardWithChart({
      card,
      series: buffett.series,
      color: buffettCfg.color,
      yUnit: buffettCfg.unit,
      captionLabel: `${buffettCfg.shortName} — 近 5 年`,
    });
  } else {
    await sendMessage(`🔹 <b>${escapeHtml(buffettCfg.shortName)}</b> — ${escapeHtml(buffettCfg.zhName)}\n\n⚠️ FRED 抓取失敗`, 'HTML');
  }

  // -- AI Capex table + 6-quarter trend chart ----------------------------
  console.log('Fetching AI capex from SEC EDGAR + manual estimates...');
  const publicEntries = config.capex.filter(c => !c.isPrivate && c.cik);
  const capexResults = await pLimit(
    publicEntries, 3,
    c => fetchLatestQuarterlyCapex(c.cik, { historyCount: 6 }),
  );

  const capexRows = [];
  const capexHistorySeries = [];

  for (let i = 0; i < publicEntries.length; i++) {
    const cfg = publicEntries[i];
    const r = capexResults[i];
    if (r.status !== 'fulfilled' || !r.value) {
      capexRows.push({ name: cfg.company, value: '—', qoq: '—', yoy: '—', period: '抓取失敗', sortValue: NaN });
      continue;
    }
    const v = r.value;
    capexRows.push({
      name:      cfg.company,
      value:     formatCapexB(v.value),
      qoq:       fmtDeltaPct(v.value, v.previousValue),
      yoy:       fmtDeltaPct(v.value, v.yoyValue),
      period:    shortPeriodLabel(v.end, v.fp),
      sortValue: v.value,
    });

    // Chart series: date as YYYY-MM-DD for chronological sort, displayLabel
    // as calendar-quarter label so mixed-fiscal-year companies align on the
    // same x-axis ticks (MSFT FY-Q3 ending Mar and AMZN CY-Q1 ending Mar
    // share the "26Q1" tick).
    if (Array.isArray(v.history) && v.history.length >= 2) {
      capexHistorySeries.push({
        label: cfg.company,
        points: v.history.map(h => ({
          date: h.end,
          displayLabel: endDateToCalQ(h.end),
          value: h.value / 1e9,
        })),
      });
    }
  }
  for (const c of config.capex.filter(c => c.isPrivate)) {
    const est = c.estimatedCapex;
    if (est && Number.isFinite(est.valueUSD)) {
      capexRows.push({
        name:      `${c.company} 🔒`,
        value:     formatCapexB(est.valueUSD),
        qoq:       '估算',
        yoy:       '—',
        period:    est.period,
        sortValue: est.valueUSD,
      });
    } else {
      capexRows.push({ name: `${c.company} 🔒`, value: '—', qoq: '—', yoy: '—', period: '待估算', sortValue: NaN });
    }
  }

  const capexTable = renderCapexTable(capexRows);
  const privateNotes = config.capex
    .filter(c => c.isPrivate && c.estimatedCapex)
    .map(c => `• ${c.company}：${c.estimatedCapex.source}`)
    .join('\n');
  const capexMsg =
    `💰 <b>AI Capex 追蹤</b>\n資料：SEC EDGAR XBRL (上市) + 新聞估算 (未上市，🔒)\n\n` +
    `<pre>${escapeHtml(capexTable)}</pre>` +
    (privateNotes ? `\n\n<i>未上市估算來源</i>\n${escapeHtml(privateNotes)}` : '');

  // Build trend chart (one combined line per company, last 6 periods, $B).
  let capexChartUrl = null;
  if (capexHistorySeries.length > 0) {
    const longUrl = buildMultiSparklineUrl(capexHistorySeries, {
      title: 'AI Capex 趨勢 — 近 6 期 ($B)',
      yUnit: 'B',
      width: 700,
      height: 340,
    });
    if (longUrl) {
      capexChartUrl = longUrl.length > 3500 ? await shortenChartUrl(longUrl) : longUrl;
    }
  }

  await sendMessage(capexMsg, 'HTML', capexChartUrl);

  // -- Artifact ----------------------------------------------------------
  const briefing = [
    `📊 每週總經速報 — ${today}`,
    '',
    ...fredEntries.map(e => e.error
      ? `${e.cfg.shortName}: FRED 抓取失敗`
      : `${e.cfg.shortName}: ${fmt(e.summary.latest, e.cfg.unit, e.cfg.precision)} @ ${e.summary.latestDate} | next: ${e.nextRelease || '—'}`),
    ...fxEntries.map(e => `${e.cfg.shortName}: ${fmt(e.summary.latest, e.cfg.unit, e.cfg.precision)} @ ${e.summary.latestDate || '—'}`),
    buffett ? `Buffett: ${fmt(buffett.summary.latest, 'x', 2)} @ ${buffett.summary.latestDate}` : 'Buffett: failed',
    '',
    'AI Capex:',
    capexTable,
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
