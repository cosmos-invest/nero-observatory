import fs from 'node:fs/promises';
const creator='nero_notelover';
const raw=(process.env.NOTE_SESSION_COOKIE||'').trim().replace(/^cookie:\s*/i,'').replace(/^["']|["']$/g,'');
const cookie=raw.includes('_note_session_v5=')?raw.split(';').map(s=>s.trim()).find(s=>s.startsWith('_note_session_v5=')):`_note_session_v5=${raw}`;
if(!raw)throw Error('NOTE_SESSION_COOKIE is not configured');
const accounts=['nisetarzan','fcs_homecenter','orivie','akari_seaart','cave_huntress','veronica_heels'];
const out={generated_at:new Date().toISOString(),creator,source:'note_api_via_github_actions',authenticated_urlname:null,articles:[],comments:[],reading:[],engagement:{},errors:[],coverage:{}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path){
 const u=new URL(path,'https://note.com');if(u.origin!=='https://note.com'||!u.pathname.startsWith('/api/'))throw Error('Invalid API URL');
 for(let a=0;a<4;a++){
  const r=await fetch(u,{headers:{accept:'application/json',cookie,'user-agent':'Nero-Reader/2.0'},redirect:'error',signal:AbortSignal.timeout(25000)});
  if((r.status===429||r.status>=500)&&a<3){await delay(Math.min(30000,Math.max(1000,Number(r.headers.get('retry-after')||0)*1000,2000*2**a)));continue;}
  if(!r.ok)throw Error(`API HTTP ${r.status}`);return r.json();
 }
}
function text(n){if(typeof n==='string')return n;if(Array.isArray(n))return n.map(text).join('');if(!n||typeof n!=='object')return '';if(typeof n.value==='string')return n.value;return(n.children||[]).map(text).join('')+(n.tag_name==='p'?'\n':'');}
function clean(c,key,parent=null){return{key:c.key,note_key:key,parent_key:parent,user_id:c.user?.urlname,user_name:c.user?.nickname,text:text(c.comment).trim(),created_at:c.created_at,is_creator_replied:c.is_creator_replied,reply_count:c.reply_count,latest_creator_reply:c.latest_creator_reply?{key:c.latest_creator_reply.key,text:text(c.latest_creator_reply.comment).trim(),created_at:c.latest_creator_reply.created_at}:null};}
async function collection(key,parent){
 const rows=[],seen=new Set();let page=1;
 for(let i=0;i<1000;i++){
  if(seen.has(page))throw Error('Repeated comment page');seen.add(page);
  const q=new URLSearchParams({page:String(page),per_page:'100',order:parent?'oldest':'newest'});if(parent)q.set('parent_key',parent);
  const p=await api(`/api/v3/notes/${key}/note_comments?${q}`);if(!Array.isArray(p.data))throw Error('Unexpected comments schema');rows.push(...p.data.filter(c=>!c.is_blocked));
  if(!p.next_page)return rows;page=Number(p.next_page);if(!Number.isInteger(page)||page<1)throw Error('Invalid comment page');await delay(150);
 }
 throw Error('Comment pagination safety limit reached');
}
async function allComments(key){const roots=await collection(key),rows=[];for(const c of roots){rows.push(clean(c,key));if(Number(c.reply_count)>0){const rs=Array.isArray(c.replies)&&c.replies.length>=Number(c.reply_count)?c.replies:await collection(key,c.key);rows.push(...rs.map(r=>clean(r,key,c.key)));}}return rows;}
async function allArticles(user){const rows=new Map();for(let page=1;page<=1000;page++){const p=await api(`/api/v2/creators/${user}/contents?kind=note&page=${page}`);if(!Array.isArray(p.data?.contents))throw Error('Unexpected article list schema');const items=p.data.contents;for(const r of items)if(r.status==='published')rows.set(r.key,r);if(p.data.isLastPage===true||!items.length)return [...rows.values()];await delay(150);}throw Error('Article pagination safety limit reached');}
const auth=await api('/api/v1/current_user');const user=auth.data?.user??auth.data??auth.user??auth;
if(user?.urlname!==creator)throw Error('Nero session verification failed; engagement states were not collected');out.authenticated_urlname=creator;
const targets=new Map();
for(const account of [creator,...accounts]){try{const rows=await allArticles(account);out.coverage[account]={listed:rows.length,complete:true};for(const row of rows)targets.set(row.key,{row,user:account,kind:account===creator?'own':'watch'});}catch(e){out.coverage[account]={complete:false};out.errors.push({user_id:account,reason:e.message});}}
const mentions=JSON.parse(await fs.readFile('data/mentions.json','utf8'));const additional=JSON.parse(await fs.readFile('config/reader-reference-keys.json','utf8'));
for(const key of [...additional,...mentions.records.map(r=>r.article_url?.split('/').at(-1))])if(/^n[a-f0-9]+$/.test(key||'')&&!targets.has(key))targets.set(key,{kind:'reference'});
let cursor=0,completed=0;const entries=[...targets];
async function worker(){while(cursor<entries.length){const[key,t]=entries[cursor++];const s={liked_by_nero:null,commented_by_nero:null,checked_at:new Date().toISOString(),comments_complete:false};out.engagement[key]=s;try{
 const p=await api(`/api/v3/notes/${key}`),d=p.data?.note??p.data;if(!d||typeof d!=='object')throw Error('Unexpected note schema');if(typeof d.is_liked==='boolean')s.liked_by_nero=d.is_liked;
 const cs=await allComments(key);s.comments_complete=true;s.commented_by_nero=cs.some(c=>c.user_id===creator);if(t.kind==='own')out.comments.push(...cs);
 if(t.kind!=='reference'){const r=t.row,free=r.priceInfo?.isFree!==false&&Number(r.price||0)===0&&Number(d.price||0)===0&&d.priceInfo?.isFree!==false;const a={key,user_id:t.user,user_name:r.user?.nickname,title:r.name,url:`https://note.com/${t.user}/n/${key}`,published_at:r.publishAt,body_html:free&&typeof d.body==='string'?d.body:'',comment_count:r.commentCount,...s};(t.kind==='own'?out.articles:out.reading).push(a);}
 }catch(e){s.error=e.message;out.errors.push({key,reason:e.message});}completed++;if(completed%25===0)console.log(JSON.stringify({stage:'progress',completed,total:entries.length}));await delay(250);}}
await Promise.all(Array.from({length:3},worker));out.generated_at=new Date().toISOString();out.coverage.targets={total:entries.length,checked:completed,failed:out.errors.filter(e=>e.key).length};
await fs.mkdir('reader-output',{recursive:true});await fs.writeFile('reader-output/context.json',JSON.stringify(out,null,2));console.log(JSON.stringify({articles:out.articles.length,comments:out.comments.length,reading:out.reading.length,targets:entries.length,liked:Object.values(out.engagement).filter(s=>s.liked_by_nero===true).length,errors:out.errors.length}));
// Never export credentials, raw API responses or Gmail information.
if(!out.articles.length)throw Error('No public article contexts collected');
