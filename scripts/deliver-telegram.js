#!/usr/bin/env node
// Telegram delivery standalone script for GitHub Actions
// Usage: node deliver-telegram.js <file>

import { readFile } from 'fs/promises';
import { splitMessage, telegramApiWithRetry } from './lib/telegram.mjs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const tag = `chunk ${i + 1}/${chunks.length}`;
    const payload = { chat_id: CHAT_ID, text: chunks[i], parse_mode: 'Markdown', disable_web_page_preview: true };
    try {
      await telegramApiWithRetry({ botToken: BOT_TOKEN, method: 'sendMessage', payload, tag });
    } catch (err) {
      // LLM output isn't always valid Telegram Markdown — resend as plain text.
      if (!err.message.includes("can't parse")) throw err;
      delete payload.parse_mode;
      await telegramApiWithRetry({ botToken: BOT_TOKEN, method: 'sendMessage', payload, tag });
    }
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node deliver-telegram.js <file>');
    process.exit(1);
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    process.exit(1);
  }

  const text = await readFile(filePath, 'utf-8');
  await sendTelegram(text);
  console.log('Telegram delivery OK');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
