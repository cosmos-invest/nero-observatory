import process from 'node:process';
import { chromium } from 'playwright-core';

const TIME_ZONE = 'Asia/Tokyo';
const DASHBOARD_URL = 'https://note.com/dashboard';
const USER_AGENT = 'NERO-OBSERVATORY/1.0 (+low-frequency personal analytics)';

function cookieValue(raw = '') {
  let text = raw.trim().replace(/^cookie:\s*/i, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text.includes('_note_session_v5=')) return text;
  const pair = text.split(';').map((v) => v.trim()).find((v) => v.startsWith('_note_session_v5='));
  return pair ? pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g, '') : '';
}

function sanitize(value, key = '') {
  if (/token|cookie|session|email|authorization|password|secret/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  }
  if (typeof value === 'string' && value.length > 120) return `[string:${value.length}]`;
  return value;
}

const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
if (!cookie) throw new Error('NOTE_SESSION_COOKIE is required');

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP', timezoneId: TIME_ZONE });
  await context.addCookies([{ name: '_note_session_v5', value: cookie, domain: '.note.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  let printed = false;
  page.on('response', async (response) => {
    if (printed) return;
    const request = response.request();
    let body;
    try { body = request.postDataJSON(); } catch { return; }
    if (body?.operationName !== 'Dashboard_StatPageQuery') return;
    printed = true;
    console.log('DASHBOARD_RANGE_TEMPLATE=' + JSON.stringify({
      operationName: body.operationName,
      variables: sanitize(body.variables ?? {}),
    }));
  });
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 40 && !printed; i += 1) await page.waitForTimeout(250);
  if (!printed) throw new Error('Dashboard_StatPageQuery was not captured');
} finally {
  await browser?.close().catch(() => {});
}
