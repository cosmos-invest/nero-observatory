import fs from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright-core';

const TIME_ZONE = 'Asia/Tokyo';
const DASHBOARD_URL = 'https://note.com/dashboard';
const ARTICLES_FILE = 'data/articles.json';
const WINDOW_FILE = 'data/article_window_metrics.json';
const WINDOWS = [3, 7, 14, 28];
const USER_AGENT = 'NERO-OBSERVATORY/1.0 (+low-frequency personal analytics)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const num = (value) => {
  const n = typeof value === 'string' ? Number(value.replaceAll(',', '')) : Number(value);
  return Number.isFinite(n) ? n : null;
};
const clone = (value) => JSON.parse(JSON.stringify(value));

function cookieValue(raw = '') {
  let text = raw.trim().replace(/^cookie:\s*/i, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text.includes('_note_session_v5=')) return text;
  const pair = text.split(';').map((v) => v.trim()).find((v) => v.startsWith('_note_session_v5='));
  return pair ? pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g, '') : '';
}

function nowIsoJst() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`;
}

function jstDateKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
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

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function emptyStore() {
  return { schema_version: 1, generated_at: null, windows: WINDOWS, articles: [] };
}

function normalizeStore(store, articles) {
  const existing = new Map((store?.articles ?? []).map((row) => [row.key ?? keyFromAnything(row.url), row]));
  return {
    schema_version: 1,
    generated_at: store?.generated_at ?? null,
    windows: WINDOWS,
    articles: articles.map((article) => {
      const key = article.key ?? keyFromAnything(article.url);
      const old = existing.get(key) ?? {};
      return {
        key,
        title: article.title,
        published_at: article.published_at,
        url: article.url,
        metrics: old.metrics && typeof old.metrics === 'object' ? old.metrics : {},
      };
    }),
  };
}

function buildNeeded(store, today) {
  const groups = new Map();
  for (const article of store.articles) {
    const start = jstDateKey(article.published_at);
    for (const days of WINDOWS) {
      if (article.metrics?.[String(days)]) continue;
      const end = addDays(start, days - 1);
      // Freeze only after the whole final calendar day has elapsed.
      if (end >= today) continue;
      const groupKey = `${start}|${end}`;
      const group = groups.get(groupKey) ?? { start, end, targets: [] };
      group.targets.push({ key: article.key, days });
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

function customBody(template, start, end, first = 100) {
  const body = clone(template);
  body.variables ??= {};
  body.variables.unit = 'CUSTOM';
  body.variables.date = `${start}T00:00:00.000Z`;
  body.variables.endDate = `${end}T00:00:00.000Z`;
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

async function fetchRange(context, statUrl, statHeaders, statTemplate, start, end) {
  let first = 100;
  let body = customBody(statTemplate, start, end, first);
  let result = await postGraphql(context, statUrl, statHeaders, body);
  if (!result.ok) {
    first = Number(statTemplate?.variables?.first) || 20;
    body = customBody(statTemplate, start, end, first);
    result = await postGraphql(context, statUrl, statHeaders, body);
  }
  if (!result.ok) throw new Error(`custom dashboard request failed ${start}..${end}: HTTP ${result.status}`);

  const metricMap = new Map();
  collectMetrics(result.json, metricMap);
  let pageInfo = findPageInfo(result.json);
  let pages = 1;
  while (pageInfo?.hasNextPage === true && pages < 20) {
    const cursor = pageInfo.endCursor ?? pageInfo.cursor ?? null;
    if (!cursor) throw new Error(`custom dashboard pagination missing cursor ${start}..${end}`);
    const nextBody = customBody(statTemplate, start, end, first);
    setCursor(nextBody, cursor);
    const next = await postGraphql(context, statUrl, statHeaders, nextBody);
    if (!next.ok) throw new Error(`custom dashboard pagination failed ${start}..${end}: HTTP ${next.status}`);
    collectMetrics(next.json, metricMap);
    pageInfo = findPageInfo(next.json);
    pages += 1;
  }
  return { metricMap, pages };
}

const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
if (!cookie) throw new Error('NOTE_SESSION_COOKIE is required for window metric collection');
const articlesData = await readJson(ARTICLES_FILE, { articles: [] });
const articles = articlesData.articles ?? [];
if (!articles.length) throw new Error('articles.json is empty');
let store = normalizeStore(await readJson(WINDOW_FILE, emptyStore()), articles);
const today = jstDateKey();
const neededGroups = buildNeeded(store, today);
if (!neededGroups.length) {
  console.log(JSON.stringify({ ok: true, updated: 0, message: 'No matured article windows to collect.' }));
  process.exit(0);
}

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

  const articleByKey = new Map(store.articles.map((row) => [row.key, row]));
  let updated = 0;
  let ranges = 0;
  for (const group of neededGroups) {
    const { metricMap, pages } = await fetchRange(context, statUrl, statHeaders, statTemplate, group.start, group.end);
    ranges += 1;
    for (const target of group.targets) {
      const row = metricMap.get(target.key);
      if (!row || !finite(row.impressions) || !finite(row.pageviews)) {
        console.warn(`window metric missing: ${target.key} ${target.days}d ${group.start}..${group.end}`);
        continue;
      }
      const article = articleByKey.get(target.key);
      article.metrics[String(target.days)] = {
        days: target.days,
        start: group.start,
        end: group.end,
        impressions: row.impressions,
        pageviews: row.pageviews,
        likes: finite(row.likes) ? row.likes : null,
        comments: finite(row.comments) ? row.comments : null,
        captured_at: nowIsoJst(),
        source: 'note_dashboard_custom_range',
      };
      updated += 1;
    }
    console.log(`window range ${group.start}..${group.end}: targets=${group.targets.length}, rows=${metricMap.size}, pages=${pages}`);
    await sleep(300);
  }

  if (updated > 0) {
    store.generated_at = nowIsoJst();
    await writeJson(WINDOW_FILE, store);
  }
  console.log(JSON.stringify({ ok: true, updated, ranges, remainingGroups: buildNeeded(store, today).length }));
} finally {
  await browser?.close().catch(() => {});
}
