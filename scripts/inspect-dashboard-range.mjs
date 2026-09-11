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

  const opener = page.getByRole('button', { name: /期間選択/ }).first();
  if (!await opener.isVisible().catch(() => false)) throw new Error('period selector was not found');
  await opener.click();
  await page.waitForTimeout(500);

  const custom = page.getByText('カスタム', { exact: true }).first();
  if (!await custom.isVisible().catch(() => false)) throw new Error('custom period option was not found');
  await custom.click();
  await page.waitForTimeout(700);

  const start = page.getByLabel('開始日を選択してください');
  const end = page.getByLabel('終了日を選択してください');
  if (!await start.isVisible().catch(() => false) || !await end.isVisible().catch(() => false)) throw new Error('custom date inputs were not found');
  await start.fill('2026/09/01');
  await end.fill('2026/09/03');
  await page.waitForTimeout(300);

  const visibleButtons = await page.locator('button').evaluateAll((nodes) => nodes.filter((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  }).map((node) => ({
    text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    aria: node.getAttribute('aria-label'),
    disabled: node.hasAttribute('disabled'),
  })).filter((row) => /適用|決定|完了|設定|反映|検索|表示|期間|日付|キャンセル/.test(`${row.text} ${row.aria ?? ''}`)));
  console.log('DASHBOARD_CUSTOM_BUTTONS=' + JSON.stringify(visibleButtons));

  const submitCandidates = [
    page.getByRole('button', { name: /適用|決定|完了|反映|表示/ }),
    page.locator('button').filter({ hasText: /適用|決定|完了|反映|表示/ }),
  ];
  let submitted = false;
  for (const locator of submitCandidates) {
    if (!await locator.count()) continue;
    const item = locator.first();
    if (await item.isVisible().catch(() => false) && !await item.isDisabled().catch(() => true)) {
      await item.click();
      submitted = true;
      break;
    }
  }
  if (!submitted) {
    await end.press('Enter').catch(() => {});
    submitted = true;
  }
  console.log('DASHBOARD_CUSTOM_SUBMITTED=' + submitted);
  await page.waitForTimeout(3_000);
  console.log('DASHBOARD_RANGE_CAPTURE_COUNT=' + captures.length);
} finally {
  await browser?.close().catch(() => {});
}
