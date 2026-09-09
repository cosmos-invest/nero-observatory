import fs from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright-core';

const TIME_ZONE = 'Asia/Tokyo';
const DASHBOARD_URL = 'https://note.com/dashboard';
const ARTICLES_FILE = 'data/articles.json';
const METRICS_FILE = 'data/article_metrics.json';
const DASHBOARD_FILE = 'data/public_dashboard.json';
const USER_AGENT = 'NERO-OBSERVATORY/1.0 (+low-frequency personal analytics)';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const num = (value) => {
  const n = typeof value === 'string' ? Number(value.replaceAll(',', '')) : Number(value);
  return Number.isFinite(n) ? n : null;
};

function cookieValue(raw = '') {
  let text = raw.trim().replace(/^cookie:\s*/i, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text.includes('_note_session_v5=')) return text;
  const pair = text.split(';').map((v) => v.trim()).find((v) => v.startsWith('_note_session_v5='));
  return pair ? pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g, '') : '';
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
      const key = findKey(value, depth - 1);
      if (key) return key;
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

function collectLastUpdated(payload, output, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 12) return;
  if (!Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== 'string' || !/noteStatLastUpdatedAt|last.*updated|aggregate.*at|calculated.*at/i.test(key)) continue;
      const time = Date.parse(value);
      if (Number.isFinite(time)) output.push(new Date(time));
    }
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') collectLastUpdated(value, output, depth + 1);
  }
}

function findPageInfo(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 12) return null;
  if (!Array.isArray(payload) && payload.pageInfo && typeof payload.pageInfo === 'object') {
    const pageInfo = payload.pageInfo;
    if ('hasNextPage' in pageInfo) return pageInfo;
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') {
      const found = findPageInfo(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setCursor(body, cursor) {
  body.variables ??= {};
  const query = typeof body.query === 'string' ? body.query : '';
  const queryMatch = query.match(/after\s*:\s*\$(\w+)/i);
  if (queryMatch) {
    body.variables[queryMatch[1]] = cursor;
    return queryMatch[1];
  }

  const keys = Object.keys(body.variables);
  const direct = keys.find((key) => /^(after|cursor)$/i.test(key)) ?? keys.find((key) => /after|cursor/i.test(key));
  if (direct) {
    body.variables[direct] = cursor;
    return direct;
  }

  const visit = (object) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
    for (const key of Object.keys(object)) {
      if (/^(after|cursor)$/i.test(key)) {
        object[key] = cursor;
        return true;
      }
    }
    for (const value of Object.values(object)) {
      if (visit(value)) return true;
    }
    return false;
  };
  if (visit(body.variables)) return 'nested';

  body.variables.after = cursor;
  return 'after';
}

function replayHeaders(headers) {
  const blocked = new Set(['content-length', 'cookie', 'host', 'connection', 'accept-encoding']);
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !blocked.has(key.toLowerCase()) && !key.toLowerCase().startsWith('sec-')));
}

function nowIsoJst() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

function jstDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function jstMinutes(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? -1);
  return hour * 60 + minute;
}

function officialWindow(iso) {
  const minutes = jstMinutes(iso);
  return minutes >= 18 * 60 && minutes <= 20 * 60 + 30;
}

function bestDashboardAt(times) {
  const now = Date.now();
  const valid = times.map((date) => date.getTime())
    .filter((time) => time <= now + 60_000 && time >= now - 3 * 86400_000)
    .sort((a, b) => b - a);
  return valid.length ? new Date(valid[0]).toISOString() : null;
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
if (!cookie) throw new Error('NOTE_SESSION_COOKIE is required for complete dashboard collection');

const articlesData = JSON.parse(await fs.readFile(ARTICLES_FILE, 'utf8'));
const articles = articlesData.articles ?? [];
if (!articles.length) throw new Error('articles.json is empty');

const metricMap = new Map();
const updatedTimes = [];
let statTemplate = null;
let statHeaders = null;
let statUrl = null;
let pageInfo = null;
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

  page.on('response', async (response) => {
    const request = response.request();
    let body;
    try { body = request.postDataJSON(); } catch { body = null; }
    if (body?.operationName !== 'Dashboard_StatPageQuery') return;
    try {
      const json = await response.json();
      collectMetrics(json, metricMap);
      collectLastUpdated(json, updatedTimes);
      pageInfo = findPageInfo(json) ?? pageInfo;
      statTemplate ??= clone(body);
      statHeaders ??= request.headers();
      statUrl ??= response.url();
    } catch {}
  });

  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(10_000);
  if (/login|signin/.test(page.url())) throw new Error('note session redirected to login');

  for (let wait = 0; wait < 20 && !statTemplate; wait += 1) await page.waitForTimeout(250);
  if (!statTemplate || !statUrl) throw new Error('Dashboard_StatPageQuery was not captured');

  let pages = 1;
  while (pageInfo?.hasNextPage === true && pages < 20) {
    const cursor = pageInfo.endCursor ?? pageInfo.cursor ?? null;
    if (!cursor) throw new Error('dashboard hasNextPage=true but no endCursor was returned');

    const body = clone(statTemplate);
    const cursorVariable = setCursor(body, cursor);
    const response = await context.request.post(statUrl, {
      headers: replayHeaders(statHeaders),
      data: body,
      timeout: 30_000,
    });
    if (!response.ok()) throw new Error(`dashboard pagination request failed: ${response.status()}`);
    const json = await response.json();
    collectMetrics(json, metricMap);
    collectLastUpdated(json, updatedTimes);
    const nextPageInfo = findPageInfo(json);
    if (!nextPageInfo) throw new Error('dashboard pagination response did not include pageInfo');
    pageInfo = nextPageInfo;
    pages += 1;
    console.log(`dashboard pagination: page=${pages}, cursorVariable=${cursorVariable}, captured=${metricMap.size}`);
  }

  const missing = articles.filter((article) => {
    const row = metricMap.get(article.key);
    return !row || !finite(row.impressions) || !finite(row.pageviews);
  });
  if (missing.length) throw new Error(`dashboard incomplete: captured ${articles.length - missing.length}/${articles.length} public articles`);

  const dashboardAt = bestDashboardAt(updatedTimes);
  if (!dashboardAt) throw new Error('noteStatLastUpdatedAt was not found');
  const isOfficial = officialWindow(dashboardAt);
  const generatedAt = nowIsoJst();

  const metricRows = articles.map((article) => {
    const metrics = metricMap.get(article.key);
    return {
      title: article.title,
      published_at: article.published_at,
      url: article.url,
      pageviews: metrics.pageviews,
      impressions: metrics.impressions,
      likes: finite(metrics.likes) ? metrics.likes : null,
      comments: finite(metrics.comments) ? metrics.comments : null,
    };
  });

  if (isOfficial) {
    const end = jstDateKey();
    const start = jstDateKey(new Date(Date.now() - 27 * 86400_000));
    await writeJson(METRICS_FILE, {
      schema_version: 1,
      generated_at: generatedAt,
      dashboard_at: dashboardAt,
      period: { unit: 'LAST_28_DAYS', start, end },
      count: metricRows.length,
      articles: metricRows,
    });

    const publicDashboard = JSON.parse(await fs.readFile(DASHBOARD_FILE, 'utf8'));
    const totals = metricRows.reduce((sum, row) => {
      sum.impressions += row.impressions;
      sum.pageviews += row.pageviews;
      sum.likes += row.likes ?? 0;
      sum.comments += row.comments ?? 0;
      return sum;
    }, { impressions: 0, pageviews: 0, likes: 0, comments: 0 });
    const followers = publicDashboard.public_profile?.followers ?? publicDashboard.latest?.metrics?.followers ?? null;
    const snapshot = {
      dashboard_at: dashboardAt,
      fetched_at: generatedAt,
      period_label: `${start.replaceAll('-', '/')}〜${end.replaceAll('-', '/')}`,
      impressions: totals.impressions,
      pageviews: totals.pageviews,
      likes: totals.likes,
      comments: totals.comments,
      followers,
      articles: metricRows.length,
      source: 'note_dashboard_graphql_paginated',
      note_stat_last_updated_at: dashboardAt,
    };
    const snapshots = [...(publicDashboard.snapshots ?? [])];
    const existing = snapshots.findIndex((row) => row.dashboard_at === dashboardAt);
    if (existing >= 0) snapshots[existing] = snapshot; else snapshots.push(snapshot);
    snapshots.sort((a, b) => Date.parse(a.dashboard_at) - Date.parse(b.dashboard_at));
    publicDashboard.generated_at = generatedAt;
    publicDashboard.snapshots = snapshots.slice(-120);
    publicDashboard.latest = {
      period_label: snapshot.period_label,
      dashboard_at: snapshot.dashboard_at,
      fetched_at: snapshot.fetched_at,
      note_stat_last_updated_at: dashboardAt,
      metrics: {
        articles: snapshot.articles,
        impressions: snapshot.impressions,
        pageviews: snapshot.pageviews,
        likes: snapshot.likes,
        comments: snapshot.comments,
        followers: snapshot.followers,
      },
    };
    await writeJson(DASHBOARD_FILE, publicDashboard);
  }

  console.log(JSON.stringify({
    ok: true,
    capturedArticles: metricRows.length,
    expectedArticles: articles.length,
    dashboardAt,
    officialWindow: isOfficial,
    officialWritten: isOfficial,
  }));
} finally {
  await browser?.close().catch(() => {});
}
