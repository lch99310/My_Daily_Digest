#!/usr/bin/env node
// ============================================================================
// Monthly Cache Refresh — cache-refresh.mjs
// Pull fresh EPS / FCF / Beta / 5Y growth from Yahoo quoteSummary for each
// ticker; apply per-field change caps to reject noisy / corrupt data; write
// back to config/stock-tickers.json.cache and append to cache.history[].
// Runs ahead of peg-review.mjs each month so the LLM judges PEG against
// fresh fundamentals, not stale config values.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchFundamentals } from './lib/yahoo.mjs';

const BOT_TOKEN       = process.env.FINANCE_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID         = process.env.FINANCE_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID = process.env.FINANCE_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!BOT_TOKEN) { console.error('ERROR: FINANCE_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of FINANCE_TELEGRAM_CHAT_ID / FINANCE_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CFG_PATH   = resolve(__dirname, '../config/stock-tickers.json');

// Per-field change caps. Yahoo occasionally returns junk values; the caps
// reject those without us needing to babysit. Relative for ratio-like
// fields, absolute for unit-like fields (beta, growth %).
const CAPS = {
  eps:          { kind: 'rel', max: 0.25,  noise: 0.02  },  // ±25%, ignore <2% noise
  fcfPerShare:  { kind: 'rel', max: 0.30,  noise: 0.02  },  // ±30%
  beta:         { kind: 'abs', max: 0.30,  noise: 0.02  },  // ±0.30
  growth5y:     { kind: 'abs', max: 0.05,  noise: 0.005 },  // ±5pp
};

function num2(n) { return Number(n.toFixed(2)); }
function num3(n) { return Number(n.toFixed(3)); }

function evaluateChange(field, oldVal, newVal) {
  if (!Number.isFinite(oldVal) || !Number.isFinite(newVal)) {
    return { skip: true, reason: 'missing value' };
  }
  if (field === 'eps' && newVal <= 0) {
    return { skip: true, reason: 'non-positive EPS' };
  }
  const cap = CAPS[field];
  const delta = newVal - oldVal;
  const relDelta = oldVal !== 0 ? delta / oldVal : Infinity;
  const change = cap.kind === 'rel' ? Math.abs(relDelta) : Math.abs(delta);

  if (change < cap.noise) return { skip: true, reason: 'below noise floor' };
  if (change > cap.max) {
    return { reject: true, reason: `Δ ${formatDelta(field, oldVal, newVal)} > cap ±${cap.max}${cap.kind === 'rel' ? '%' : ''}` };
  }
  return { apply: true };
}

function formatField(field, v) {
  if (!Number.isFinite(v)) return '—';
  if (field === 'growth5y') return `${(v * 100).toFixed(1)}%`;
  return v.toFixed(2);
}

function formatDelta(field, oldVal, newVal) {
  if (field === 'growth5y') {
    return `${((newVal - oldVal) * 100).toFixed(1)}pp`;
  }
  return `${(((newVal - oldVal) / oldVal) * 100).toFixed(0)}%`;
}

async function refreshTicker(ticker, today) {
  const fund = await fetchFundamentals(ticker.symbol);

  const fcfPerShareNew = (Number.isFinite(fund.freeCashflow) && Number.isFinite(fund.sharesOutstanding) && fund.sharesOutstanding > 0)
    ? fund.freeCashflow / fund.sharesOutstanding
    : (Number.isFinite(fund.operatingCashflow) && Number.isFinite(fund.sharesOutstanding) && fund.sharesOutstanding > 0)
      ? fund.operatingCashflow / fund.sharesOutstanding
      : undefined;

  const candidates = {
    eps:         fund.eps,
    fcfPerShare: fcfPerShareNew,
    beta:        fund.beta,
    growth5y:    fund.growth5y,
  };

  const cache = ticker.cache;
  const applied = {};
  const rejected = [];

  for (const field of ['eps', 'fcfPerShare', 'beta', 'growth5y']) {
    const newVal = candidates[field];
    const oldVal = cache[field];
    const verdict = evaluateChange(field, oldVal, newVal);
    if (verdict.apply) {
      const rounded = field === 'growth5y' ? num3(newVal) : num2(newVal);
      applied[field] = { old: oldVal, new: rounded };
    } else if (verdict.reject) {
      rejected.push(`${field} ${formatField(field, oldVal)} → ${formatField(field, newVal)}：${verdict.reason}`);
    }
  }

  // Write applied values back into cache, record audit trail.
  if (Object.keys(applied).length > 0) {
    for (const [field, { new: v }] of Object.entries(applied)) cache[field] = v;
    cache.asOf = today;
    cache.history = Array.isArray(cache.history) ? cache.history : [];
    cache.history.push({
      date: today,
      source: 'yahoo',
      changes: Object.fromEntries(Object.entries(applied).map(([f, { old, new: n }]) => [f, { from: old, to: n }])),
    });
    if (cache.history.length > 12) cache.history = cache.history.slice(-12);
  }

  return { symbol: ticker.symbol, applied, rejected };
}

// -- Telegram (with retry) -------------------------------------------------

async function sendTelegram(text, parseMode) {
  const destinations = [
    { label: 'chat',    chatId: CHAT_ID },
    { label: 'channel', chatId: CHANNEL_CHAT_ID },
  ].filter(d => d.chatId);

  for (const { label, chatId } of destinations) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const err = await res.text();
          console.warn(`[${label}] sendMessage HTTP ${res.status}: ${err.slice(0, 200)}`);
        }
        break;
      } catch (err) {
        console.warn(`[${label}] attempt ${attempt}/3: ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -- Main ------------------------------------------------------------------

async function main() {
  const cfg = JSON.parse(await readFile(CFG_PATH, 'utf-8'));
  const today = new Date().toISOString().slice(0, 10);

  console.log(`Refreshing cache for ${cfg.tickers.length} tickers...`);
  const results = await Promise.allSettled(cfg.tickers.map(t => refreshTicker(t, today)));

  const updated = [];
  const rejected = [];
  const failed = [];

  for (let i = 0; i < results.length; i++) {
    const t = cfg.tickers[i];
    const r = results[i];
    if (r.status !== 'fulfilled') {
      failed.push({ symbol: t.symbol, reason: r.reason?.message || 'unknown' });
      continue;
    }
    const { symbol, applied, rejected: rej } = r.value;
    if (Object.keys(applied).length > 0) updated.push({ symbol, applied });
    if (rej.length > 0) rejected.push({ symbol, items: rej });
  }

  // Write back even if nothing changed — keeps JSON formatting consistent
  // and lets the workflow detect no-diff via git status.
  await writeFile(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  console.log(`Applied changes to ${updated.length} tickers, ${rejected.length} had rejected fields, ${failed.length} failed`);

  // -- Telegram summary ---------------------------------------------------
  const monthLabel = today.slice(0, 7);
  const parts = [`🔄 <b>Monthly Cache Refresh ${monthLabel}</b>`];

  if (updated.length === 0) {
    parts.push('本月所有 ticker 維持原 cache（無顯著變化或 Yahoo 抓取失敗）。');
  } else {
    parts.push(`<b>更新 ${updated.length} 檔：</b>`);
    for (const u of updated) {
      const lines = Object.entries(u.applied).map(([f, { old, new: n }]) => {
        const label = { eps: 'EPS', fcfPerShare: 'FCF/sh', beta: 'Beta', growth5y: '成長' }[f] || f;
        const fmt   = f === 'growth5y'
          ? `${(old * 100).toFixed(1)}% → ${(n * 100).toFixed(1)}%`
          : `${old} → ${n}`;
        return `  ${label} ${fmt}`;
      });
      parts.push(`• <b>${escapeHtml(u.symbol)}</b>\n${lines.join('\n')}`);
    }
  }

  if (rejected.length > 0) {
    parts.push(`<b>⚠️ 拒絕變動 (超過安全閥) — ${rejected.length} 檔：</b>`);
    for (const r of rejected) {
      parts.push(`• ${escapeHtml(r.symbol)}\n${r.items.map(i => '  ' + escapeHtml(i)).join('\n')}`);
    }
  }

  if (failed.length > 0) {
    parts.push(`<b>抓取失敗 ${failed.length} 檔：</b>${failed.map(f => escapeHtml(f.symbol)).join('、')}`);
  }

  parts.push('');
  parts.push('<i>cache 已寫回 repo；PEG review 將以新 cache 跑判斷。</i>');

  await sendTelegram(parts.join('\n\n'), 'HTML');
  console.log('Telegram summary sent.');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
