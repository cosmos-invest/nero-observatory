export const TIME_ZONE = 'Asia/Tokyo';
export const DAY_MS = 86_400_000;
export const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export function dayKey(value) {
  const date = new Date(value);
  if (value == null || !Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function dailyRows(rows, timeField = 'dashboard_at', { evening = false } = {}) {
  const days = new Map();
  for (const row of rows ?? []) {
    const at = row?.[timeField];
    const day = dayKey(at);
    if (!day) continue;
    if (evening) {
      const fetched = row.fetched_at ?? at;
      const start = Date.parse(`${day}T18:00:00+09:00`);
      const end = Date.parse(`${day}T20:30:59+09:00`);
      if (Date.parse(at) < start || Date.parse(at) > end
          || dayKey(fetched) !== day || Date.parse(fetched) < Date.parse(at)) continue;
    }
    const previous = days.get(day);
    if (!previous || Date.parse(at) > Date.parse(previous[timeField])
        || (at === previous[timeField] && row.fetched_at && !previous.fetched_at)) days.set(day, row);
  }
  return [...days.values()].sort((a, b) => Date.parse(a[timeField]) - Date.parse(b[timeField]));
}

export function dashboardRows(dashboard) {
  const rows = (dashboard?.snapshots ?? []).filter((r) => r.source !== 'note_public_creator_api');
  if (dashboard?.latest?.dashboard_at) rows.push({ ...dashboard.latest, ...dashboard.latest.metrics });
  return dailyRows(rows, 'dashboard_at', { evening: true });
}

export function followerRows(dashboard) {
  const legacy = (dashboard?.snapshots ?? [])
    .filter((r) => r.source === 'note_public_creator_api')
    .map((r) => ({ ...r, observed_at: r.dashboard_at }));
  return dailyRows([...(dashboard?.follower_snapshots ?? []), ...legacy]
    .filter((r) => isNumber(r.followers)), 'observed_at')
    .map((r) => ({ ...r, dashboard_at: r.observed_at }));
}

export function metricDelta(rows, key) {
  const latest = rows.at(-1);
  if (!latest || !isNumber(latest[key])) return null;
  const previous = rows.slice(0, -1).findLast((r) => isNumber(r[key]));
  if (!previous) return null;
  const days = Math.round((Date.parse(`${dayKey(latest.dashboard_at)}T00:00:00Z`)
    - Date.parse(`${dayKey(previous.dashboard_at)}T00:00:00Z`)) / DAY_MS);
  return { value: latest[key] - previous[key], days };
}

export function canonicalNoteUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'note.com' || url.username || url.password || url.port) return null;
    if (!/^\/(?:[a-zA-Z0-9_]+\/n|notes)\/n[a-f0-9]+\/?$/.test(url.pathname)) return null;
    return `https://note.com${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

export function filterMentions(records, range = 'all', unused = false, now = new Date()) {
  const today = dayKey(now);
  const midnight = Date.parse(`${today}T00:00:00+09:00`);
  const yesterday = dayKey(new Date(midnight - DAY_MS));
  const firstDay = dayKey(new Date(midnight - 6 * DAY_MS));
  return (records ?? []).filter((row) => {
    if (unused && row.used_in_note_at) return false;
    const day = dayKey(row.introduced_at);
    if (range === 'today') return day === today;
    if (range === 'yesterday') return day === yesterday;
    if (range === 'month') return day?.slice(0, 7) === today.slice(0, 7) && day <= today;
    if (range === '7') return day >= firstDay && day <= today;
    return true;
  }).sort((a, b) => Date.parse(b.introduced_at) - Date.parse(a.introduced_at));
}

export function buildNoteBlock(records) {
  const unique = new Map();
  for (const record of records) {
    const url = canonicalNoteUrl(record.article_url);
    if (url) unique.set(url.split('/').at(-1), url);
  }
  const urls = [...unique.values()];
  const header = '## 王子を紹介してくださった記事たち🌙\n\nいつも本当にありがとうございます。\nご紹介いただいた記事を、ここに大切に残します。\n\n';
  return { text: header + urls.join('\n\n'), urlCount: urls.length };
}
