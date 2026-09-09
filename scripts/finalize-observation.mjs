import fs from 'node:fs/promises';

const FILE = 'data/public_dashboard.json';
const TIME_ZONE = 'Asia/Tokyo';
const dashboard = JSON.parse(await fs.readFile(FILE, 'utf8'));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function minutesInTokyo(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return -1;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? -1);
  return hour * 60 + minute;
}

function qualifies(row) {
  if (!row?.dashboard_at) return false;
  const minutes = minutesInTokyo(row.dashboard_at);
  if (minutes < 18 * 60 || minutes > 20 * 60 + 30) return false;
  if (!['impressions', 'pageviews', 'likes', 'comments', 'articles'].every((key) => finite(row[key]))) return false;
  if (row.source === 'note_dashboard_browser' && row.fetched_at) {
    const age = Date.parse(row.fetched_at) - Date.parse(row.dashboard_at);
    if (Number.isFinite(age) && Math.abs(age) < 120000) return false;
  }
  return true;
}

const official = (dashboard.snapshots ?? [])
  .filter(qualifies)
  .slice()
  .sort((a, b) => Date.parse(a.dashboard_at) - Date.parse(b.dashboard_at))
  .at(-1);

if (official) {
  dashboard.latest = {
    period_label: official.period_label ?? dashboard.latest?.period_label ?? '—',
    dashboard_at: official.dashboard_at,
    fetched_at: official.fetched_at ?? dashboard.generated_at ?? null,
    note_stat_last_updated_at: official.note_stat_last_updated_at ?? official.dashboard_at,
    metrics: {
      articles: official.articles,
      impressions: official.impressions,
      pageviews: official.pageviews,
      likes: official.likes,
      comments: official.comments,
      followers: finite(official.followers) ? official.followers : dashboard.public_profile?.followers ?? null,
    },
  };
}

await fs.writeFile(FILE, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, officialDashboardAt: dashboard.latest?.dashboard_at ?? null }));
