// The one LLM provider for every digest: DeepSeek.
//
// Agnes (free tier) and the OpenRouter free models were dropped in October
// 2026: Agnes answered 503 model_not_found on every call, and the free-model
// pool had shrunk to agentic-only, rate-limited or code models. The DC
// briefing that invented two ByteDance stories came out of that pool.
//
// Thinking mode and the token budget: deepseek-v4-pro / v4-flash reason before
// answering, and the hidden reasoning counts against max_tokens. With the old
// 8500 cap that was fatal — 2026-10-14 geopo: v4-pro spent all 8500 tokens
// reasoning (empty answer, twice). So the first attempt keeps thinking on but
// with THINKING_MAX_TOKENS of room (~10k reasoning + a 5k answer fits with
// margin); if that still comes back empty, short or rejected, the next attempts
// switch thinking off so the whole budget goes to the answer.

const DEEPSEEK_URL        = 'https://api.deepseek.com/chat/completions';
const THINKING_MAX_TOKENS = 32_000;
// Long enough for a full 32k-token thinking run (~90 tokens/s on v4-pro), short
// enough that thinking + two non-thinking retries fit a 15-minute workflow.
const THINKING_TIMEOUT    = 7 * 60_000;
const DIRECT_TIMEOUT      = 3 * 60_000;
const FALLBACK_MODEL      = 'deepseek-v4-flash';
const RETRY_DELAY         = 3_000;

/**
 * Generate text with DeepSeek, retrying until `accept` is satisfied.
 *
 * Attempts: ① `model` with thinking on (THINKING_MAX_TOKENS budget)
 *           ② `model` with thinking off (`answerTokens` budget)
 *           ③ deepseek-v4-flash with thinking off
 *
 * @param {object}   opts
 * @param {number}   opts.answerTokens      output budget when thinking is off
 * @param {number}   opts.minContentLength  shorter answers count as failures
 * @param {function} [opts.accept]          validate/transform the answer; throw to try the next attempt
 * @param {'json'}   [opts.responseFormat]  request strict JSON mode
 */
export async function generate(prompt, {
  apiKey = process.env.DEEPSEEK_API_KEY,
  model = 'deepseek-v4-flash',
  answerTokens,
  minContentLength,
  responseFormat = null,
  accept = text => text,
}) {
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');

  const attempts = [
    { model,                 thinking: true,  maxTokens: THINKING_MAX_TOKENS, timeoutMs: THINKING_TIMEOUT },
    { model,                 thinking: false, maxTokens: answerTokens,        timeoutMs: DIRECT_TIMEOUT },
    { model: FALLBACK_MODEL, thinking: false, maxTokens: answerTokens,        timeoutMs: DIRECT_TIMEOUT },
  ];

  let lastErr;
  for (const [i, a] of attempts.entries()) {
    const tag = `DeepSeek ${a.model} thinking=${a.thinking ? 'on' : 'off'} (attempt ${i + 1}/${attempts.length})`;
    console.log(`Trying ${tag}, max_tokens=${a.maxTokens}...`);
    try {
      const { content, result } = await callOnce(prompt, { apiKey, responseFormat, minContentLength, ...a });
      const out = accept(content);
      console.log(`✓ Success: ${tag} (${describeCompletion(result)})`);
      return out;
    } catch (err) {
      lastErr = err;
      console.warn(`✗ ${tag}: ${err.message.slice(0, 300)}`);
      if (i < attempts.length - 1) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
  throw new Error(`DeepSeek failed after ${attempts.length} attempts — ${lastErr?.message || 'unknown error'}`);
}

async function callOnce(prompt, { apiKey, model, thinking, maxTokens, timeoutMs, responseFormat, minContentLength }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    thinking: { type: thinking ? 'enabled' : 'disabled' },
  };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  let response = await post(body, apiKey, timeoutMs);
  // If the API ever stops accepting the thinking switch, a 400 naming it
  // shouldn't cost us the run — retry once with the model's default.
  if (response.status === 400) {
    const text = await response.text();
    if (!/thinking/i.test(text)) throw new Error(`DeepSeek 400: ${text.slice(0, 300)}`);
    console.warn(`DeepSeek rejected the thinking field (${text.slice(0, 160)}) — retrying without it`);
    delete body.thinking;
    response = await post(body, apiKey, timeoutMs);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 300)}`);
  }

  const result  = await response.json();
  const content = (result.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error(`empty response (${describeCompletion(result)})`);
  if (content.length < minContentLength) {
    throw new Error(`response too short (${content.length} chars, need ≥${minContentLength}; ${describeCompletion(result)})`);
  }
  return { content, result };
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

// An empty or stunted completion tells us nothing on its own. finish_reason and
// the token counts say whether the model hit the output cap, spent the whole
// budget on hidden reasoning, or simply returned nothing.
export function describeCompletion(result) {
  const choice    = result.choices?.[0] || {};
  const usage     = result.usage || {};
  const reasoning = choice.message?.reasoning_content || choice.message?.reasoning || '';
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  const parts = [`finish_reason=${choice.finish_reason ?? 'n/a'}`];
  if (usage.completion_tokens != null) parts.push(`completion_tokens=${usage.completion_tokens}`);
  if (reasoningTokens != null) parts.push(`reasoning_tokens=${reasoningTokens}`);
  if (reasoning) parts.push(`reasoning_chars=${reasoning.length}`);
  return parts.join(', ');
}
