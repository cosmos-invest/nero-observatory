import { TIME_ZONE, dayKey, dashboardRows, followerRows, filterMentions, buildNoteBlock, canonicalNoteUrl } from './observatory-core.mjs';
import { joinArticleRows, filterArticleRows, summarizeArticleRows, articleRateSeries, aggregateHashtags } from './analysis-core.mjs';

const DASHBOARD_URL = './data/public_dashboard.json';
const MENTIONS_URL = './data/mentions.json';
const ARTICLE_METRICS_URL = './data/article_metrics.json';
const ARTICLES_URL = './data/articles.json';
const nf = new Intl.NumberFormat('ja-JP');
const df = new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const tf = new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });

function pref(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function savePref(key, value) { try { localStorage.setItem(key, value ? '1' : '0'); } catch {} }
function valuePref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function saveValuePref(key, value) { try { localStorage.setItem(key, value); } catch {} }

const state = {
  dashboard: null,
  mentions: null,
  articleMetrics: null,
  articles: null,
  articleRows: [],
  mentionRange: 'all',
  unusedOnly: false,
  hashtagSort: 'avgPageviews',
  articleType: valuePref('nero-article-type', 'all'),
  excludeOutliers: pref('nero-exclude-outliers'),
  captureMode: false,
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const fmt = (value) => finite(value) ? nf.format(value) : '—';
const fmt1 = (value) => finite(value) ? value.toLocaleString('ja-JP', { maximumFractionDigits: 1 }) : '—';
const pct = (num, den) => finite(num) && finite(den) && den > 0 ? `${(num / den * 100).toFixed(2)}%` : '—';

function setText(id, value) { const node = document.getElementById(id); if (node) node.textContent = value; }
function dateParts(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return { date: '—', time: '—' };
  return { date: df.format(date).replaceAll('/', '.'), time: tf.format(date) };
}
function signed(value) { if (!finite(value)) return '—'; return `${value > 0 ? '+' : ''}${nf.format(value)}`; }
function articleTypeLabel() {
  if (state.articleType === 'paid') return '有料記事';
  if (state.articleType === 'free') return '無料記事';
  return '全記事';
}
function currentArticleRows() { return filterArticleRows(state.articleRows, state.excludeOutliers, state.articleType); }

function rawDashboardRows(dashboard) {
  return (dashboard?.snapshots ?? [])
    .filter((row) => row?.source !== 'note_public_creator_api' && row?.dashboard_at)
    .slice()
    .sort((a, b) => Date.parse(a.dashboard_at) - Date.parse(b.dashboard_at));
}

function previousForCurrent(dashboard, currentAt) {
  if (!currentAt) return { row: null, label: '前回比' };
  const daily = dashboardRows(dashboard);
  const currentDay = dayKey(currentAt);
  const previousDay = daily.filter((row) => dayKey(row.dashboard_at) < currentDay).at(-1);
  if (previousDay) return { row: previousDay, label: '前日比' };
  const previousCut = rawDashboardRows(dashboard)
    .filter((row) => Date.parse(row.dashboard_at) < Date.parse(currentAt))
    .at(-1);
  return { row: previousCut ?? null, label: previousCut ? '前回断面比' : '比較待ち' };
}

function latestFollower(dashboard) {
  const rows = followerRows(dashboard);
  return { latest: rows.at(-1) ?? null, previous: rows.at(-2) ?? null };
}

function mentionsToday(records, at) {
  const day = dayKey(at ?? new Date());
  return (records ?? []).filter((row) => dayKey(row.introduced_at) === day).length;
}

function renderBoard() {
  const rows = currentArticleRows();
  const summary = summarizeArticleRows(rows);
  const currentAt = state.articleMetrics?.dashboard_at ?? state.dashboard?.latest?.dashboard_at;
  const period = state.dashboard?.latest?.period_label ?? '—';
  const { row: previous, label: previousLabel } = previousForCurrent(state.dashboard, currentAt);
  const { latest: followerRow, previous: previousFollower } = latestFollower(state.dashboard);
  const profile = state.dashboard?.public_profile ?? {};
  const followerValue = followerRow?.followers ?? profile.followers ?? state.dashboard?.latest?.metrics?.followers;
  const mentionCount = state.mentions?.total_count ?? state.mentions?.records?.length ?? 0;
  const mentionNew = mentionsToday(state.mentions?.records, currentAt);
  const stamp = dateParts(currentAt);
  const typeLabel = articleTypeLabel();

  setText('snapshot-date', stamp.date);
  setText('snapshot-time', stamp.time);
  setText('metric-period', period);
  setText('filter-label', `${typeLabel}${state.excludeOutliers ? ' · 爆発2記事除外' : ''} · ${summary.articleCount}記事`);
  setText('metric-impressions', fmt(summary.impressions));
  setText('metric-pageviews', fmt(summary.pageviews));
  setText('metric-followers', fmt(followerValue));
  setText('metric-likes', fmt(summary.likes));
  setText('metric-comments', fmt(summary.comments));
  setText('metric-mentions', fmt(mentionCount));
  setText('metric-articles', fmt(summary.articleCount));

  setText('kpi-open-rate', pct(summary.pageviews, summary.impressions));
  setText('kpi-like-rate', pct(summary.likes, summary.pageviews));
  setText('kpi-comment-rate', pct(summary.comments, summary.pageviews));
  setText('kpi-pv-per-article', summary.articleCount ? nf.format(Math.round(summary.pageviews / summary.articleCount)) : '—');

  const comparable = state.articleType === 'all' && !state.excludeOutliers;
  for (const key of ['impressions', 'pageviews', 'likes', 'comments']) {
    setText(`delta-${key}`, comparable && finite(previous?.[key]) ? signed(summary[key] - previous[key]) : '—');
  }
  setText('delta-followers', finite(followerValue) && finite(previousFollower?.followers) ? signed(followerValue - previousFollower.followers) : '—');
  setText('delta-mentions', mentionNew ? `今日 +${nf.format(mentionNew)}` : '今日 ±0');
  setText('comparison-label', comparable ? previousLabel : `${typeLabel}${state.excludeOutliers ? ' · 爆発2記事除外' : ''}`);

  const followerStamp = dateParts(followerRow?.observed_at ?? profile.observed_at ?? currentAt);
  setText('followers-observed', `フォロワー観測 ${followerStamp.time}`);
  setText('mention-count', fmt(mentionCount));
  renderArticleRateChart(rows);
}

function svgText(svg, x, y, text, anchor = 'start', className = '') {
  const node = document.createElementNS(svg.namespaceURI, 'text');
  node.setAttribute('x', String(x));
  node.setAttribute('y', String(y));
  node.setAttribute('text-anchor', anchor);
  if (className) node.setAttribute('class', className);
  node.textContent = text;
  svg.appendChild(node);
  return node;
}

function svgVerticalLabel(svg, x, y, label, index) {
  svgText(svg, x, y - 9, String(index + 1), 'middle', 'axis-article-number');
  const text = document.createElementNS(svg.namespaceURI, 'text');
  text.setAttribute('x', String(x));
  text.setAttribute('y', String(y));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('class', 'axis-article-vertical');
  [...label].slice(0, 6).forEach((char, charIndex) => {
    const tspan = document.createElementNS(svg.namespaceURI, 'tspan');
    tspan.setAttribute('x', String(x));
    tspan.setAttribute('dy', charIndex === 0 ? '0' : '11');
    tspan.textContent = char;
    text.appendChild(tspan);
  });
  svg.appendChild(text);
}

function renderArticleRateChart(rows) {
  const container = document.getElementById('article-rate-chart');
  if (!container) return;
  container.replaceChildren();
  const series = articleRateSeries(rows).slice(-10);
  if (series.length < 2) {
    const empty = document.createElement('span');
    empty.className = 'chart-empty';
    empty.textContent = 'データ待ち';
    container.appendChild(empty);
    return;
  }

  const width = 700;
  const height = 360;
  const pad = { top: 24, right: 58, bottom: 118, left: 58 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const plotBottom = pad.top + innerH;
  const likeMaxRaw = Math.max(...series.map((row) => finite(row.likeRate) ? row.likeRate : 0));
  const commentMaxRaw = Math.max(...series.map((row) => finite(row.commentRate) ? row.commentRate : 0));
  const likeMax = Math.max(1, likeMaxRaw * 1.12);
  const commentMax = Math.max(0.5, commentMaxRaw * 1.15);
  const x = (index) => pad.left + (series.length === 1 ? innerW / 2 : index / (series.length - 1) * innerW);
  const yLike = (value) => pad.top + (1 - value / likeMax) * innerH;
  const yComment = (value) => pad.top + (1 - value / commentMax) * innerH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');

  [0, 0.5, 1].forEach((ratio) => {
    const gy = pad.top + ratio * innerH;
    const grid = document.createElementNS(svg.namespaceURI, 'line');
    grid.setAttribute('x1', String(pad.left)); grid.setAttribute('x2', String(width - pad.right));
    grid.setAttribute('y1', String(gy)); grid.setAttribute('y2', String(gy));
    grid.setAttribute('class', 'chart-grid-line');
    svg.appendChild(grid);
    svgText(svg, pad.left - 8, gy + 4, `${(likeMax * (1 - ratio)).toFixed(1)}%`, 'end', 'axis-like');
    svgText(svg, width - pad.right + 8, gy + 4, `${(commentMax * (1 - ratio)).toFixed(1)}%`, 'start', 'axis-comment');
  });

  const linePath = (key, yFn) => series
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => finite(row[key]))
    .map(({ row, index }, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${x(index)} ${yFn(row[key])}`)
    .join(' ');

  const likePath = document.createElementNS(svg.namespaceURI, 'path');
  likePath.setAttribute('d', linePath('likeRate', yLike));
  likePath.setAttribute('class', 'series-like');
  svg.appendChild(likePath);

  const commentPath = document.createElementNS(svg.namespaceURI, 'path');
  commentPath.setAttribute('d', linePath('commentRate', yComment));
  commentPath.setAttribute('class', 'series-comment');
  svg.appendChild(commentPath);

  series.forEach((row, index) => {
    if (finite(row.likeRate)) {
      const circle = document.createElementNS(svg.namespaceURI, 'circle');
      circle.setAttribute('cx', String(x(index))); circle.setAttribute('cy', String(yLike(row.likeRate))); circle.setAttribute('r', '3.2'); circle.setAttribute('class', 'point-like');
      const title = document.createElementNS(svg.namespaceURI, 'title');
      title.textContent = `${row.title}｜スキ率 ${row.likeRate.toFixed(2)}%`;
      circle.appendChild(title); svg.appendChild(circle);
    }
    if (finite(row.commentRate)) {
      const circle = document.createElementNS(svg.namespaceURI, 'circle');
      circle.setAttribute('cx', String(x(index))); circle.setAttribute('cy', String(yComment(row.commentRate))); circle.setAttribute('r', '2.7'); circle.setAttribute('class', 'point-comment');
      const title = document.createElementNS(svg.namespaceURI, 'title');
      title.textContent = `${row.title}｜コメント率 ${row.commentRate.toFixed(2)}%`;
      circle.appendChild(title); svg.appendChild(circle);
    }
    const tick = document.createElementNS(svg.namespaceURI, 'line');
    tick.setAttribute('x1', String(x(index))); tick.setAttribute('x2', String(x(index)));
    tick.setAttribute('y1', String(plotBottom + 4)); tick.setAttribute('y2', String(plotBottom + 10));
    tick.setAttribute('class', 'axis-article-tick');
    svg.appendChild(tick);
    svgVerticalLabel(svg, x(index), plotBottom + 29, row.shortLabel, index);
  });

  container.appendChild(svg);
}

function renderHashtags() {
  const container = document.getElementById('hashtag-table');
  if (!container) return;
  container.replaceChildren();
  const rows = aggregateHashtags(currentArticleRows())
    .sort((a, b) => (b[state.hashtagSort] ?? 0) - (a[state.hashtagSort] ?? 0) || b.articleCount - a.articleCount || a.tag.localeCompare(b.tag, 'ja'));

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>タグ</th><th>n</th><th>PV/記事</th><th>スキ/記事</th><th>スキ率</th><th>コメント率</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.articleCount === 1) tr.className = 'single-tag';
    const values = [row.tag, row.articleCount, Math.round(row.avgPageviews), row.avgLikes, row.likeRate, row.commentRate];
    values.forEach((value, index) => {
      const td = document.createElement(index === 0 ? 'th' : 'td');
      if (index === 0) td.textContent = value;
      else if (index === 1 || index === 2) td.textContent = nf.format(value);
      else if (index === 3) td.textContent = fmt1(value);
      else td.textContent = `${value.toFixed(2)}%`;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function applyOutlierState() {
  const button = document.getElementById('toggle-outliers');
  button?.setAttribute('aria-pressed', String(state.excludeOutliers));
  if (button) button.textContent = state.excludeOutliers ? '爆発2記事 除外' : '爆発2記事 含む';
}

function applyArticleType() {
  const select = document.getElementById('article-type');
  if (select) select.value = state.articleType;
}

function applyCapture() {
  document.body.classList.toggle('capture-mode', state.captureMode);
  const button = document.getElementById('toggle-capture');
  button?.setAttribute('aria-pressed', String(state.captureMode));
  if (button) button.textContent = state.captureMode ? '戻る' : 'スクショ';
  document.getElementById('capture-exit')?.setAttribute('aria-hidden', String(!state.captureMode));
}
function toggleCapture() { state.captureMode = !state.captureMode; applyCapture(); }

function renderMentions() {
  const rows = filterMentions(state.mentions?.records ?? [], state.mentionRange, state.unusedOnly);
  const list = document.getElementById('mention-list');
  if (!list) return;
  list.replaceChildren();
  for (const row of rows) {
    const url = canonicalNoteUrl(row.article_url);
    const item = document.createElement(url ? 'a' : 'div');
    item.className = 'mention-item';
    if (url) { item.href = url; item.target = '_blank'; item.rel = 'noopener noreferrer'; }
    const when = dateParts(row.introduced_at).date;
    item.innerHTML = `<time>${when}</time><div><strong></strong><span></span></div>`;
    item.querySelector('strong').textContent = row.actor || '—';
    item.querySelector('span').textContent = row.article_title || '—';
    list.appendChild(item);
  }
  const block = buildNoteBlock(rows);
  setText('note-copy-preview', block.text);
}

async function copyNoteBlock() {
  const rows = filterMentions(state.mentions?.records ?? [], state.mentionRange, state.unusedOnly);
  const { text, urlCount } = buildNoteBlock(rows);
  try {
    await navigator.clipboard.writeText(text);
    setText('copy-status', `${urlCount}件コピーしました`);
  } catch {
    const area = document.createElement('textarea');
    area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    const ok = document.execCommand('copy'); area.remove();
    setText('copy-status', ok ? `${urlCount}件コピーしました` : 'コピーできませんでした');
  }
}

function rerenderAnalysis() { renderBoard(); renderHashtags(); }

function bind() {
  document.getElementById('article-type')?.addEventListener('change', (event) => {
    state.articleType = ['all', 'free', 'paid'].includes(event.target.value) ? event.target.value : 'all';
    saveValuePref('nero-article-type', state.articleType);
    rerenderAnalysis();
  });
  document.getElementById('toggle-outliers')?.addEventListener('click', () => {
    state.excludeOutliers = !state.excludeOutliers;
    savePref('nero-exclude-outliers', state.excludeOutliers);
    applyOutlierState();
    rerenderAnalysis();
  });
  document.getElementById('toggle-capture')?.addEventListener('click', toggleCapture);
  document.getElementById('capture-exit')?.addEventListener('click', toggleCapture);
  document.getElementById('hashtag-sort')?.addEventListener('change', (event) => { state.hashtagSort = event.target.value; renderHashtags(); });
  document.getElementById('mention-range')?.addEventListener('change', (event) => { state.mentionRange = event.target.value; renderMentions(); });
  document.getElementById('mention-unused')?.addEventListener('change', (event) => { state.unusedOnly = event.target.checked; renderMentions(); });
  document.getElementById('copy-note-block')?.addEventListener('click', copyNoteBlock);
}

async function load() {
  const [dashboardResponse, mentionsResponse, articleMetricsResponse, articlesResponse] = await Promise.all([
    fetch(DASHBOARD_URL), fetch(MENTIONS_URL), fetch(ARTICLE_METRICS_URL), fetch(ARTICLES_URL),
  ]);
  if (!dashboardResponse.ok || !mentionsResponse.ok || !articleMetricsResponse.ok || !articlesResponse.ok) throw new Error('data load failed');
  state.dashboard = await dashboardResponse.json();
  state.mentions = await mentionsResponse.json();
  state.articleMetrics = await articleMetricsResponse.json();
  state.articles = await articlesResponse.json();
  state.articleRows = joinArticleRows(state.articleMetrics, state.articles);
  rerenderAnalysis();
  renderMentions();
}

bind();
applyArticleType();
applyOutlierState();
applyCapture();
load().catch(() => setText('comparison-label', 'データ取得エラー'));
