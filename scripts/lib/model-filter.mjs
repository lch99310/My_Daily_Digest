// Shared OpenRouter free-model filter.
//
// Used by geopo-digest / dc-digest / generate-digest, which each pull the live
// `:free` model list and try them in order. Keeping one implementation here
// stops the three copies from drifting.

// Parameter counts as they appear in OpenRouter ids: `-27b-`, `_8b:`, `-70b`,
// plus the "effective params" naming (`-e2b-`, `-e4b-`) used by gemma-3n.
// The size must directly follow a separator, so the `a22b` half of
// `qwen3-235b-a22b` (active params, not model size) is ignored, and it must be
// the whole token, so `235b` is never read as `2`, `23` or `35`.
const PARAM_SIZE_RE = /(?:^|[-_/])e?(\d+(?:\.\d+)?)b(?![a-z0-9])/gi;

// ≤4B params can't hold a structured multi-card prompt — they truncate or
// drift off-format. Models that don't state a size (phi-4, minimax-m2.5,
// deepseek-r1, …) are assumed capable; the response-length check catches them
// if they aren't.
const TINY_PARAM_THRESHOLD_B = 4;

export function isTinyModel(id) {
  let largest = 0;
  for (const m of id.matchAll(PARAM_SIZE_RE)) {
    largest = Math.max(largest, parseFloat(m[1]));
  }
  return largest > 0 && largest <= TINY_PARAM_THRESHOLD_B;
}

// Only block models known to return empty/broken responses.
// Do NOT block slow models here — the idle timeout handles those.
const BLOCKED_MODEL_RE = /^nvidia\/nemotron/;

export function isCapableModel(id) {
  return !isTinyModel(id) && !BLOCKED_MODEL_RE.test(id);
}
