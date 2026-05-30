#!/usr/bin/env node
// ============================================================================
// Weekly Macro Indicators Digest — macro-digest.mjs
// Renders a single combined HTML <pre> table covering FRED series + FX +
// computed Buffett Indicator, plus QuickChart trend photos grouped by theme
// (inflation / labor / rates / fx / valuation), plus an AI capex table
// sourced from SEC EDGAR XBRL filings.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchSeries, summarizeSeries, toYoYSeries } from './lib/fred.mjs';
import { fetchHistory } from './lib/yahoo.mjs';
import { buildMultiSparklineUrl, shortenChartUrl } from './lib/quickchart.mjs';
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
      return { date: o.date, value: (o.value - prev.value) };  // PAYEMS already in thousands
    }).filter(Boolean);
  }
  return obs;
}

// -- Formatting helpers -----------------------------------------------------

function fmt(value, unit, precision) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(precision)}${unit || ''}`;
}

function fmtDelta(curr, prev, unit, precision) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return '—';
  const d = curr - prev;
  if (Math.abs(d) < Math.pow(10, -precision - 1)) return '→ 0';
  const sign = d > 0 ? '↑' : '↓';
  return `${sign}${Math.abs(d).toFixed(precision)}${unit || ''}`;
}

// CJK width-aware padding. CJK Unified, punctuation, full-width forms = 2 cols.
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

// -- Indicator collection ---------------------------------------------------

async function collectFredRows(config) {
  const fredResults = await Promise.allSettled(
    config.fred.map(cfg => fetchSeries(cfg.seriesId, { years: 5, apiKey: FRED_API_KEY })),
  );
  return config.fred.map((cfg, i) => {
    const r = fredResults[i];
    if (r.status !== 'fulfilled' || r.value.length === 0) {
      console.warn(`  FRED ${cfg.seriesId}: ${r.reason?.message || 'empty'}`);
      return { cfg, error: true };
    }
    const series  = applyTransform(r.value, cfg.transform);
    const summary = summarizeSeries(series);
    return { cfg, series, summary };
  });
}

async function collectFxRows(config) {
  const fxResults = await Promise.allSettled(
    config.fx.map(cfg => fetchHistory(cfg.symbol, { range: '5y', interval: '1mo' })),
  );
  return config.fx.map((cfg, i) => {
    const r = fxResults[i];
    const series = r.status === 'fulfilled' ? r.value : [];
    if (series.length === 0) console.warn(`  FX ${cfg.symbol}: ${r.reason?.message || 'empty'}`);
    return { cfg, series, summary: summarizeSeries(series) };
  });
}

// Compute Buffett indicator from Wilshire 5000 / GDP (both FRED).
async function computeBuffett(fredRows) {
  const wilshire = fredRows.find(r => r.cfg.seriesId === 'WILL5000IND');
  if (!wilshire?.series || wilshire.series.length === 0) return null;

  let gdpSeries;
  try {
    gdpSeries = await fetchSeries('GDP', { years: 5, apiKey: FRED_API_KEY });
  } catch (err) {
    console.warn(`  GDP fetch failed: ${err.message}`);
    return null;
  }
  if (!gdpSeries || gdpSeries.length === 0) return null;

  // Build ratio series by aligning monthly Wilshire to most-recent-preceding
  // quarterly GDP value. Both are levels; GDP is in $B, Wilshire IND is in
  // points (~equivalent to $B since it's full-cap). Ratio ≈ market cap / GDP.
  const ratioSeries = [];
  for (const w of wilshire.series) {
    const wDate = w.date;
    const matchingGdp = [...gdpSeries].reverse().find(g => g.date <= wDate);
    if (!matchingGdp || matchingGdp.value === 0) continue;
    ratioSeries.push({ date: wDate, value: w.value / matchingGdp.value });
  }
  const summary = summarizeSeries(ratioSeries);
  return { series: ratioSeries, summary };
}

// -- Table rendering --------------------------------------------------------

function renderTable(rows) {
  // rows: [{ name, latest, delta, date }]
  const headers = ['指標', '最新值', '變動', '日期'];
  const widths = headers.map((h, i) => Math.max(
    visualWidth(h),
    ...rows.map(r => visualWidth(String(r[['name', 'latest', 'delta', 'date'][i]]))),
  ));

  const sep = widths.map(w => '─'.repeat(w)).join('  ');
  const lines = [];
  lines.push(headers.map((h, i) => padTo(h, widths[i])).join('  '));
  lines.push(sep);
  for (const r of rows) {
    lines.push([
      padTo(r.name,   widths[0]),
      padTo(r.latest, widths[1], 'right'),
      padTo(r.delta,  widths[2], 'right'),
      padTo(r.date,   widths[3]),
    ].join('  '));
  }
  return lines.join('\n');
}

// -- Telegram delivery ------------------------------------------------------

async function sendMessage(text, parseMode) {
  const destinations = [
    { label: 'chat',    chatId: CHAT_ID },
    { label: 'channel', chatId: CHANNEL_CHAT_ID },
  ].filter(d => d.chatId);

  for (const { label, chatId } of destinations) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendMessage failed: ${err.slice(0, 300)}`);
    } else {
      console.log(`[${label}] sent message`);
    }
  }
}

async function sendPhoto(photoUrl, caption) {
  const destinations = [
    { label: 'chat',    chatId: CHAT_ID },
    { label: 'channel', chatId: CHANNEL_CHAT_ID },
  ].filter(d => d.chatId);

  for (const { label, chatId } of destinations) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[${label}] sendPhoto failed: ${err.slice(0, 300)}`);
    } else {
      console.log(`[${label}] sent photo: ${caption}`);
    }
  }
}

// -- Main -------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  console.log(`Fetching ${config.fred.length} FRED series...`);
  const fredRows = await collectFredRows(config);

  console.log(`Fetching ${config.fx.length} Yahoo FX series...`);
  const fxRows = await collectFxRows(config);

  console.log('Computing Buffett indicator (WILL5000IND / GDP)...');
  const buffett = await computeBuffett(fredRows);

  // -- Build the master table --------------------------------------------
  const tableRows = [];
  for (const { cfg, summary, error } of fredRows) {
    if (error) {
      tableRows.push({ name: cfg.shortName, latest: '—', delta: '抓取失敗', date: '—' });
      continue;
    }
    tableRows.push({
      name:   cfg.shortName,
      latest: fmt(summary.latest, cfg.unit, cfg.precision),
      delta:  fmtDelta(summary.latest, summary.previous, cfg.unit, cfg.precision),
      date:   summary.latestDate || '—',
    });
  }
  for (const { cfg, summary } of fxRows) {
    if (!Number.isFinite(summary.latest)) {
      tableRows.push({ name: cfg.shortName, latest: '—', delta: '抓取失敗', date: '—' });
      continue;
    }
    tableRows.push({
      name:   cfg.shortName,
      latest: fmt(summary.latest, cfg.unit, cfg.precision),
      delta:  fmtDelta(summary.latest, summary.previous, cfg.unit, cfg.precision),
      date:   summary.latestDate || '—',
    });
  }
  if (buffett) {
    const cfg = config.computed.find(c => c.id === 'buffett');
    tableRows.push({
      name:   cfg.shortName,
      latest: fmt(buffett.summary.latest, cfg.unit, cfg.precision),
      delta:  fmtDelta(buffett.summary.latest, buffett.summary.previous, cfg.unit, cfg.precision),
      date:   buffett.summary.latestDate || '—',
    });
  }

  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const tableText = renderTable(tableRows);
  const headerMsg = `📊 <b>每週總經速報</b>\n${today}\n\n<pre>${escapeHtml(tableText)}</pre>`;

  console.log('Sending master table message...');
  await sendMessage(headerMsg, 'HTML');

  // -- Build & send trend charts -----------------------------------------
  // Group by chart key from config; pair series within a group.
  const seriesByChart = new Map();
  for (const { cfg, series } of fredRows) {
    if (!cfg.chart || !series) continue;
    if (!seriesByChart.has(cfg.chart)) seriesByChart.set(cfg.chart, []);
    seriesByChart.get(cfg.chart).push({ label: cfg.shortName, points: series });
  }
  for (const { cfg, series } of fxRows) {
    if (!cfg.chart || !series || series.length === 0) continue;
    if (!seriesByChart.has(cfg.chart)) seriesByChart.set(cfg.chart, []);
    seriesByChart.get(cfg.chart).push({ label: cfg.shortName, points: series });
  }
  if (buffett) {
    const cfg = config.computed.find(c => c.id === 'buffett');
    if (!seriesByChart.has('valuation')) seriesByChart.set('valuation', []);
    seriesByChart.get('valuation').push({ label: cfg.shortName, points: buffett.series });
  }

  for (const group of config.chartGroups) {
    const seriesList = seriesByChart.get(group.id);
    if (!seriesList || seriesList.length === 0) continue;
    const longUrl = buildMultiSparklineUrl(seriesList, { title: group.title, yUnit: group.yUnit });
    if (!longUrl) continue;
    const url = longUrl.length > 3500 ? await shortenChartUrl(longUrl) : longUrl;
    await sendPhoto(url, group.title);
  }

  // -- AI capex section --------------------------------------------------
  console.log('Fetching AI capex from SEC EDGAR...');
  const publicCapex = config.capex.filter(c => !c.isPrivate && c.cik);
  const capexResults = await Promise.allSettled(
    publicCapex.map(c => fetchLatestQuarterlyCapex(c.cik)),
  );

  const capexRows = [];
  for (let i = 0; i < publicCapex.length; i++) {
    const cfg = publicCapex[i];
    const r = capexResults[i];
    if (r.status !== 'fulfilled' || !r.value) {
      capexRows.push({ name: cfg.company, latest: '—', delta: '抓取失敗', date: '—' });
      continue;
    }
    const v = r.value;
    capexRows.push({
      name:   cfg.company,
      latest: formatCapexB(v.value),
      delta:  Number.isFinite(v.previousValue) ? fmtCapexDelta(v.value, v.previousValue) : '—',
      date:   `${v.end} (${v.fp})`,
    });
  }
  for (const c of config.capex.filter(c => c.isPrivate)) {
    capexRows.push({
      name:   c.company,
      latest: '🔒 Pre-IPO',
      delta:  '—',
      date:   c.note || '依新聞估算',
    });
  }

  const capexTable = renderTable(capexRows);
  const capexMsg = `💰 <b>AI Capex 追蹤 (最新 10-Q)</b>\n\n<pre>${escapeHtml(capexTable)}</pre>\n\n資料：SEC EDGAR XBRL`;
  await sendMessage(capexMsg, 'HTML');

  // -- Persist briefing artifact ----------------------------------------
  const briefing = [
    `📊 每週總經速報 — ${today}`,
    '',
    tableText,
    '',
    '💰 AI Capex 追蹤',
    capexTable,
  ].join('\n');
  await writeFile(OUTPUT_FILE, briefing, 'utf-8');
  console.log(`Briefing written to ${OUTPUT_FILE} (${briefing.length} chars)`);
  console.log('Delivered to Telegram successfully');
}

function fmtCapexDelta(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return '—';
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct >= 0 ? '↑' : '↓';
  return `${sign}${Math.abs(pct).toFixed(0)}%`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
