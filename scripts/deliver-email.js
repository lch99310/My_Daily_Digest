#!/usr/bin/env node
// Email delivery standalone script for GitHub Actions
// Usage: node deliver-email.js <file>

import { readFile } from 'fs/promises';

const API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.EMAIL_TO;

async function sendEmail(text) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [TO_EMAIL],
      subject: `AI Builders Digest — ${today}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node deliver-email.js <file>');
    process.exit(1);
  }

  if (!API_KEY || !TO_EMAIL) {
    console.error('RESEND_API_KEY and EMAIL_TO must be set');
    process.exit(1);
  }

  const text = await readFile(filePath, 'utf-8');
  await sendEmail(text);
  console.log('Email delivery OK');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
