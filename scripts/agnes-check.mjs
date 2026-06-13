#!/usr/bin/env node
// ============================================================================
// Agnes AI diagnostic — agnes-check.mjs
//
// Run with: AGNES_AI_API_KEY=... node scripts/agnes-check.mjs
//
// 1. Hits /v1/models and prints the full list (this is the source of truth
//    for valid model names; the docs page can lag behind the live registry).
// 2. Sends a 1-token "ping" chat-completion using each candidate model name
//    so we can see which one the server actually accepts for our account.
// ============================================================================

const KEY = process.env.AGNES_AI_API_KEY || '';
if (!KEY) {
  console.error('ERROR: AGNES_AI_API_KEY env var is required');
  process.exit(1);
}

const BASE = 'https://apihub.agnes-ai.com/v1';
const CANDIDATES = [
  'agnes-2.0-flash',
  'Agnes-2.0-Flash',
  'agnes-2.0-flash-001',
  'agnes-flash',
  'agnes-2-flash',
];

async function listModels() {
  console.log(`\n=== GET ${BASE}/models ===`);
  const res = await fetch(`${BASE}/models`, {
    headers: { 'Authorization': `Bearer ${KEY}` },
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text);
}

async function ping(model) {
  console.log(`\n=== POST /chat/completions  model=${model} ===`);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 1500));
}

await listModels();
for (const m of CANDIDATES) {
  try { await ping(m); }
  catch (err) { console.log(`(fetch threw: ${err.message})`); }
}
