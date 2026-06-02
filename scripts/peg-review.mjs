#!/usr/bin/env node
// ============================================================================
// Monthly PEG Review — peg-review.mjs
// For each ticker: pull 30 days of news + latest AI capex trends, ask LLM
// (DeepSeek-first) to recommend a new PEG with reasoning + confidence. Apply
// safety filter (max change ±0.3, min confidence 0.7, hard floor/ceiling),
// write updates to config/stock-tickers.json, and send a Telegram summary.
// The committing back to git is done by the workflow, not this script.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { fetchFeed, dedupeByTitle, filterByAge, sortByDateDesc } from './lib/rss.mjs';
import { fetchLatestQuarterlyCapex, formatCapexB, shortPeriodLabel } from './lib/sec-edgar.mjs';
import { callLLMReliable } from './lib/llm.mjs';

const BOT_TOKEN       = process.env.FINANCE_TELEGRAM_BOT_TOKEN || '';
const CHAT_ID         = process.env.FINANCE_TELEGRAM_CHAT_ID || '';
const CHANNEL_CHAT_ID = process.env.FINANCE_TELEGRAM_CHANNEL_CHAT_ID || '';

if (!BOT_TOKEN) { console.error('ERROR: FINANCE_TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!CHAT_ID && !CHANNEL_CHAT_ID) {
  console.error('ERROR: at least one of FINANCE_TELEGRAM_CHAT_ID / FINANCE_TELEGRAM_CHANNEL_CHAT_ID is required');
  process.exit(1);
}

const __dirname        = dirname(fileURLToPath(import.meta.url));
const STOCK_CFG_PATH   = resolve(__dirname, '../config/stock-tickers.json');
const MACRO_CFG_PATH   = resolve(__dirname, '../config/macro-indicators.json');
const NEWS_LOOKBACK_HOURS = 30 * 24;  // 30 days
const NEWS_PER_TICKER     = 20;       // headlines fed to LLM per ticker

// -- News collection (Google News with 30d filter) -------------------------

async function fetchTickerNews(ticker) {
  const q = encodeURIComponent(`when:30d ${ticker.searchKeywords || ticker.symbol}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const items = await fetchFeed({ name: ticker.symbol, url, ua: 'peg-review/1.0' });
  const fresh = sortByDateDesc(dedupeByTitle(filterByAge(items, NEWS_LOOKBACK_HOURS)));
  return fresh.slice(0, NEWS_PER_TICKER);
}

// -- Capex context (reuse macro config + sec-edgar lib) --------------------

async function fetchCapexContext(macroConfig) {
  const publicEntries = macroConfig.capex.filter(c => !c.isPrivate && c.cik);
  const results = await Promise.allSettled(
    publicEntries.map(c => fetchLatestQuarterlyCapex(c.cik, { historyCount: 6 })),
  );
  const lines = [];
  for (let i = 0; i < publicEntries.length; i++) {
    const c = publicEntries[i];
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value) {
      lines.push(`- ${c.company}: 抓取失敗`);
      continue;
    }
    const v = r.value;
    const yoy = (Number.isFinite(v.previousValue) && Number.isFinite(v.yoyValue) && v.yoyValue !== 0)
      ? `YoY ${((v.value - v.yoyValue) / v.yoyValue * 100).toFixed(0)}%`
      : 'YoY n/a';
    const periodLabel = shortPeriodLabel(v.end, v.fp);
    lines.push(`- ${c.company}: ${formatCapexB(v.value)} ${periodLabel} (${yoy})`);
  }
  return lines.join('\n');
}

// -- LLM prompt ------------------------------------------------------------

function buildPrompt({ tickers, newsByTicker, capexBlock, globals }) {
  const today = new Date().toISOString().slice(0, 10);
  const floor = globals.pegReview?.absoluteFloor ?? 1.0;
  const ceiling = globals.pegReview?.absoluteCeiling ?? 2.5;
  const maxChange = globals.pegReview?.maxMonthlyChange ?? 0.3;

  const tickerBlocks = tickers.map(t => {
    const news = newsByTicker[t.symbol] || [];
    const newsLines = news.length === 0
      ? '(無新聞素材)'
      : news.map((n, i) => `${i + 1}. ${n.title}${n.desc ? ' — ' + n.desc.slice(0, 200) : ''}`).join('\n');

    // Fresh fundamentals (just refreshed by cache-refresh.mjs earlier in
    // the chain). Letting the LLM see these lets it factor in EPS/FCF
    // momentum, growth-rate revisions and beta drift — i.e. it can lower
    // PEG when growth estimates compress, raise it when EPS surprises up.
    const c = t.cache || {};
    const fundLine = [
      `EPS(TTM) ${c.eps ?? '—'}`,
      `FCF/sh ${c.fcfPerShare ?? '—'}`,
      `Beta ${c.beta ?? '—'}`,
      `5Y 成長預估 ${Number.isFinite(c.growth5y) ? (c.growth5y * 100).toFixed(1) + '%' : '—'}`,
    ].join(' · ');

    // Fundamental trajectory — last up-to-3 cache-refresh deltas. Reveals
    // whether growth/EPS are being revised up or down month over month.
    const history = Array.isArray(c.history) ? c.history.slice(-3) : [];
    const trajectoryLines = history.length > 0
      ? history.map(h => {
          const bits = [];
          if (h.changes?.eps) bits.push(`EPS ${h.changes.eps.from}→${h.changes.eps.to}`);
          if (h.changes?.fcfPerShare) bits.push(`FCF/sh ${h.changes.fcfPerShare.from}→${h.changes.fcfPerShare.to}`);
          if (h.changes?.growth5y) {
            const f = (h.changes.growth5y.from * 100).toFixed(1);
            const tt = (h.changes.growth5y.to * 100).toFixed(1);
            bits.push(`成長 ${f}%→${tt}%`);
          }
          if (h.changes?.beta) bits.push(`Beta ${h.changes.beta.from}→${h.changes.beta.to}`);
          return `  ${h.date}: ${bits.join(', ') || '(無欄位變動)'}`;
        }).join('\n')
      : '  (無歷史記錄)';

    return `### ${t.symbol} — ${t.zhName}
當前 PEG: ${t.pegOverride}
上次 PEG 調整 (${t.pegLastChange}) 理由: ${t.pegRationale}
分類描述: ${t.description}

最新基本面 (本月剛 refresh): ${fundLine}
近 3 次 cache-refresh 變化:
${trajectoryLines}

近 30 天新聞:
${newsLines}`;
  }).join('\n\n');

  return `你是 sell-side equity research 資深分析師，今天是 ${today}，月度檢視一組 AI 相關成長股的 PEG 估值倍數。

# 評估框架
PEG = 合理 P/E ÷ 預期成長率(%)。在我們的 CK 三步驟公式中，合理 P/E = 成長率% × PEG。
PEG 數值反映以下三件事的綜合：
  1. 成長品質與持續性（產品週期、TAM 擴張、競爭護城河）
  2. 多重擴張潛力（市場願意為這類資產 pay up 的程度）
  3. 風險偏好變化（macro/cycle/sentiment）

# Wall Street 慣用 PEG 區間 (你的參考錨)
- AI 純成長龍頭 (CUDA / IP licensing): 1.8 - 2.2
- AI 挑戰者: 1.6 - 1.8
- AI 基建/電力 (機房、電網、核電): 1.5 - 1.8
- AI 週期 (foundry / memory): 1.0 - 1.4

# 基本面動能怎麼解讀 (cache-refresh 給的數據)
- 成長預估下修 >3pp (例如 30% → 26%) → 通常 PEG 該下調 0.1-0.2
- 成長預估上修 >3pp → PEG 可上調 0.1-0.2
- EPS 連續上修 + FCF 連續上修 → quality momentum，PEG 可小幅上調
- Beta 上升 >0.20 → 風險加大、市場視為更不穩，PEG 該下調
- 基本面持平但新聞偏正 → PEG 維持或極小幅上調
- 注意「成長預估」(growth5y) 比 EPS 變動更重要 — 預估反映 sell-side 對未來的看法

# 任務
綜合「30 天新聞素材」、「AI 巨頭 capex 趨勢」、「公司基本面動能」三類訊號，判斷每檔 PEG 是否需要月度調整。基本面動能 (尤其是成長預估變化) 應與新聞素材並重。

# AI 巨頭 capex 趨勢 (sector context)
${capexBlock}

# 各 ticker 素材
${tickerBlocks}

# 重要規則 (硬約束)
1. 變動上限: 任一檔的新 PEG 與當前差距不可超過 ±${maxChange}。
2. 絕對範圍: 新 PEG 必須在 [${floor}, ${ceiling}] 之間。
3. 若 30 天內沒有實質改變敘事的新聞 (例如：新產品線、客戶結構變化、競爭格局重大事件、capex 顯著加速/減速)，請保持當前值不變 (peg = 當前值, confidence 也照常給)。
4. confidence 是你對「這個 PEG 是當下合理值」的把握度 (0.0-1.0)。新聞無明顯訊號時應給 0.5-0.7；有強訊號時 0.8+。

# 輸出格式 (嚴格 JSON，不要 markdown 包裹)
{
  "NVDA": { "peg": 2.0, "reason": "繁中 1-2 句 ≤80 字", "confidence": 0.85 },
  "AMD": { ... },
  ...每檔都要有，10 檔不可少
}`;
}

// -- Apply LLM recommendations with safety filter --------------------------

function applyRecommendations(tickers, recommendations, globals, today) {
  const maxChange = globals.pegReview?.maxMonthlyChange ?? 0.3;
  const minConfidence = globals.pegReview?.minConfidence ?? 0.7;
  const floor = globals.pegReview?.absoluteFloor ?? 1.0;
  const ceiling = globals.pegReview?.absoluteCeiling ?? 2.5;

  const changes = [];
  const skipped = [];

  for (const t of tickers) {
    const rec = recommendations[t.symbol];
    if (!rec || !Number.isFinite(rec.peg)) {
      skipped.push({ symbol: t.symbol, reason: 'LLM 未提供建議' });
      continue;
    }
    const newPeg = Number(rec.peg.toFixed(2));
    const oldPeg = t.pegOverride;
    const delta  = newPeg - oldPeg;
    const reason = (rec.reason || '').trim();
    const conf   = Number(rec.confidence) || 0;

    // Hard bounds
    if (newPeg < floor || newPeg > ceiling) {
      skipped.push({ symbol: t.symbol, reason: `超出絕對範圍 [${floor},${ceiling}]: ${newPeg}` });
      continue;
    }
    // Cap monthly change
    if (Math.abs(delta) > maxChange) {
      skipped.push({ symbol: t.symbol, reason: `變動 ${delta.toFixed(2)} 超過上限 ±${maxChange}` });
      continue;
    }
    // No-op
    if (Math.abs(delta) < 0.05) continue;
    // Low confidence
    if (conf < minConfidence) {
      skipped.push({ symbol: t.symbol, reason: `信心 ${conf.toFixed(2)} < ${minConfidence}` });
      continue;
    }

    // Apply
    t.pegOverride = newPeg;
    t.pegLastChange = today;
    t.pegRationale = reason;
    t.pegHistory = Array.isArray(t.pegHistory) ? t.pegHistory : [];
    t.pegHistory.push({ date: today, peg: newPeg, reason });
    // Keep last 24 entries (2 years of monthly history).
    if (t.pegHistory.length > 24) t.pegHistory = t.pegHistory.slice(-24);
    changes.push({ symbol: t.symbol, oldPeg, newPeg, reason, conf });
  }

  return { changes, skipped };
}

// -- Telegram --------------------------------------------------------------

async function sendTelegram(text, parseMode) {
  const destinations = [
    { label: 'chat',    chatId: CHAT_ID },
    { label: 'channel', chatId: CHANNEL_CHAT_ID },
  ].filter(d => d.chatId);

  for (const { label, chatId } of destinations) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const err = await res.text();
        console.warn(`[${label}] sendMessage failed: ${err.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[${label}] sendMessage threw: ${err.message}`);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -- Main ------------------------------------------------------------------

async function main() {
  const stockCfg = JSON.parse(await readFile(STOCK_CFG_PATH, 'utf-8'));
  const macroCfg = JSON.parse(await readFile(MACRO_CFG_PATH, 'utf-8'));
  const today    = new Date().toISOString().slice(0, 10);

  console.log(`Fetching 30d news for ${stockCfg.tickers.length} tickers...`);
  const newsResults = await Promise.allSettled(stockCfg.tickers.map(fetchTickerNews));
  const newsByTicker = Object.fromEntries(
    newsResults.map((r, i) => [stockCfg.tickers[i].symbol, r.status === 'fulfilled' ? r.value : []]),
  );
  const totalHeadlines = Object.values(newsByTicker).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`  collected ${totalHeadlines} headlines across ${stockCfg.tickers.length} tickers`);

  console.log('Fetching AI capex context from SEC EDGAR...');
  const capexBlock = await fetchCapexContext(macroCfg);

  console.log('Calling LLM for PEG recommendations (DeepSeek JSON mode)...');
  const prompt = buildPrompt({
    tickers: stockCfg.tickers,
    newsByTicker,
    capexBlock,
    globals: stockCfg.globals,
  });
  let raw;
  try {
    raw = await callLLMReliable(prompt, {
      maxTokens: 3000,
      minContentLength: 50,
      responseFormat: 'json',
    });
  } catch (err) {
    console.error('LLM call failed:', err.message);
    await sendTelegram(`⚠️ PEG 月度檢視失敗：LLM 不可用\n${err.message}`, undefined);
    process.exit(1);
  }

  // Strip any markdown fences in case the model added them despite json mode.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let recommendations;
  try {
    recommendations = JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse LLM JSON:', err.message);
    console.error('Raw response (first 1000 chars):', raw.slice(0, 1000));
    await sendTelegram(`⚠️ PEG 月度檢視失敗：LLM 回傳非 JSON\n${err.message}`, undefined);
    process.exit(1);
  }

  const { changes, skipped } = applyRecommendations(
    stockCfg.tickers, recommendations, stockCfg.globals, today,
  );

  // Write back even if no changes — pegHistory is unaffected and JSON is
  // stable; the workflow step skips commit when git diff is empty.
  await writeFile(STOCK_CFG_PATH, JSON.stringify(stockCfg, null, 2) + '\n', 'utf-8');
  console.log(`Applied ${changes.length} change(s), skipped ${skipped.length}`);

  // -- Compose Telegram summary -----------------------------------------
  const monthLabel = today.slice(0, 7);  // YYYY-MM
  const parts = [`📐 <b>PEG 月度檢視 ${monthLabel}</b>`];

  if (changes.length === 0) {
    parts.push('本月所有 ticker 維持原 PEG（無新聞或變化未達門檻）。');
  } else {
    parts.push(`<b>調整 ${changes.length} 檔：</b>`);
    for (const c of changes) {
      const arrow = c.newPeg > c.oldPeg ? '↑' : '↓';
      parts.push(`• ${escapeHtml(c.symbol)}　${c.oldPeg} ${arrow} <b>${c.newPeg}</b>  (信心 ${c.conf.toFixed(2)})\n  <i>${escapeHtml(c.reason)}</i>`);
    }
  }

  if (skipped.length > 0) {
    parts.push(`<b>未調整 ${skipped.length} 檔</b>（安全閥）：${skipped.map(s => escapeHtml(s.symbol)).join('、')}`);
  }

  parts.push('');
  parts.push('<i>下次跑 Daily Stock Digest 即套用新 PEG；卡片底會顯示 3 天的變更說明。</i>');

  await sendTelegram(parts.join('\n\n'), 'HTML');
  console.log('Telegram summary sent.');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
