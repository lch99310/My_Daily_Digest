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

// CJK width-aware padding for capex table.
const CJK_RE = /[　-鿿＀-￯]/;
function visualWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += (CJK_RE.test(ch) ? 2 : 1);
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

async function sendMessage(text, parseMode) {
  for (const { label, chatId } of DESTINATIONS) {
    const res = await fetchWithRetry(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
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

// Combine card text into the chart photo's caption so they appear in one
// Telegram bubble (image on top, formatted card text below). Falls back to
// sendMessage-only when no chart is available or caption exceeds 1024 chars.
async function sendCardWithChart({ card, series, color, yUnit, captionLabel }) {
  if (!series || series.length === 0) {
    await sendMessage(card, 'HTML');
    return;
  }
  const longUrl = buildSparklineUrl(series, { label: captionLabel, color, yUnit });
  if (!longUrl) {
    await sendMessage(card, 'HTML');
    return;
  }
  const url = longUrl.length > 3500 ? await shortenChartUrl(longUrl) : longUrl;

  if (card.length <= CAPTION_MAX) {
    await sendPhoto(url, card, 'HTML');
  } else {
    // Caption too long — degrade to two messages so nothing gets truncated.
    await sendMessage(card, 'HTML');
    await sendPhoto(url, captionLabel);
  }
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
  // Sort by capex value desc; private/failed rows go to the bottom.
  const sorted = [...rows].sort((a, b) => {
    const av = Number.isFinite(a.sortValue) ? a.sortValue : -Infinity;
    const bv = Number.isFinite(b.sortValue) ? b.sortValue : -Infinity;
    return bv - av;
  });

  const headers = ['公司', '最新 Capex', '對比', '期間'];
  const cols = ['name', 'value', 'delta', 'period'];
  const widths = headers.map((h, i) => Math.max(
    visualWidth(h),
    ...sorted.map(r => visualWidth(String(r[cols[i]] || '—'))),
  ));

  const sep = widths.map(w => '─'.repeat(w)).join('  ');
  const lines = [
    headers.map((h, i) => padTo(h, widths[i])).join('  '),
    sep,
    ...sorted.map(r => [
      padTo(r.name || '—',   widths[0]),
      padTo(r.value || '—',  widths[1], 'right'),
      padTo(r.delta || '—',  widths[2], 'right'),
      padTo(r.period || '—', widths[3]),
    ].join('  ')),
  ];
  return lines.join('\n');
}

// -- Main -------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  console.log(`Fetching ${config.fred.length} FRED series + release dates (throttled to 4/concurrent)...`);
  const fredObsResults = await pLimit(
    config.fred, 4,
    cfg => fetchSeries(cfg.seriesId, { years: 5, apiKey: FRED_API_KEY }),
  );
  const fredReleaseResults = await pLimit(
    config.fred, 4,
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
  const capexPalette = ['rgb(54,162,235)', 'rgb(255,99,132)', 'rgb(75,192,192)', 'rgb(255,159,64)', 'rgb(153,102,255)', 'rgb(255,205,86)'];

  for (let i = 0; i < publicEntries.length; i++) {
    const cfg = publicEntries[i];
    const r = capexResults[i];
    if (r.status !== 'fulfilled' || !r.value) {
      capexRows.push({ name: cfg.company, value: '—', delta: '—', period: '抓取失敗', sortValue: NaN });
      continue;
    }
    const v = r.value;
    const deltaPct = (Number.isFinite(v.previousValue) && v.previousValue !== 0)
      ? ((v.value - v.previousValue) / v.previousValue) * 100
      : null;
    const deltaStr = deltaPct == null ? '—' : `${deltaPct >= 0 ? '↑' : '↓'}${Math.abs(deltaPct).toFixed(0)}%`;
    capexRows.push({
      name:      cfg.company,
      value:     formatCapexB(v.value),
      delta:     deltaStr,
      period:    shortPeriodLabel(v.end, v.fp),
      sortValue: v.value,
    });

    // Chartable history: convert to billions for readable y-axis.
    if (Array.isArray(v.history) && v.history.length >= 2) {
      capexHistorySeries.push({
        label: cfg.company,
        points: v.history.map(h => ({
          date: shortPeriodLabel(h.end, h.fp),
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
        delta:     '估算',
        period:    est.period,
        sortValue: est.valueUSD,
      });
    } else {
      capexRows.push({ name: `${c.company} 🔒`, value: '—', delta: '—', period: '待估算', sortValue: NaN });
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

  if (capexChartUrl && capexMsg.length <= CAPTION_MAX) {
    await sendPhoto(capexChartUrl, capexMsg, 'HTML');
  } else {
    await sendMessage(capexMsg, 'HTML');
    if (capexChartUrl) await sendPhoto(capexChartUrl, 'AI Capex 趨勢 — 近 6 期 ($B)');
  }

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
