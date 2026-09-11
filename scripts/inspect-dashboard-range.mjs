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
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sanitize(value, key = '') {
  if (/token|cookie|session|email|authorization|password|secret/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  if (typeof value === 'string' && value.length > 180) return `[string:${value.length}]`;
  return value;
}
function compact(text = '') { return text.replace(/\s+/g, ' ').trim().slice(0, 180); }

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

  const controls = await page.locator('button, [role="button"], select').evaluateAll((nodes) => nodes.map((node) => ({
    tag: node.tagName,
    text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    aria: node.getAttribute('aria-label'),
    title: node.getAttribute('title'),
  })).filter((row) => /7日|28日|期間|カスタム|日付/.test(`${row.text} ${row.aria ?? ''} ${row.title ?? ''}`)));
  console.log('DASHBOARD_RANGE_CONTROLS=' + JSON.stringify(controls));

  const openerCandidates = [
    page.getByRole('button', { name: /28日|期間|日付/ }),
    page.locator('button').filter({ hasText: /28日|期間|日付/ }),
    page.locator('[role="button"]').filter({ hasText: /28日|期間|日付/ }),
  ];
  let opened = false;
  for (const locator of openerCandidates) {
    if (await locator.count()) {
      const item = locator.first();
      if (await item.isVisible().catch(() => false)) {
        await item.click();
        await page.waitForTimeout(700);
        opened = true;
        break;
      }
    }
  }
  console.log('DASHBOARD_RANGE_OPENED=' + opened);

  const menuText = compact(await page.locator('body').innerText().catch(() => ''));
  console.log('DASHBOARD_RANGE_BODY_HINT=' + JSON.stringify(menuText.match(/.{0,45}(?:過去7日|過去28日|カスタム|期間指定|日付).{0,100}/g)?.slice(0, 6) ?? []));

  const customCandidates = [
    page.getByText('カスタム', { exact: true }),
    page.getByText(/期間指定|カスタム/),
    page.getByRole('option', { name: /カスタム|期間指定/ }),
    page.getByRole('menuitem', { name: /カスタム|期間指定/ }),
  ];
  let customClicked = false;
  for (const locator of customCandidates) {
    if (await locator.count()) {
      const item = locator.first();
      if (await item.isVisible().catch(() => false)) {
        await item.click();
        await page.waitForTimeout(900);
        customClicked = true;
        break;
      }
    }
  }
  console.log('DASHBOARD_CUSTOM_CLICKED=' + customClicked);

  const inputs = await page.locator('input').evaluateAll((nodes) => nodes.map((node) => ({
    type: node.getAttribute('type'),
    name: node.getAttribute('name'),
    placeholder: node.getAttribute('placeholder'),
    aria: node.getAttribute('aria-label'),
    value: node.getAttribute('value'),
  })).filter((row) => /date|日|月|年|期間|start|end|from|to/i.test(`${row.type} ${row.name ?? ''} ${row.placeholder ?? ''} ${row.aria ?? ''}`)));
  console.log('DASHBOARD_CUSTOM_INPUTS=' + JSON.stringify(inputs));

  console.log('DASHBOARD_RANGE_CAPTURE_COUNT=' + captures.length);
} finally {
  await browser?.close().catch(() => {});
}
