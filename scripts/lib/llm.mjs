// LLM call helper for new digests (stock, macro).
// Order: Agnes AI → DeepSeek (paid, reliable) → OpenRouter free models fallback.
// Existing inline digests (dc, geopo, generate-digest) follow the same Agnes-
// first priority but use their own implementations.
//
// Rationale: finance digests carry money-decision info; reliability beats cost.

const IDLE_TIMEOUT     = 30_000;
const ABSOLUTE_TIMEOUT = 180_000;

// Free models tried after DeepSeek fails. Same list/quality bar as dc-digest.
const FREE_FALLBACK_MODELS = [
  'minimax/minimax-m2.5:free',
  'deepseek/deepseek-r1:free',
  'google/gemma-3-27b-it:free',
  'microsoft/phi-4:free',
];

export async function callLLMReliable(prompt, {
  maxTokens = 4000,
  minContentLength = 100,
  agnesKey = process.env.AGNES_AI_API_KEY,
  deepseekKey = process.env.DEEPSEEK_API_KEY,
  openrouterKey = process.env.OPENROUTER_FREE_API_KEY,
  appTitle = 'Finance Digest',
  responseFormat = null,  // 'json' to request strict JSON mode (Agnes / DeepSeek)
} = {}) {
  if (agnesKey) {
    try {
      return await _callAgnes(prompt, { maxTokens, minContentLength, apiKey: agnesKey, responseFormat });
    } catch (err) {
      // Print full Agnes error — server includes the list of available models
      // when it rejects a model name, and we want that visible in logs.
      console.warn(`✗ Agnes: ${err.message}`);
    }
  }

  if (deepseekKey) {
    try {
      return await _callDeepSeek(prompt, { maxTokens, minContentLength, apiKey: deepseekKey, responseFormat });
    } catch (err) {
      console.warn(`✗ DeepSeek: ${err.message.slice(0, 120)}`);
    }
  }

  if (openrouterKey) {
    for (const model of FREE_FALLBACK_MODELS) {
      try {
        console.log(`Trying ${model}...`);
        const result = await _callOpenRouter(model, prompt, {
          maxTokens, minContentLength, apiKey: openrouterKey, appTitle,
        });
        console.log(`✓ Success: ${model}`);
        return result;
      } catch (err) {
        console.warn(`✗ ${model}: ${err.message.slice(0, 120)}`);
      }
    }
  }

  throw new Error('All LLM providers failed (Agnes + DeepSeek + OpenRouter free)');
}

// Agnes occasionally returns "Invalid model name" 400s for a model name that
// it accepts on other requests in the same minute (observed across simultaneous
// dc/geopo/stock runs). Treat that error — plus 429/5xx — as transient and
// retry once before falling through to the next provider.
const AGNES_MAX_ATTEMPTS = 2;
const AGNES_RETRY_DELAY  = 2_000;
const AGNES_TRANSIENT_RE = /^Agnes (?:400|408|409|425|429|5\d\d)|Invalid model name|fetch failed|network|ECONN/i;

async function _callAgnes(prompt, opts) {
  let lastErr;
  for (let attempt = 1; attempt <= AGNES_MAX_ATTEMPTS; attempt++) {
    try {
      return await _callAgnesOnce(prompt, opts);
    } catch (err) {
      lastErr = err;
      const transient = AGNES_TRANSIENT_RE.test(err.message);
      if (!transient || attempt === AGNES_MAX_ATTEMPTS) throw err;
      console.warn(`✗ Agnes attempt ${attempt}/${AGNES_MAX_ATTEMPTS} (transient): ${err.message.slice(0, 200)} — retrying in ${AGNES_RETRY_DELAY / 1000}s`);
      await new Promise(r => setTimeout(r, AGNES_RETRY_DELAY));
    }
  }
  throw lastErr;
}

async function _callAgnesOnce(prompt, { maxTokens, minContentLength, apiKey, responseFormat }) {
  console.log('Calling Agnes AI...');
  const body = {
    model: 'agnes-2.0-flash',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  const response = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
    signal: AbortSignal.timeout(ABSOLUTE_TIMEOUT),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Agnes ${response.status}: ${err.slice(0, 1000)}`);
  }

  const result = await response.json();
  const content = (result.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('Agnes returned empty response');
  if (content.length < minContentLength) {
    throw new Error(`Agnes response too short (${content.length} chars, need ≥${minContentLength})`);
  }
  console.log('✓ Success: Agnes');
  return content;
}

async function _callDeepSeek(prompt, { maxTokens, minContentLength, apiKey, responseFormat }) {
  console.log('Calling DeepSeek (paid)...');
  const body = {
    model: 'deepseek-v4-flash',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    signal: AbortSignal.timeout(ABSOLUTE_TIMEOUT),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${err.slice(0, 200)}`);
  }

  const result = await response.json();
  const content = (result.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('DeepSeek returned empty response');
  if (content.length < minContentLength) {
    throw new Error(`DeepSeek response too short (${content.length} chars, need ≥${minContentLength})`);
  }
  console.log('✓ Success: DeepSeek');
  return content;
}

async function _callOpenRouter(model, prompt, { maxTokens, minContentLength, apiKey, appTitle }) {
  const controller = new AbortController();
  const absoluteTimer = setTimeout(() => controller.abort(), ABSOLUTE_TIMEOUT);

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/lch99310/My_Daily_Digest',
        'X-Title': appTitle,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(absoluteTimer);
    if (err.name === 'AbortError') throw new Error('Connection timed out');
    throw err;
  }

  if (!response.ok) {
    clearTimeout(absoluteTimer);
    const err = await response.text();
    throw new Error(`${response.status}: ${err.slice(0, 200)}`);
  }

  let content = '';
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT);
  };
  resetIdle();

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          content += delta;
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (content.length > 0) throw new Error(`Stalled after ${content.length} chars`);
      throw new Error('No tokens received — model unresponsive');
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
  }

  content = content.trim();
  if (!content) throw new Error('Empty response');
  if (content.length < minContentLength) {
    throw new Error(`Response too short (${content.length} chars, need ≥${minContentLength})`);
  }
  return content;
}
