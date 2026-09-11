import { joinArticleRows, filterArticleRows } from './analysis-core.mjs';

const ARTICLE_METRICS_URL = './data/article_metrics.json';
const ARTICLES_URL = './data/articles.json';
const nf = new Intl.NumberFormat('ja-JP');
const dateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });

const metrics = {
  openRate: { label: '開封率', calc: (row) => rate(row.pageviews, row.impressions), format: percent },
  likeRate: { label: 'スキ率', calc: (row) => rate(row.likes, row.pageviews), format: percent },
  commentRate: { label: 'コメント率', calc: (row) => rate(row.comments, row.pageviews), format: percent },
  pageviews: { label: 'PV / 記事', calc: (row) => finite(row.pageviews) ? row.pageviews : null, format: integer },
};

let rows = [];
let sortMetric = localStorage.getItem('nero-article-ranking-sort') || 'openRate';

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function rate(num, den) { return finite(num) && finite(den) && den > 0 ? num / den * 100 : null; }
function percent(value) { return finite(value) ? `${value.toFixed(2)}%` : '—'; }
function integer(value) { return finite(value) ? nf.format(Math.round(value)) : '—'; }
function articleType() {
  const value = document.getElementById('article-type')?.value;
  return ['all', 'free', 'paid'].includes(value) ? value : 'all';
}
function excludeOutliers() {
  return document.getElementById('toggle-outliers')?.getAttribute('aria-pressed') === 'true';
}
function publishedLabel(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : '—';
}
function valueFor(row, key) { return metrics[key]?.calc(row) ?? null; }

function render() {
  const container = document.getElementById('article-ranking-table');
  const select = document.getElementById('article-ranking-sort');
  const caption = document.getElementById('article-ranking-caption');
  if (!container || !select) return;

  if (!metrics[sortMetric]) sortMetric = 'openRate';
  select.value = sortMetric;

  const visible = filterArticleRows(rows, excludeOutliers(), articleType())
    .map((row) => ({ ...row, sortValue: valueFor(row, sortMetric) }))
    .filter((row) => finite(row.sortValue))
    .sort((a, b) => b.sortValue - a.sortValue || (b.pageviews ?? 0) - (a.pageviews ?? 0));

  container.replaceChildren();
  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>記事</th>
        <th>開封率</th>
        <th>スキ率</th>
        <th>コメント率</th>
        <th>PV / 記事</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  visible.forEach((row, index) => {
    const tr = document.createElement('tr');
    if (index < 3) tr.classList.add('ranking-top');

    const rank = document.createElement('td');
    rank.className = 'ranking-rank';
    rank.textContent = String(index + 1);
    tr.appendChild(rank);

    const article = document.createElement('th');
    article.scope = 'row';
    const link = document.createElement('a');
    link.href = row.url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = row.title || '無題';
    article.appendChild(link);
    const meta = document.createElement('small');
    meta.textContent = `${publishedLabel(row.published_at)} · IMP ${integer(row.impressions)}${row.is_paid ? ' · 有料' : ''}`;
    article.appendChild(meta);
    tr.appendChild(article);

    const cells = [
      ['openRate', valueFor(row, 'openRate')],
      ['likeRate', valueFor(row, 'likeRate')],
      ['commentRate', valueFor(row, 'commentRate')],
      ['pageviews', valueFor(row, 'pageviews')],
    ];
    for (const [key, value] of cells) {
      const td = document.createElement('td');
      td.textContent = metrics[key].format(value);
      if (key === sortMetric) td.className = 'ranking-active-metric';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  if (caption) caption.textContent = `${metrics[sortMetric].label}の高い順 · ${visible.length}記事`;
}

async function load() {
  const [metricsResponse, articlesResponse] = await Promise.all([
    fetch(ARTICLE_METRICS_URL),
    fetch(ARTICLES_URL),
  ]);
  if (!metricsResponse.ok || !articlesResponse.ok) throw new Error('ranking data load failed');
  const articleMetrics = await metricsResponse.json();
  const articles = await articlesResponse.json();
  rows = joinArticleRows(articleMetrics, articles);
  render();
}

function bind() {
  document.getElementById('article-ranking-sort')?.addEventListener('change', (event) => {
    sortMetric = metrics[event.target.value] ? event.target.value : 'openRate';
    localStorage.setItem('nero-article-ranking-sort', sortMetric);
    render();
  });
  document.getElementById('article-type')?.addEventListener('change', () => queueMicrotask(render));
  document.getElementById('toggle-outliers')?.addEventListener('click', () => queueMicrotask(render));
}

bind();
load().catch(() => {
  const caption = document.getElementById('article-ranking-caption');
  if (caption) caption.textContent = 'ランキング取得エラー';
});
