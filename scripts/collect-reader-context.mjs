import fs from 'node:fs/promises';

const creator = 'nero_notelover';
const raw = (process.env.NOTE_SESSION_COOKIE || '').trim().replace(/^cookie:\s*/i, '').replace(/^["']|["']$/g, '');
const cookie = raw.includes('_note_session_v5=') ? raw.split(';').map(s => s.trim()).find(s => s.startsWith('_note_session_v5=')) : `_note_session_v5=${raw}`;
if (!raw) throw new Error('NOTE_SESSION_COOKIE is not configured');
const accounts = ['nisetarzan','fcs_homecenter','orivie','akari_seaart','cave_huntress','veronica_heels'];
const out = { generated_at: new Date().toISOString(), creator, source: 'note_api_via_github_actions', articles: [], comments: [], reading: [], errors: [] };
const delay = () => new Promise(r => setTimeout(r, 400));
async function api(path) {
  const url = new URL(path, 'https://note.com');
  if (url.origin !== 'https://note.com' || !url.pathname.startsWith('/api/')) throw new Error('Invalid API URL');
  const res = await fetch(url, { headers: { accept: 'application/json', cookie, 'user-agent': 'Nero-Reader/1.0' }, redirect: 'error', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  return res.json();
}
function text(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  if (!node || typeof node !== 'object') return '';
  if (typeof node.value === 'string') return node.value;
  return (node.children || []).map(text).join('') + (node.tag_name === 'p' ? '\n' : '');
}
function clean(c) {
  return { key: c.key, note_key: c.note_key, user_id: c.user?.urlname, user_name: c.user?.nickname,
    text: text(c.comment).trim(), created_at: c.created_at, is_creator_replied: c.is_creator_replied,
    reply_count: c.reply_count, latest_creator_reply: c.latest_creator_reply ? { key: c.latest_creator_reply.key, text: text(c.latest_creator_reply.comment).trim(), created_at: c.latest_creator_reply.created_at } : null };
}
async function freeDetails(row, user) {
  const p = await api(`/api/v3/notes/${row.key}`);
  const d = p.data?.note || p.data;
  if (!d || row.status !== 'published' || row.priceInfo?.isFree === false || Number(row.price || 0) > 0 || Number(d.price || 0) > 0 || d.priceInfo?.isFree === false) return null;
  return { key: row.key, user_id: user, user_name: row.user?.nickname, title: row.name,
    url: `https://note.com/${user}/n/${row.key}`, published_at: row.publishAt,
    body_html: typeof d.body === 'string' ? d.body : '', comment_count: row.commentCount };
}
const p = await api(`/api/v2/creators/${creator}/contents?kind=note&page=1`);
for (const row of (p.data?.contents || []).slice(0,6)) {
  try {
    const article = await freeDetails(row, creator);
    if (!article) continue;
    out.articles.push(article);
    let done = false;
    for (let page = 1; page <= 15; page++) {
      const comments = await api(`/api/v3/notes/${row.key}/note_comments?page=${page}`);
      if (!Array.isArray(comments.data)) throw new Error('Unexpected comments schema');
      out.comments.push(...comments.data.filter(c=>!c.is_blocked).map(clean));
      if (!comments.next_page) { done = true; break; }
      await delay();
    }
    if (!done) out.errors.push({ key: row.key, reason: 'Comment pagination limit reached' });
  } catch(e) { out.errors.push({ key: row.key, reason: e.message }); }
  await delay();
}
for (const user of accounts) {
  try {
    const p = await api(`/api/v2/creators/${user}/contents?kind=note&page=1`);
    const rows = [...(p.data?.contents || [])].filter(r=>r.status==='published').sort((a,b)=>Date.parse(b.publishAt)-Date.parse(a.publishAt)).slice(0,2);
    for (const row of rows) {
      const detail = await freeDetails(row, user);
      if (detail) out.reading.push(detail);
      await delay();
    }
  } catch(e) { out.errors.push({ user_id: user, reason: e.message }); }
}
await fs.mkdir('reader-output', { recursive: true });
await fs.writeFile('reader-output/context.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ articles: out.articles.length, comments: out.comments.length, reading: out.reading.length, errors: out.errors }));
// Only explicitly selected public fields are exported. Never export responses,
// request headers, cookies, membership content or Gmail message data.
if (!out.articles.length) throw new Error('No public article contexts collected');
