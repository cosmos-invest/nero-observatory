import fs from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright-core';

const TIME_ZONE = 'Asia/Tokyo';
const DASHBOARD_URL = 'https://note.com/dashboard';
const OUTPUT_FILE = 'data/daily_account_metrics.json';
const DEFAULT_START = process.env.DAILY_START_DATE || '2026-08-12';
const USER_AGENT = 'NERO-OBSERVATORY/1.0 (+low-frequency personal analytics)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value) => {
  const n = typeof value === 'string' ? Number(value.replaceAll(',', '')) : Number(value);
  return Number.isFinite(n) ? n : null;
};
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function cookieValue(raw = '') {
  let text = raw.trim().replace(/^cookie:\s*/i, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text.includes('_note_session_v5=')) return text;
  const pair = text.split(';').map((v) => v.trim()).find((v) => v.startsWith('_note_session_v5='));
  return pair ? pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g, '') : '';
}

function jstDateKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function nowIsoJst() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`;
}

function yesterdayJst() {
  return addDays(jstDateKey(), -1);
}

function keyFromAnything(value) {
  if (typeof value !== 'string') return null;
  if (/^n[a-zA-Z0-9]{10,}$/.test(value)) return value;
  return value.match(/\/n\/(n[a-zA-Z0-9]{10,})/)?.[1]
    ?? value.match(/notes\/(n[a-zA-Z0-9]{10,})/)?.[1]
    ?? null;
}

function findKey(object, depth = 5) {
  if (!object || typeof object !== 'object' || depth < 0) return null;
  for (const [field, value] of Object.entries(object)) {
    if (typeof value !== 'string' || !/key|url|note/i.test(field)) continue;
    const key = keyFromAnything(value);
    if (key) return key;
  }
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      const found = findKey(value, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function collectMetrics(payload, output, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 16) return;
  if (!Array.isArray(payload) && payload.note && payload.metrics) {
    const key = findKey(payload.note, 6);
    if (key) {
      const metrics = payload.metrics;
      output.set(key, {
        impressions: num(metrics.impressionCount ?? metrics.impressions),
        pageviews: num(metrics.pageViewCount ?? metrics.pageviewCount ?? metrics.pageviews),
        likes: num(metrics.likeCount ?? metrics.likes),
        comments: num(metrics.commentCount ?? metrics.comments),
        sales_yen: num(metrics.salesAmount ?? metrics.salesAmountYen ?? metrics.sales),
      });
    }
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') collectMetrics(value, output, depth + 1);
  }
}

function findPageInfo(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 12) return null;
  if (!Array.isArray(payload) && payload.pageInfo && typeof payload.pageInfo === 'object' && 'hasNextPage' in payload.pageInfo) return payload.pageInfo;
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') {
      const found = findPageInfo(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function setCursor(body, cursor) {
  body.variables ??= {};
  const query = typeof body.query === 'string' ? body.query : '';
  const queryMatch = query.match(/after\s*:\s*\$(\w+)/i);
  if (queryMatch) {
    body.variables[queryMatch[1]] = cursor;
    return;
  }
  const keys = Object.keys(body.variables);
  const direct = keys.find((key) => /^(after|cursor)$/i.test(key)) ?? keys.find((key) => /after|cursor/i.test(key));
  if (direct) body.variables[direct] = cursor;
  else body.variables.after = cursor;
}

function replayHeaders(headers) {
  const blocked = new Set(['content-length', 'cookie', 'host', 'connection', 'accept-encoding']);
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !blocked.has(key.toLowerCase()) && !key.toLowerCase().startsWith('sec-')));
}

function customBody(template, date, first = 100) {
  const body = clone(template);
  body.variables ??= {};
  body.variables.unit = 'CUSTOM';
  body.variables.date = `${date}T00:00:00.000Z`;
  body.variables.endDate = `${date}T00:00:00.000Z`;
  body.variables.order = body.variables.order ?? 'PUBLISHED_DATE_DESC';
  body.variables.first = first;
  for (const key of Object.keys(body.variables)) {
    if (/^(after|cursor)$/i.test(key)) delete body.variables[key];
  }
  return body;
}

async function postGraphql(context, url, headers, body) {
  const response = await context.request.post(url, { headers: replayHeaders(headers), data: body, timeout: 30_000 });
  if (!response.ok()) return { ok: false, status: response.status(), json: null };
  const json = await response.json();
  if (Array.isArray(json?.errors) && json.errors.length) return { ok: false, status: response.status(), json };
  return { ok: true, status: response.status(), json };
}

async function fetchDate(context, statUrl, statHeaders, statTemplate, date) {
  let first = 100;
  let body = customBody(statTemplate, date, first);
  let result = await postGraphql(context, statUrl, statHeaders, body);
  if (!result.ok) {
    first = Number(statTemplate?.variables?.first) || 20;
    body = customBody(statTemplate, date, first);
    result = await postGraphql(context, statUrl, statHeaders, body);
  }
  if (!result.ok) throw new Error(`daily dashboard request failed ${date}: HTTP ${result.status}`);

  const metricMap = new Map();
  collectMetrics(result.json, metricMap);
  let pageInfo = findPageInfo(result.json);
  let pages = 1;

  while (pageInfo?.hasNextPage === true && pages < 20) {
    const cursor = pageInfo.endCursor ?? pageInfo.cursor ?? null;
    if (!cursor) throw new Error(`daily pagination missing cursor ${date}`);
    const nextBody = customBody(statTemplate, date, first);
    setCursor(nextBody, cursor);
    const next = await postGraphql(context, statUrl, statHeaders, nextBody);
    if (!next.ok) throw new Error(`daily pagination failed ${date}: HTTP ${next.status}`);
    collectMetrics(next.json, metricMap);
    pageInfo = findPageInfo(next.json);
    pages += 1;
  }

  const totals = { impressions: 0, pageviews: 0, likes: 0, comments: 0, sales_yen: 0 };
  let rows = 0;
  for (const metric of metricMap.values()) {
    rows += 1;
    for (const key of Object.keys(totals)) {
      if (finite(metric[key])) totals[key] += metric[key];
    }
  }
  return { totals, rows, pages };
}

async function readStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf8'));
    return parsed && Array.isArray(parsed.days) ? parsed : { schema_version: 1, generated_at: null, days: [] };
  } catch {
    return { schema_version: 1, generated_at: null, days: [] };
  }
}

const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
if (!cookie) throw new Error('NOTE_SESSION_COOKIE is required');

const start = DEFAULT_START;
const end = process.env.DAILY_END_DATE || jstDateKey();
const refreshDays = Math.max(0, Number(process.env.DAILY_REFRESH_DAYS || 3));
const store = await readStore();
const existing = new Map(store.days.map((row) => [row.date, row]));

const requested = [];
for (let d = start; d <= end; d = addDays(d, 1)) requested.push(d);
const refreshFrom = addDays(end, -(refreshDays - 1));
const needed = requested.filter((d) => !existing.has(d) || existing.get(d)?.sales_yen == null || (refreshDays > 0 && d >= refreshFrom));

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP', timezoneId: TIME_ZONE });
  await context.addCookies([{ name: '_note_session_v5', value: cookie, domain: '.note.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();

  let statTemplate = null;
  let statHeaders = null;
  let statUrl = null;
  page.on('response', async (response) => {
    if (statTemplate) return;
    const request = response.request();
    let body;
    try { body = request.postDataJSON(); } catch { return; }
    if (body?.operationName !== 'Dashboard_StatPageQuery') return;
    statTemplate = clone(body);
    statHeaders = request.headers();
    statUrl = response.url();
  });

  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(10_000);
  if (/login|signin/.test(page.url())) throw new Error('note session redirected to login');
  for (let wait = 0; wait < 20 && !statTemplate; wait += 1) await page.waitForTimeout(250);
  if (!statTemplate || !statUrl) throw new Error('Dashboard_StatPageQuery was not captured');

  for (const date of needed) {
    const { totals, rows, pages } = await fetchDate(context, statUrl, statHeaders, statTemplate, date);
    existing.set(date, {
      date,
      impressions: totals.impressions,
      pageviews: totals.pageviews,
      likes: totals.likes,
      comments: totals.comments,
      sales_yen: totals.sales_yen,
      captured_at: nowIsoJst(),
      article_rows: rows,
      source: 'note_dashboard_custom_single_day',
    });
    console.log(`daily ${date}: IMP=${totals.impressions} PV=${totals.pageviews} likes=${totals.likes} comments=${totals.comments} sales=${totals.sales_yen} rows=${rows} pages=${pages}`);
    await sleep(250);
  }

  const days = [...existing.values()]
    .filter((row) => row.date >= start && row.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));

  await fs.writeFile(OUTPUT_FILE, JSON.stringify({
    schema_version: 1,
    generated_at: nowIsoJst(),
    timezone: TIME_ZONE,
    start_date: start,
    end_date: end,
    metric_scope: 'account_daily_total',
    days,
  }, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({ ok: true, start, end, updated: needed.length, total_days: days.length }));
} finally {
  await browser?.close().catch(() => {});
}
