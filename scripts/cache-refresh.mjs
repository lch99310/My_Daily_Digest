#!/usr/bin/env node
// ============================================================================
// Monthly Cache Refresh — cache-refresh.mjs
// Pulls fresh EPS / FCF / Beta / 5Y growth from Yahoo for each ticker and
// writes back to config/stock-tickers.json.cache.
//
// Philosophy (sell-side style, not bouncer style):
//   - Always apply Yahoo's fresh value when it's available and physically
//     plausible. Don't reject "large but valid" moves — cyclical names
//     (memory, commodity) legitimately swing 50-200%/year.
//   - Hard sanity bounds catch garbage (NaN, $9999 EPS, beta=42, etc).
//   - "Notable change" thresholds tag values for human review via the
//     Telegram summary — but config IS still updated. User can manually
//     revert if a flagged value looks wrong on inspection.
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

// Hard sanity bounds — physically impossible values. Anything outside →
// reject the new value entirely (keep old). These are "no public company
// could have this number" type checks, not sentiment-based.
const HARD_BOUNDS = {
  eps:         { min: -1000, max: 1000 },   // no $1000+/share EPS exists
  fcfPerShare: { min: -1000, max: 1000 },
  beta:        { min: -2,    max: 5    },   // beta outside this is data error
  growth5y:    { min: -0.5,  max: 2.0  },   // -50% to +200% annual growth
};

// Notable-change thresholds: above these we still APPLY the new value but
// add a flag to the Telegram summary so the user can sanity-check. Tuned to
// the most volatile names in the universe (memory, commodity, lithium).
const FLAG_THRESHOLD = {
  eps:         { kind: 'rel', value: 0.50  },  // ±50% rel
  fcfPerShare: { kind: 'rel', value: 0.60  },  // ±60% rel
  beta:        { kind: 'abs', value: 0.30  },  // ±0.30 absolute
  growth5y:    { kind: 'abs', value: 0.05  },  // ±5pp absolute
};

// Noise floor: skip writeback for tiny changes (avoids commit churn).
const NOISE_FLOOR = {
  eps:         { kind: 'rel', value: 0.02  },
  fcfPerShare: { kind: 'rel', value: 0.02  },
  beta:        { kind: 'abs', value: 0.02  },
  growth5y:    { kind: 'abs', value: 0.005 },
};

const ROUNDING = {
  eps:         v => Number(v.toFixed(2)),
  fcfPerShare: v => Number(v.toFixed(2)),
  beta:        v => Number(v.toFixed(2)),
  growth5y:    v => Number(v.toFixed(3)),
};

function evaluateChange(field, oldVal, newVal) {
  if (!Number.isFinite(newVal)) return { action: 'skip', reason: 'no fresh value from Yahoo' };

  // Hard sanity check — physically impossible values get rejected outright.
  const bounds = HARD_BOUNDS[field];
  if (newVal < bounds.min || newVal > bounds.max) {
    return { action: 'reject', reason: `${newVal} outside physical bounds [${bounds.min}, ${bounds.max}]` };
  }

  // New ticker with no prior cache value → just apply.
  if (!Number.isFinite(oldVal)) return { action: 'apply', flag: false };

  const delta = newVal - oldVal;
  const absDelta = Math.abs(delta);
  const relDelta = oldVal !== 0 ? Math.abs(delta / oldVal) : Infinity;

  const noise = NOISE_FLOOR[field];
  const change = noise.kind === 'rel' ? relDelta : absDelta;
  if (change < noise.value) return { action: 'skip', reason: 'below noise floor' };

  const flagCap = FLAG_THRESHOLD[field];
  const flagChange = flagCap.kind === 'rel' ? relDelta : absDelta;
  const flag = flagChange > flagCap.value;

  return { action: 'apply', flag };
}

function formatField(field, v) {
  if (!Number.isFinite(v)) return '—';
  if (field === 'growth5y') return `${(v * 100).toFixed(1)}%`;
  return v.toFixed(2);
}

function formatChange(field, oldVal, newVal) {
  if (field === 'growth5y') {
    const pp = (newVal - oldVal) * 100;
    return `${(oldVal * 100).toFixed(1)}% → ${(newVal * 100).toFixed(1)}% (Δ${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp)`;
  }
  const pct = oldVal !== 0 ? ((newVal - oldVal) / oldVal) * 100 : NaN;
  const pctStr = Number.isFinite(pct) ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)` : '';
  return `${oldVal} → ${newVal}${pctStr}`;
}

const FIELD_LABEL = {
  eps:         'EPS',
  fcfPerShare: 'FCF/sh',
  beta:        'Beta',
  growth5y:    '成長',
};

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
  const applied = {};     // field → { old, new, flag }
  const rejected = [];    // [{ field, attempted, reason }]

  for (const field of ['eps', 'fcfPerShare', 'beta', 'growth5y']) {
    const newRaw = candidates[field];
    const oldVal = cache[field];
    const verdict = evaluateChange(field, oldVal, newRaw);
    if (verdict.action === 'apply') {
      const rounded = ROUNDING[field](newRaw);
      applied[field] = { old: oldVal, new: rounded, flag: verdict.flag };
    } else if (verdict.action === 'reject') {
      rejected.push({ field, attempted: newRaw, reason: verdict.reason });
    }
    // 'skip' is silent — either no value or no meaningful change
  }

  // Write applied values back, append audit entry if anything changed.
  if (Object.keys(applied).length > 0) {
    for (const [field, { new: v }] of Object.entries(applied)) cache[field] = v;
    cache.asOf = today;
    cache.history = Array.isArray(cache.history) ? cache.history : [];
    cache.history.push({
      date: today,
      source: 'yahoo',
      changes: Object.fromEntries(
        Object.entries(applied).map(([f, { old, new: n, flag }]) => [f, { from: old, to: n, flagged: flag }]),
      ),
    });
    if (cache.history.length > 12) cache.history = cache.history.slice(-12);
  }

  return { symbol: ticker.symbol, applied, rejected };
}

// -- Telegram with retry --------------------------------------------------

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

// -- Main -----------------------------------------------------------------

async function main() {
  const cfg = JSON.parse(await readFile(CFG_PATH, 'utf-8'));
  const today = new Date().toISOString().slice(0, 10);

  console.log(`Refreshing cache for ${cfg.tickers.length} tickers...`);
  const results = await Promise.allSettled(cfg.tickers.map(t => refreshTicker(t, today)));

  const normalUpdates = [];   // applied with no flag
  const flaggedUpdates = [];  // applied with flag (large change)
  const rejected = [];        // hit hard physical bounds
  const failed = [];          // exception (Yahoo unreachable, etc.)

  for (let i = 0; i < results.length; i++) {
    const t = cfg.tickers[i];
    const r = results[i];
    if (r.status !== 'fulfilled') {
      failed.push({ symbol: t.symbol, reason: r.reason?.message || 'unknown' });
      continue;
    }
    const { symbol, applied, rejected: rej } = r.value;
    const hasFlag = Object.values(applied).some(a => a.flag);
    if (Object.keys(applied).length > 0) {
      (hasFlag ? flaggedUpdates : normalUpdates).push({ symbol, applied });
    }
    if (rej.length > 0) rejected.push({ symbol, items: rej });
  }

  await writeFile(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  console.log(`${normalUpdates.length} normal updates, ${flaggedUpdates.length} flagged, ${rejected.length} rejected, ${failed.length} failed`);

  // -- Telegram summary -------------------------------------------------
  const monthLabel = today.slice(0, 7);
  const parts = [`🔄 <b>Monthly Cache Refresh ${monthLabel}</b>`];

  const totalUpdated = normalUpdates.length + flaggedUpdates.length;
  if (totalUpdated === 0) {
    parts.push('本月所有 ticker 維持原 cache（變動低於噪音門檻或 Yahoo 無法抓取）。');
  } else {
    parts.push(`已更新 <b>${totalUpdated}</b> 檔（其中 ${flaggedUpdates.length} 檔變動較大）。`);

    if (flaggedUpdates.length > 0) {
      parts.push('<b>⚠️ 變動較大，建議人工 review:</b>');
      for (const u of flaggedUpdates) {
        const lines = Object.entries(u.applied).map(([f, { old, new: n, flag }]) => {
          const marker = flag ? ' ⚠️' : '';
          return `  ${FIELD_LABEL[f]} ${escapeHtml(formatChange(f, old, n))}${marker}`;
        });
        parts.push(`• <b>${escapeHtml(u.symbol)}</b>\n${lines.join('\n')}`);
      }
    }

    if (normalUpdates.length > 0) {
      parts.push('<b>正常更新:</b>');
      for (const u of normalUpdates) {
        const lines = Object.entries(u.applied).map(([f, { old, new: n }]) =>
          `  ${FIELD_LABEL[f]} ${escapeHtml(formatChange(f, old, n))}`,
        );
        parts.push(`• <b>${escapeHtml(u.symbol)}</b>\n${lines.join('\n')}`);
      }
    }
  }

  if (rejected.length > 0) {
    parts.push('<b>❌ 物理範圍外，拒絕寫入:</b>');
    for (const r of rejected) {
      parts.push(`• ${escapeHtml(r.symbol)}\n${r.items.map(i => `  ${FIELD_LABEL[i.field] || i.field}: ${escapeHtml(i.reason)}`).join('\n')}`);
    }
  }

  if (failed.length > 0) {
    parts.push(`<b>抓取失敗 ${failed.length} 檔（保留原 cache）:</b> ${failed.map(f => escapeHtml(f.symbol)).join('、')}`);
  }

  parts.push('');
  parts.push('<i>flag 標記只是提醒，cache 已寫入。如數值看起來不對請手動 revert config。PEG review 將以新 cache 跑判斷。</i>');

  await sendTelegram(parts.join('\n\n'), 'HTML');
  console.log('Telegram summary sent.');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
