#!/usr/bin/env node
// ============================================================================
// Weekly AI Builders digest — Sunday 9am Sydney.
//
// The daily run (generate-digest.mjs) still writes its cards to
// archive/ai/YYYY-MM.jsonl every day; it no longer posts to Telegram. This
// script reads the past seven Sydney days of those cards and posts a weekly
// selection. The model only picks card numbers; title, summary and link are
// the archived card's own, so the weekly post cannot contain anything the
// daily cards did not.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generate } from './lib/deepseek.mjs';
import { sydneyDate } from './lib/archive.mjs';
import { broadcastTelegram } from './lib/telegram.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = '/tmp/ai-weekly.html';
const DELIVER = process.env.DELIVER !== 'false';
const MAX_CARDS = 10;
const PREFIX = '🧠 AI Builders｜';
const SECTION_EMOJI = { 播客: '🎙️', X: '🐦', 部落格: '📝' };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shift = (date, days) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400_000).toISOString().slice(0, 10);

export async function loadWeek(today, root = REPO_ROOT) {
  const from = shift(today, -6);
  const months = [...new Set([from.slice(0, 7), today.slice(0, 7)])];
  const cards = [];
  for (const m of months) {
    try {
      const text = await readFile(resolve(root, 'archive/ai', `${m}.jsonl`), 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const c = JSON.parse(line);
        if (c.date >= from && c.date <= today) cards.push(c);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return { from, cards };
}

/** Keep only valid, distinct card numbers, in the model's order. */
export function groundPicks(picks, count, max = MAX_CARDS) {
  const out = [];
  for (const n of Array.isArray(picks) ? picks : []) {
    const i = Number(n);
    if (Number.isInteger(i) && i >= 1 && i <= count && !out.includes(i)) out.push(i);
    if (out.length >= max) break;
  }
  return out;
}

async function pick(cards) {
  if (cards.length <= MAX_CARDS) return cards.map((_, i) => i + 1);
  const list = cards.map((c, i) => `${i + 1}. [${c.date} ${c.section}] ${c.title}｜${c.summary.slice(0, 140)}`).join('\n');
  const prompt = `以下是本週 AI builders 的每日卡片。挑出最值得讀的 ${MAX_CARDS} 張：優先選有原創觀點、產品或技術細節、對 AI 產業走向有訊號的；同一件事只留一張。只能用編號。

${list}

只輸出 JSON：{"picks":[編號,...]}`;
  try {
    const raw = await generate(prompt, {
      answerTokens: 1000, minContentLength: 5, responseFormat: 'json',
      accept: r => { JSON.parse(r.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')); return r; },
    });
    const picks = groundPicks(JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')).picks, cards.length);
    if (picks.length >= 3) return picks;
  } catch (err) {
    console.warn(`Selection failed, falling back to the newest cards: ${err.message}`);
  }
  return cards.map((_, i) => i + 1).slice(-MAX_CARDS);
}

export function render(cards, picks, from, today) {
  const f = d => d.slice(5).replace('-', '/');
  const out = [`<b>${PREFIX}週報 ${f(from)}–${f(today)}</b>`, `本週 ${cards.length} 張卡片，精選 ${picks.length} 張`, ''];
  for (const n of picks) {
    const c = cards[n - 1];
    out.push('━━━━━━━━━━━━━━━━━━━━',
      `<b>${esc(PREFIX)}${SECTION_EMOJI[c.section] || ''} ${esc(c.title)}</b>`,
      esc(c.summary),
      `${esc(c.date.slice(5))}｜<a href="${esc(c.url)}">${esc(c.source || '原文')}</a>`, '');
  }
  if (picks.length === 0) out.push('本週沒有 AI builders 卡片。');
  return out.join('\n');
}

async function main() {
  const today = sydneyDate();
  const { from, cards } = await loadWeek(today);
  console.log(`${cards.length} AI cards from ${from} to ${today}`);
  const picks = cards.length ? await pick(cards) : [];
  const text = render(cards, picks, from, today);
  await writeFile(OUTPUT_FILE, text, 'utf-8');

  if (!DELIVER || !process.env.TELEGRAM_BOT_TOKEN) { console.log('Not sending.'); return; }
  await broadcastTelegram({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    destinations: [{ label: 'ai-chat', chatId: process.env.TELEGRAM_CHAT_ID }],
    text,
    extra: { parse_mode: 'HTML', disable_web_page_preview: true },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
}
