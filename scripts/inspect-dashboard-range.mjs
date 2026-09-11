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
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  if (typeof value === 'string' && value.length > 180) return `[string:${value.length}]`;
  return value;
}

const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
if (!cookie) throw new Error('NOTE_SESSION_COOKIE is required');

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP', timezoneId: TIME_ZONE });
  await context.addCookies([{ name: '_note_session_v5', value: cookie, domain: '.note.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const captures = [];

  page.on('response', async (response) => {
    const request = response.request();
    let body;
    try { body = request.postDataJSON(); } catch { return; }
    if (body?.operationName !== 'Dashboard_StatPageQuery') return;
    const variables = sanitize(body.variables ?? {});
    const signature = JSON.stringify(variables);
    if (!captures.some((row) => row.signature === signature)) {
      captures.push({ signature, variables });
      console.log('DASHBOARD_RANGE_CAPTURE=' + JSON.stringify(variables));
    }
  });

  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(10_000);
  if (/login|signin/.test(page.url())) throw new Error('note session redirected to login');

  const periodSelect = page.locator('select').filter({ hasText: 'カスタム' }).first();
  if (!await periodSelect.isVisible().catch(() => false)) throw new Error('period select was not found');
  const options = await periodSelect.locator('option').evaluateAll((nodes) => nodes.map((node) => ({ text: (node.textContent || '').trim(), value: node.value })));
  const customOption = options.find((row) => row.text === 'カスタム');
  if (!customOption) throw new Error('custom option was not found');
  await periodSelect.selectOption(customOption.value);
  await page.waitForTimeout(700);

  const start = page.getByLabel('開始日を選択してください');
  const end = page.getByLabel('終了日を選択してください');
  if (!await start.isVisible().catch(() => false) || !await end.isVisible().catch(() => false)) throw new Error('custom date inputs were not found');
  await start.fill('2026/09/01');
  await end.fill('2026/09/03');
  await page.waitForTimeout(300);

  const apply = page.locator('button').filter({ hasText: /^適用$/ }).first();
  if (!await apply.isVisible().catch(() => false)) throw new Error('custom period apply button was not found');
  if (await apply.isDisabled().catch(() => true)) throw new Error('custom period apply button is disabled');
  await apply.click({ force: true });
  await page.waitForTimeout(3_000);
  console.log('DASHBOARD_RANGE_CAPTURE_COUNT=' + captures.length);
} finally {
  await browser?.close().catch(() => {});
}
