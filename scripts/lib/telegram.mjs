// Shared Telegram delivery for every digest (dc, geopo, stock, macro,
// cache-refresh, peg-review).
//
// Why this lives in one place: each digest used to carry its own copy of the
// send loop, so a reliability fix landed in one script and the others kept
// failing the same way (dc-digest got chunk retries in July; geopo-digest
// still died on a single "aborted due to timeout" in October).
//
// Telegram's edge is intermittently unreachable from GitHub-hosted runners —
// it shows up as a bare `fetch failed`, a hung connection that trips the
// abort timeout, or a transient 429/5xx. Every chunk send is therefore
// retried with backoff, each attempt with its own fresh timeout signal.

const TG_MAX_ATTEMPTS  = 5;
const TG_TIMEOUT_MS    = 20_000;
const TG_BACKOFF_MS    = [2_000, 5_000, 15_000, 30_000];   // waits between attempts
const TG_TRANSIENT_RE  = /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|terminated|aborted|timed? ?out|UND_ERR/i;
const TG_MAX_LEN       = 4000;

export function splitMessage(text, maxLen = TG_MAX_LEN) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    // Split on the newline closest to maxLen
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// Calls any Bot API method (sendMessage, sendPhoto, ...), retrying transient
// failures. Non-retryable 4xx (bad token, unknown chat, malformed entities)
// fail immediately. Throws on final failure.
export async function telegramApiWithRetry({ botToken, method, payload, label = 'telegram', tag = method }) {
  let lastErr;
  for (let attempt = 1; attempt <= TG_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // A fresh signal per attempt — reusing one AbortSignal.timeout across
        // retries makes every retry after the first abort instantly.
        signal: AbortSignal.timeout(TG_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Telegram API error ${res.status}: ${body.slice(0, 300)}`);
        err.retryable = res.status === 429 || res.status >= 500;
        if (res.status === 429) {
          try { err.retryAfterMs = (JSON.parse(body).parameters?.retry_after || 1) * 1000; }
          catch { /* fall back to default backoff */ }
        }
        throw err;
      }
      if (attempt > 1) console.log(`[${label}] ${tag} succeeded on attempt ${attempt}`);
      return await res.json().catch(() => ({}));
    } catch (err) {
      lastErr = err;
      const retryable = err.retryable ?? TG_TRANSIENT_RE.test(`${err.name} ${err.message} ${err.cause?.code || ''}`);
      if (!retryable || attempt === TG_MAX_ATTEMPTS) break;
      const wait = err.retryAfterMs ?? TG_BACKOFF_MS[attempt - 1] ?? 30_000;
      console.warn(`[${label}] ${tag} attempt ${attempt}/${TG_MAX_ATTEMPTS} failed (${describe(err).slice(0, 160)}) — retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error(describe(lastErr));
}

// undici hides the real network error (ECONNRESET, UND_ERR_CONNECT_TIMEOUT...)
// in err.cause; surface it so logs say more than "fetch failed".
function describe(err) {
  if (!err) return 'unknown error';
  return err.cause?.code ? `${err.message} [${err.cause.code}]` : err.message;
}

// Splits `text` into chunks and fans it out to every destination with a chatId.
// One destination failing does not block the others; throws only if every
// destination failed.
export async function broadcastTelegram({ botToken, destinations, text, extra = {} }) {
  const chunks  = splitMessage(text);
  const targets = destinations.filter(d => d.chatId);
  const errors  = [];
  let   delivered = 0;

  for (const { label, chatId } of targets) {
    try {
      for (let i = 0; i < chunks.length; i++) {
        const tag = `chunk ${i + 1}/${chunks.length}`;
        await telegramApiWithRetry({
          botToken, method: 'sendMessage', payload: { chat_id: chatId, text: chunks[i], ...extra }, label, tag,
        });
        console.log(`[${label}] Sent ${tag}`);
      }
      delivered++;
    } catch (err) {
      console.warn(`[${label}] delivery failed: ${err.message}`);
      errors.push(`${label}: ${err.message}`);
    }
  }

  if (delivered === 0) {
    throw new Error(`All Telegram destinations failed — ${errors.join('; ')}`);
  }
}
