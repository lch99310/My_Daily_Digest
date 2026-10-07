// Shared Agnes AI caller for every digest (dc, geopo, AI builders, and the
// finance digests via lib/llm.mjs). Each digest used to carry its own copy,
// and fixes landed in one and not the others — same story as Telegram.
//
// Failure modes seen in production and how each is handled:
//
//   • Reasoning eats the output budget. agnes-2.0-flash thinks before it
//     answers, and on long prompts the thinking alone can consume max_tokens:
//     2026-10-07 geopo got finish_reason=length, completion_tokens=8500 and
//     only 600 visible chars after 13k chars of reasoning. Retrying with the
//     same cap just truncates again, so a length-truncated answer is retried
//     with a doubled budget (and a longer timeout to match).
//
//   • 429 free-tier rate limit. Retrying 2s later always 429s again and then
//     burns the last attempt. Wait for Retry-After (or a minute) once; a
//     second 429 means we're out of quota, so fall through to the next
//     provider immediately.
//
//   • "Invalid model name" 400s for a name accepted on concurrent requests,
//     5xx, network blips, and empty/stunted 200s that a fresh call answers
//     fine — all retried after a short delay.

const AGNES_URL           = 'https://apihub.agnes-ai.com/v1/chat/completions';
const AGNES_MODEL         = 'agnes-2.0-flash';
const AGNES_MAX_ATTEMPTS  = 3;
const AGNES_RETRY_DELAY   = 2_000;
const AGNES_RATE_WAIT_MAX = 60_000;    // longest we'll wait out a 429
const AGNES_MAX_TOKENS    = 32_000;    // ceiling for budget escalation (model allows 64K)
// Total wall-clock Agnes may spend across all attempts, so a slow day can't
// eat the workflow's timeout before the fallback providers get their turn.
const AGNES_TOTAL_BUDGET  = 8 * 60_000;
const AGNES_MIN_ATTEMPT   = 30_000;    // not worth starting an attempt with less
// A request that hit our own timeout is not retried: if Agnes needed >3 min
// once, another 3 min is unlikely to go better than the next provider.
const AGNES_TRANSIENT_RE  = /^Agnes (?:400|408|409|425|5\d\d)|Invalid model name|fetch failed|network|ECONN|empty response|response too short/i;

export async function callAgnes(prompt, {
  apiKey,
  maxTokens,
  minContentLength,
  responseFormat = null,   // 'json' to request strict JSON mode
  timeoutMs = 180_000,
}) {
  const deadline = Date.now() + AGNES_TOTAL_BUDGET;
  let budget     = maxTokens;
  let timeout    = timeoutMs;
  let rateWaited = false;
  let lastErr;

  for (let attempt = 1; attempt <= AGNES_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 1 && remaining < AGNES_MIN_ATTEMPT) {
      console.warn(`✗ Agnes: ${Math.round(AGNES_TOTAL_BUDGET / 60_000)}-min budget spent — falling through`);
      break;
    }
    try {
      return await callAgnesOnce(prompt, {
        apiKey, maxTokens: budget, minContentLength, responseFormat,
        timeoutMs: Math.min(timeout, remaining),
      });
    } catch (err) {
      lastErr = err;
      if (attempt === AGNES_MAX_ATTEMPTS) break;

      let wait;
      let reason = 'transient';
      if (err.status === 429) {
        reason = 'rate limited';
        if (rateWaited) break;   // still limited after waiting — out of quota
        rateWaited = true;
        wait = Math.min(err.retryAfterMs ?? AGNES_RATE_WAIT_MAX, AGNES_RATE_WAIT_MAX);
      } else if (err.truncated && budget < AGNES_MAX_TOKENS) {
        budget  = Math.min(budget * 2, AGNES_MAX_TOKENS);
        timeout = Math.round(timeout * 1.5);
        wait    = AGNES_RETRY_DELAY;
        console.warn(`✗ Agnes attempt ${attempt}/${AGNES_MAX_ATTEMPTS}: ${err.message.slice(0, 200)} — retrying with max_tokens=${budget}`);
        await sleep(wait);
        continue;
      } else if (AGNES_TRANSIENT_RE.test(err.message)) {
        wait = AGNES_RETRY_DELAY;
      } else {
        break;
      }
      console.warn(`✗ Agnes attempt ${attempt}/${AGNES_MAX_ATTEMPTS} (${reason}): ${err.message.slice(0, 200)} — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function callAgnesOnce(prompt, { apiKey, maxTokens, minContentLength, responseFormat, timeoutMs }) {
  console.log(`Trying Agnes AI (max_tokens=${maxTokens})...`);
  const body = {
    model: AGNES_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  const response = await fetch(AGNES_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Agnes ${response.status}: ${text.slice(0, 1000)}`);
    err.status = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }

  const result  = await response.json();
  const choice  = result.choices?.[0] || {};
  const content = (choice.message?.content || '').trim();
  if (content.length >= minContentLength) {
    if (choice.finish_reason === 'length') {
      console.warn(`⚠ Agnes hit max_tokens but returned ${content.length} chars — accepting (${describeCompletion(result)})`);
    }
    return content;
  }

  const err = content
    ? new Error(`Agnes response too short (${content.length} chars, need ≥${minContentLength}; ${describeCompletion(result)})`)
    : new Error(`Agnes returned empty response (${describeCompletion(result)})`);
  err.truncated = choice.finish_reason === 'length';
  throw err;
}

// An empty or stunted completion tells us nothing on its own. finish_reason and
// the token counts say whether the model hit the output cap, spent the whole
// budget on hidden reasoning, or simply returned nothing — three very different
// bugs that otherwise all read as "empty response" in the logs.
export function describeCompletion(result) {
  const choice    = result.choices?.[0] || {};
  const usage     = result.usage || {};
  const reasoning = choice.message?.reasoning_content || choice.message?.reasoning || '';
  const parts = [`finish_reason=${choice.finish_reason ?? 'n/a'}`];
  if (usage.completion_tokens != null) parts.push(`completion_tokens=${usage.completion_tokens}`);
  if (usage.reasoning_tokens  != null) parts.push(`reasoning_tokens=${usage.reasoning_tokens}`);
  if (reasoning) parts.push(`reasoning_chars=${reasoning.length}`);
  return parts.join(', ');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
