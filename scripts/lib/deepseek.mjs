// Shared DeepSeek caller (paid last-resort fallback for every digest).
//
// deepseek-v4-flash and v4-pro think before answering by default, and the
// hidden reasoning counts against max_tokens. 2026-10-14 geopo lost its
// briefing that way: v4-pro spent all 8500 tokens reasoning twice (empty
// answer), then v4-flash reasoned for 20k chars and returned 1279. A briefing
// is a writing task over supplied articles — it doesn't need the reasoning
// pass — so thinking is switched off and the whole budget goes to the answer.

import { describeCompletion } from './agnes.mjs';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export async function callDeepSeek(prompt, {
  apiKey,
  model = 'deepseek-v4-flash',
  maxTokens,
  minContentLength,
  responseFormat = null,   // 'json' to request strict JSON mode
  timeoutMs = 120_000,
}) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    thinking: { type: 'disabled' },
  };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  let response = await post(body, apiKey, timeoutMs);
  // If the API ever stops accepting the thinking switch, a 400 naming it
  // shouldn't cost us the briefing — retry once with the default behaviour.
  if (response.status === 400) {
    const text = await response.text();
    if (!/thinking/i.test(text)) throw new Error(`DeepSeek 400: ${text.slice(0, 300)}`);
    console.warn(`DeepSeek rejected thinking=disabled (${text.slice(0, 160)}) — retrying without it`);
    delete body.thinking;
    response = await post(body, apiKey, timeoutMs);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 300)}`);
  }

  const result  = await response.json();
  const content = (result.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error(`DeepSeek returned empty response (${describeCompletion(result)})`);
  if (content.length < minContentLength) {
    throw new Error(`DeepSeek response too short (${content.length} chars, need ≥${minContentLength}; ${describeCompletion(result)})`);
  }
  return content;
}

function post(body, apiKey, timeoutMs) {
  return fetch(DEEPSEEK_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}
