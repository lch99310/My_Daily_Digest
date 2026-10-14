// LLM call helper for the finance digests (stock news summary, PEG review).
// DeepSeek only — see lib/deepseek.mjs for the attempt order and why Agnes and
// the OpenRouter free models were dropped.

import { generate } from './deepseek.mjs';

export async function callLLMReliable(prompt, {
  maxTokens = 4000,
  minContentLength = 100,
  responseFormat = null,  // 'json' to request strict JSON mode
} = {}) {
  return generate(prompt, {
    answerTokens: maxTokens,
    minContentLength,
    responseFormat,
    // A JSON answer cut off mid-string is as useless as an empty one; check it
    // parses so the next attempt gets a chance instead of the caller failing.
    accept: responseFormat === 'json' ? assertJson : undefined,
  });
}

function assertJson(raw) {
  JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim());
  return raw;
}
