import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const CREATOR = 'nero_notelover';
const TIME_ZONE = 'Asia/Tokyo';
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');
const METRICS_FILE = path.join(DATA_DIR, 'article_metrics.json');
const DASHBOARD_FILE = path.join(DATA_DIR, 'public_dashboard.json');
const DASHBOARD_URL = 'https://note.com/dashboard';
const PUBLIC_PROFILE_URL = `https://note.com/api/v2/creators/${CREATOR}`;
const PUBLIC_CONTENTS_URL = `https://note.com/api/v2/creators/${CREATOR}/contents`;
const LEGACY_STATS_URL = 'https://note.com/api/v1/stats/pv';
const USER_AGENT = 'NERO-OBSERVATORY/1.0 (+low-frequency personal analytics)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const num = (value) => {
  const n = typeof value === 'string' ? Number(value.replaceAll(',', '')) : Number(value);
  return Number.isFinite(n) ? n : null;
};

function nowIsoJst() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

function jstDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function period28Days() {
  const end = new Date();
  const start = new Date(end.getTime() - 27 * 86400_000);
  return { start: jstDateKey(start), end: jstDateKey(end) };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function cookieValue(raw = '') {
  let text = raw.trim().replace(/^cookie:\s*/i, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text.includes('_note_session_v5=')) return text;
  const pair = text.split(';').map((v) => v.trim()).find((v) => v.startsWith('_note_session_v5='));
  return pair ? pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g, '') : '';
}

function unwrap(payload) { return payload?.data ?? payload ?? {}; }

function hashtagNames(row) {
  const candidates = [row?.hashtags, row?.hashtag_notes, row?.hashtagNotes];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    const names = list.map((item) => {
      if (typeof item === 'string') return item;
      return item?.hashtag?.name ?? item?.name ?? item?.hashtagName ?? null;
    }).filter(Boolean).map((name) => name.startsWith('#') ? name : `#${name}`);
    if (names.length) return [...new Set(names)];
  }
  return [];
}

function normalizePublicArticle(row) {
  const key = row?.key ?? row?.noteKey ?? row?.note_key;
  const title = row?.name ?? row?.title;
  const publishedAt = row?.publishAt ?? row?.publish_at ?? row?.publishedAt;
  if (!key || !title || !publishedAt) return null;
  const price = num(row?.priceInfo?.lowestPrice ?? row?.pricing?.onetimePurchaseLowestPrice ?? row?.price ?? 0) ?? 0;
  const explicitlyFree = row?.priceInfo?.isFree ?? row?.pricing?.isFree;
  return {
    key: String(key),
    title: String(title),
    url: `https://note.com/${CREATOR}/n/${key}`,
    published_at: String(publishedAt),
    price_yen: price,
    is_paid: explicitlyFree === false || price > 0,
    hashtags: hashtagNames(row),
    _likes: num(row?.likeCount ?? row?.like_count),
    _comments: num(row?.commentCount ?? row?.comment_count),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

async function collectPublic() {
  const profilePayload = await fetchJson(PUBLIC_PROFILE_URL);
  const profile = unwrap(profilePayload);
  const articles = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await fetchJson(`${PUBLIC_CONTENTS_URL}?kind=note&page=${page}`);
    const data = unwrap(payload);
    const rows = Array.isArray(data?.contents) ? data.contents : [];
    articles.push(...rows.map(normalizePublicArticle).filter(Boolean));
    if (data?.isLastPage === true || data?.is_last_page === true || rows.length === 0) break;
    await sleep(220);
  }
  const unique = [...new Map(articles.map((article) => [article.key, article])).values()]
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

  for (const article of unique) {
    if (article.hashtags.length) continue;
    try {
      const detailPayload = await fetchJson(`https://note.com/api/v3/notes/${article.key}`);
      const detail = unwrap(detailPayload)?.note ?? unwrap(detailPayload);
      article.hashtags = hashtagNames(detail);
      if (!finite(article._likes)) article._likes = num(detail?.likeCount ?? detail?.like_count);
      if (!finite(article._comments)) article._comments = num(detail?.commentCount ?? detail?.comment_count);
    } catch (error) {
      console.warn(`detail skipped ${article.key}: ${error.message}`);
    }
    await sleep(140);
  }

  const cleanArticles = unique.map(({ _likes, _comments, ...article }) => article);
  return {
    profile: {
      creator_id: CREATOR,
      nickname: profile?.nickname ?? profile?.name ?? CREATOR,
      followers: num(profile?.followerCount ?? profile?.follower_count),
      note_count: num(profile?.noteCount ?? profile?.note_count) ?? cleanArticles.length,
      total_public_likes: unique.reduce((sum, article) => sum + (article._likes ?? 0), 0),
      total_public_comments: unique.reduce((sum, article) => sum + (article._comments ?? 0), 0),
    },
    articles: cleanArticles,
    publicMetrics: new Map(unique.map((article) => [article.key, { likes: article._likes, comments: article._comments }])),
  };
}

function keyFromAnything(value) {
  if (typeof value !== 'string') return null;
  const direct = value.match(/^n[a-zA-Z0-9]{10,}$/)?.[0];
  if (direct) return direct;
  return value.match(/\/n\/(n[a-zA-Z0-9]{10,})/)?.[1] ?? value.match(/notes\/(n[a-zA-Z0-9]{10,})/)?.[1] ?? null;
}

function scanImmediate(object, regexes) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  for (const [key, value] of Object.entries(object)) {
    if (!regexes.some((regex) => regex.test(key))) continue;
    const n = num(value);
    if (n !== null) return n;
  }
  return null;
}

function findString(object, regexes, depth = 2) {
  if (!object || typeof object !== 'object' || depth < 0) return null;
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === 'string' && regexes.some((regex) => regex.test(key))) return value;
  }
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      const found = findString(value, regexes, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function findKey(object, depth = 3) {
  if (!object || typeof object !== 'object' || depth < 0) return null;
  for (const [field, value] of Object.entries(object)) {
    if (typeof value !== 'string') continue;
    if (/key|url|note/i.test(field)) {
      const key = keyFromAnything(value);
      if (key) return key;
    }
  }
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      const key = findKey(value, depth - 1);
      if (key) return key;
    }
  }
  return null;
}

function collectMetricCandidates(payload, output, updatedTimes, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 12) return;
  if (!Array.isArray(payload)) {
    const key = findKey(payload, 2);
    const impressions = scanImmediate(payload, [/impression/i]);
    const pageviews = scanImmediate(payload, [/page.?view/i, /^pv$/i, /read.?count/i]);
    const likes = scanImmediate(payload, [/^likes?$/i, /like.?count/i]);
    const comments = scanImmediate(payload, [/^comments?$/i, /comment.?count/i]);
    if (key && [impressions, pageviews, likes, comments].some((value) => value !== null)) {
      const current = output.get(key) ?? { key };
      for (const [name, value] of Object.entries({ impressions, pageviews, likes, comments })) if (value !== null) current[name] = value;
      current.title ||= findString(payload, [/^title$/i, /^name$/i], 2);
      current.published_at ||= findString(payload, [/publish/i], 2);
      output.set(key, current);
    }
    for (const [field, value] of Object.entries(payload)) {
      if (typeof value === 'string' && /(last.*updated|aggregate.*at|updated.*at|calculated.*at)/i.test(field)) {
        const t = Date.parse(value);
        if (Number.isFinite(t)) updatedTimes.push(new Date(t));
      }
    }
  }
  for (const value of Object.values(payload)) if (value && typeof value === 'object') collectMetricCandidates(value, output, updatedTimes, depth + 1);
}

async function collectLegacyViews(cookie) {
  const map = new Map();
  if (!cookie) return map;
  const headers = { cookie: `_note_session_v5=${cookie}` };
  for (let page = 1; page <= 100; page += 1) {
    const payload = await fetchJson(`${LEGACY_STATS_URL}?filter=all&page=${page}&sort=pv`, { headers });
    const data = unwrap(payload);
    const rows = Array.isArray(data?.note_stats) ? data.note_stats : [];
    for (const row of rows) {
      const key = row?.key ? String(row.key) : null;
      const views = num(row?.read_count ?? row?.pv ?? row?.pageviews);
      if (key && views !== null) map.set(key, views);
    }
    if (!rows.length || data?.is_last_page === true || (!data?.next_page && rows.length < 10)) break;
    await sleep(350);
  }
  return map;
}

async function collectDashboard(cookie) {
  const metricMap = new Map();
  const updatedTimes = [];
  if (!cookie) return { metricMap, updatedTimes, source: 'public_only' };

  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP', timezoneId: TIME_ZONE });
    await context.addCookies([{ name: '_note_session_v5', value: cookie, domain: '.note.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const captures = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (!/graphql\.note\.com\/graphql|note\.com\/api\//.test(url)) return;
      const contentType = response.headers()['content-type'] ?? '';
      if (!contentType.includes('json')) return;
      try {
        const json = await response.json();
        captures.push(json);
        collectMetricCandidates(json, metricMap, updatedTimes);
      } catch {}
    });
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(10_000);
    if (/login|signin/.test(page.url())) throw new Error('note session redirected to login');
    const body = await page.locator('body').innerText().catch(() => '');
    if (!/インプレッション|ページビュー|アクセス/.test(body)) console.warn('dashboard marker text was not found');
    await page.waitForTimeout(4_000);
    console.log(`dashboard network captures: ${captures.length}; metric candidates: ${metricMap.size}`);
    return { metricMap, updatedTimes, source: 'note_dashboard_browser' };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function bestDashboardAt(updatedTimes) {
  const now = Date.now();
  const valid = updatedTimes.map((d) => d.getTime()).filter((t) => t <= now + 60_000 && t >= now - 3 * 86400_000).sort((a, b) => b - a);
  return valid.length ? new Date(valid[0]).toISOString() : new Date().toISOString();
}

function jstHourMinute(iso) {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function withinOfficialWindow(iso) {
  const minutes = jstHourMinute(iso);
  return minutes >= 18 * 60 && minutes <= 20 * 60 + 30;
}

const previousArticles = await readJson(ARTICLES_FILE, { articles: [] });
const previousMetrics = await readJson(METRICS_FILE, { articles: [] });
const previousDashboard = await readJson(DASHBOARD_FILE, { snapshots: [], follower_snapshots: [] });
const previousMetricByKey = new Map((previousMetrics.articles ?? []).map((row) => [keyFromAnything(row.url), row]));
const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
const generatedAt = nowIsoJst();

const publicResult = await collectPublic();
if (!publicResult.articles.length) throw new Error('public article collection returned zero rows');

await writeJson(ARTICLES_FILE, {
  schema_version: 1,
  generated_at: generatedAt,
  creator_id: CREATOR,
  count: publicResult.articles.length,
  articles: publicResult.articles,
});

let dashboardResult = { metricMap: new Map(), updatedTimes: [], source: 'public_only' };
let legacyViews = new Map();
if (cookie) {
  try { dashboardResult = await collectDashboard(cookie); } catch (error) { console.warn(`dashboard browser capture failed: ${error.message}`); }
  try { legacyViews = await collectLegacyViews(cookie); } catch (error) { console.warn(`legacy stats fallback failed: ${error.message}`); }
} else {
  console.warn('NOTE_SESSION_COOKIE is not configured; public metadata only');
}

const metricRows = [];
let impressionRows = 0;
let pvRows = 0;
for (const article of publicResult.articles) {
  const captured = dashboardResult.metricMap.get(article.key) ?? {};
  const previous = previousMetricByKey.get(article.key) ?? {};
  const publicMetric = publicResult.publicMetrics.get(article.key) ?? {};
  const impressions = finite(captured.impressions) ? captured.impressions : (finite(previous.impressions) ? previous.impressions : null);
  const pageviews = finite(captured.pageviews) ? captured.pageviews : (legacyViews.has(article.key) ? legacyViews.get(article.key) : (finite(previous.pageviews) ? previous.pageviews : null));
  const likes = finite(captured.likes) ? captured.likes : (finite(publicMetric.likes) ? publicMetric.likes : (finite(previous.likes) ? previous.likes : null));
  const comments = finite(captured.comments) ? captured.comments : (finite(publicMetric.comments) ? publicMetric.comments : (finite(previous.comments) ? previous.comments : null));
  if (finite(captured.impressions)) impressionRows += 1;
  if (finite(captured.pageviews) || legacyViews.has(article.key)) pvRows += 1;
  metricRows.push({
    title: article.title,
    published_at: article.published_at,
    url: article.url,
    pageviews,
    impressions,
    likes,
    comments,
  });
}

const dashboardAt = bestDashboardAt(dashboardResult.updatedTimes);
const period = period28Days();
const totals = metricRows.reduce((sum, row) => {
  for (const key of ['impressions', 'pageviews', 'likes', 'comments']) if (finite(row[key])) sum[key] += row[key];
  return sum;
}, { impressions: 0, pageviews: 0, likes: 0, comments: 0 });

const hasFreshDashboard = cookie && impressionRows >= Math.min(5, publicResult.articles.length) && pvRows >= Math.min(5, publicResult.articles.length);
if (hasFreshDashboard) {
  await writeJson(METRICS_FILE, {
    schema_version: 1,
    generated_at: generatedAt,
    dashboard_at: dashboardAt,
    period: { unit: 'LAST_28_DAYS', start: period.start, end: period.end },
    count: metricRows.length,
    articles: metricRows,
  });
} else {
  console.warn(`dashboard metrics preserved: fresh IMP rows=${impressionRows}, fresh PV rows=${pvRows}`);
}

const followerSnapshots = [...(previousDashboard.follower_snapshots ?? [])];
const followerSnapshot = {
  observed_at: generatedAt,
  followers: publicResult.profile.followers,
  articles: publicResult.profile.note_count,
  source: 'note_public_creator_api',
};
const lastFollower = followerSnapshots.at(-1);
if (!lastFollower || lastFollower.followers !== followerSnapshot.followers || jstDateKey(new Date(lastFollower.observed_at)) !== jstDateKey(new Date())) followerSnapshots.push(followerSnapshot);

const snapshots = [...(previousDashboard.snapshots ?? [])];
let latest = previousDashboard.latest ?? null;
if (hasFreshDashboard) {
  const snapshot = {
    dashboard_at: dashboardAt,
    fetched_at: generatedAt,
    period_label: `${period.start.replaceAll('-', '/')}〜${period.end.replaceAll('-', '/')}`,
    impressions: totals.impressions,
    pageviews: totals.pageviews,
    likes: totals.likes,
    comments: totals.comments,
    followers: publicResult.profile.followers,
    articles: metricRows.length,
    source: dashboardResult.source,
    note_stat_last_updated_at: dashboardAt,
  };
  const sameCut = snapshots.findIndex((row) => row.dashboard_at === snapshot.dashboard_at);
  if (sameCut >= 0) snapshots[sameCut] = snapshot; else snapshots.push(snapshot);
  snapshots.sort((a, b) => Date.parse(a.dashboard_at) - Date.parse(b.dashboard_at));
  latest = {
    period_label: snapshot.period_label,
    dashboard_at: snapshot.dashboard_at,
    fetched_at: generatedAt,
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
}

await writeJson(DASHBOARD_FILE, {
  schema_version: 1,
  generated_at: generatedAt,
  snapshot_policy: previousDashboard.snapshot_policy ?? {
    timezone: TIME_ZONE,
    target_publish_time: '21:00',
    first_fetch_time: '19:35',
    retry_times: ['19:50', '20:05', '20:20'],
    rule: '19:35以降に再取得し、noteの記事別集計時刻が18:00〜20:30 JSTに入る最も新しい断面を当日公式値として採用する。',
  },
  latest,
  snapshots: snapshots.slice(-120),
  public_profile: { observed_at: generatedAt, ...publicResult.profile },
  follower_snapshots: followerSnapshots.slice(-180),
});

console.log(JSON.stringify({
  ok: true,
  generatedAt,
  publicArticles: publicResult.articles.length,
  freshDashboard: hasFreshDashboard,
  dashboardAt,
  officialWindow: withinOfficialWindow(dashboardAt),
  impressionRows,
  pvRows,
  followers: publicResult.profile.followers,
}));
