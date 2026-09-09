export const OUTLIER_NOTE_KEYS = new Set(['n46c95069af22', 'ne4843208abbe']);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const SHORT_TITLE_RULES = [
  [/はじめてのnote│スキくれたら遊びに行くよ/, '初投稿'],
  [/はじめてのnoteが嬉しい/, '嬉しい'],
  [/コメント制限/, 'コメント制限'],
  [/1日目を終えて/, '1日目'],
  [/朝が来た/, '朝'],
  [/お気に入り掲示板/, '掲示板'],
  [/コメント依存症/, '紹介'],
  [/また会いに行きたく/, '会いに行く'],
  [/管理アプリ/, '管理アプリ'],
  [/月から降りて|お月見/, 'お月見'],
  [/3人に記事|3人に紹介/, '3人紹介'],
  [/10個の仕掛け|１０個の仕掛け/, '10仕掛け'],
  [/本当の値段/, '本当の値段'],
  [/止まった過去記事|6時間で/, '再始動'],
  [/ホスト/, 'ホスト'],
  [/たくさんの愛/, '感謝'],
  [/売り方/, '売り方'],
  [/Astra|GPT-6/i, 'Astra'],
  [/市場の独占/, '市場独占'],
  [/ターゲット/, 'ターゲット'],
];

export function noteKey(value) {
  try {
    const url = new URL(value);
    return url.pathname.split('/').filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

export function shortArticleLabel(value) {
  const title = typeof value === 'string' ? value : value?.title ?? '';
  if (!title) return '—';
  for (const [pattern, label] of SHORT_TITLE_RULES) {
    if (pattern.test(title)) return label;
  }
  const quoted = title.match(/[「『“](.{2,8}?)[」』”]/)?.[1];
  if (quoted) return quoted.slice(0, 6);
  const cleaned = title
    .replace(/🌙/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/^\s*(王子[、がは]?|ネロ[、がは]?)/, '')
    .replace(/^[0-9０-９]+部突破[│｜|]?/, '')
    .split(/[｜│|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .sort((a, b) => a.length - b.length)[0] ?? title;
  return cleaned.replace(/[！？!?。、]/g, '').trim().slice(0, 6) || '記事';
}

export function joinArticleRows(articleMetrics, articles) {
  const metaByKey = new Map((articles?.articles ?? []).map((article) => [article.key ?? noteKey(article.url), article]));
  return (articleMetrics?.articles ?? []).map((metric) => {
    const key = noteKey(metric.url);
    const meta = metaByKey.get(key) ?? {};
    return {
      ...metric,
      key,
      title: metric.title ?? meta.title ?? '',
      url: metric.url ?? meta.url ?? null,
      published_at: metric.published_at ?? meta.published_at ?? null,
      hashtags: Array.isArray(meta.hashtags) ? [...new Set(meta.hashtags.filter(Boolean))] : [],
      is_paid: meta.is_paid === true || Number(meta.price_yen) > 0,
      outlier: OUTLIER_NOTE_KEYS.has(key),
    };
  });
}

export function filterArticleRows(rows, excludeOutliers, articleType = 'all') {
  return (rows ?? []).filter((row) => {
    if (excludeOutliers && row.outlier) return false;
    if (articleType === 'paid') return row.is_paid === true;
    if (articleType === 'free') return row.is_paid !== true;
    return true;
  });
}

export function summarizeArticleRows(rows) {
  const initial = { impressions: 0, pageviews: 0, likes: 0, comments: 0, articleCount: 0 };
  return (rows ?? []).reduce((sum, row) => ({
    impressions: sum.impressions + (finite(row.impressions) ? row.impressions : 0),
    pageviews: sum.pageviews + (finite(row.pageviews) ? row.pageviews : 0),
    likes: sum.likes + (finite(row.likes) ? row.likes : 0),
    comments: sum.comments + (finite(row.comments) ? row.comments : 0),
    articleCount: sum.articleCount + 1,
  }), initial);
}

export function articleRateSeries(rows) {
  return (rows ?? [])
    .filter((row) => finite(row.pageviews) && row.pageviews > 0 && row.published_at)
    .map((row) => ({
      key: row.key,
      title: row.title,
      shortLabel: shortArticleLabel(row),
      published_at: row.published_at,
      likeRate: finite(row.likes) ? row.likes / row.pageviews * 100 : null,
      commentRate: finite(row.comments) ? row.comments / row.pageviews * 100 : null,
      pageviews: row.pageviews,
      outlier: Boolean(row.outlier),
      is_paid: row.is_paid === true,
    }))
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
}

export function aggregateHashtags(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    for (const tag of new Set(row.hashtags ?? [])) {
      if (!tag) continue;
      const current = map.get(tag) ?? { tag, articleCount: 0, pageviews: 0, likes: 0, comments: 0 };
      current.articleCount += 1;
      current.pageviews += finite(row.pageviews) ? row.pageviews : 0;
      current.likes += finite(row.likes) ? row.likes : 0;
      current.comments += finite(row.comments) ? row.comments : 0;
      map.set(tag, current);
    }
  }
  return [...map.values()].map((row) => ({
    ...row,
    avgPageviews: row.articleCount ? row.pageviews / row.articleCount : 0,
    avgLikes: row.articleCount ? row.likes / row.articleCount : 0,
    likeRate: row.pageviews ? row.likes / row.pageviews * 100 : 0,
    commentRate: row.pageviews ? row.comments / row.pageviews * 100 : 0,
  }));
}
