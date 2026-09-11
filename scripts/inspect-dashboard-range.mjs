import process from 'node:process';
import { chromium } from 'playwright-core';

const TIME_ZONE = 'Asia/Tokyo';
const DASHBOARD_URL = 'https://note.com/dashboard';
const USER_AGENT = 'NERO-OBSERVATORY/1.0 (+low-frequency personal analytics)';
const PROBE_UNITS = ['LAST_3_DAYS', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_28_DAYS'];

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
  if (typeof value === 'string' && value.length > 120) return `[string:${value.length}]`;
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function replayHeaders(headers) {
  const blocked = new Set(['content-length', 'cookie', 'host', 'connection', 'accept-encoding']);
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !blocked.has(key.toLowerCase()) && !key.toLowerCase().startsWith('sec-')));
}
function errorSummary(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.errors) || !payload.errors.length) return null;
  return payload.errors.map((error) => ({ message: String(error?.message ?? '').slice(0, 180), code: error?.extensions?.code ?? null }));
}

const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
if (!cookie) throw new Error('NOTE_SESSION_COOKIE is required');

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP', timezoneId: TIME_ZONE });
  await context.addCookies([{ name: '_note_session_v5', value: cookie, domain: '.note.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  let template = null;
  let requestHeaders = null;
  let requestUrl = null;

  page.on('response', async (response) => {
    if (template) return;
    const request = response.request();
    let body;
    try { body = request.postDataJSON(); } catch { return; }
    if (body?.operationName !== 'Dashboard_StatPageQuery') return;
    template = clone(body);
    requestHeaders = request.headers();
    requestUrl = response.url();
    console.log('DASHBOARD_RANGE_TEMPLATE=' + JSON.stringify({ operationName: body.operationName, variables: sanitize(body.variables ?? {}) }));
  });

  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 40 && !template; i += 1) await page.waitForTimeout(250);
  if (!template || !requestUrl) throw new Error('Dashboard_StatPageQuery was not captured');

  for (const unit of PROBE_UNITS) {
    const body = clone(template);
    body.variables = { ...(body.variables ?? {}), unit };
    const response = await context.request.post(requestUrl, {
      headers: replayHeaders(requestHeaders),
      data: body,
      timeout: 30_000,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    console.log('DASHBOARD_UNIT_PROBE=' + JSON.stringify({ unit, httpStatus: response.status(), ok: response.ok(), errors: errorSummary(payload) }));
  }
} finally {
  await browser?.close().catch(() => {});
}
