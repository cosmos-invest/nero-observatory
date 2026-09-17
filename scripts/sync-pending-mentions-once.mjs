import fs from 'node:fs';

const path = 'data/mentions.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const incoming = [
  {actor:'マツリカ｜【心と日常の翻訳】',article_title:'敗北上等セツごっこ｜現実に敗北し続ける古の妖怪、異世界転生を目論む',article_url:'https://note.com/notes/n5e9505634dc5',introduced_at:'2026-09-17T05:02:51.000Z'},
  {actor:'唯乃ひめ',article_title:'【参加型】みんなでnoteをシェアしあいたい！お気軽にどうぞ♡【2】',article_url:'https://note.com/notes/nbac7627d4689',introduced_at:'2026-09-17T04:14:52.000Z'},
  {actor:'紡えり ⁂GPT遊びに夢中⁂',article_title:'【お勧め】なぜ2回も書いたのか！？',article_url:'https://note.com/notes/nce2592183e8b',introduced_at:'2026-09-17T03:35:04.000Z'},
  {actor:'ノン',article_title:'【王子ごっこ参戦】遊んでいたら、最後は王女になっていた',article_url:'https://note.com/notes/n2a9e171621ac',introduced_at:'2026-09-16T23:03:29.000Z'},
  {actor:'のりもち',article_title:'記憶の森の観測隊｜キャラクター紹介',article_url:'https://note.com/notes/nbe9e06064934',introduced_at:'2026-09-16T22:48:08.000Z'},
  {actor:'セツ｜note転生した侍（相互フォロー、色々制限中）',article_title:'敗北、十一人目は王子。自分の祭りに負けた人',article_url:'https://note.com/notes/nd73d3ff1faab',introduced_at:'2026-09-16T22:35:17.000Z'},
  {actor:'ミーゴ｜彼の答えがなくても恋を決める人',article_title:'恋愛noteを書いていたはずなのに、魔界で10体撃破しました。',article_url:'https://note.com/notes/n22526fc9db92',introduced_at:'2026-09-16T15:23:59.000Z'},
  {actor:'すい＠夜型のエンジニア⭐️',article_title:'🌙✨️ ネロ魔界祝杯 🌙✨️＋武術会開催！！',article_url:'https://note.com/notes/n7e446045f10b',introduced_at:'2026-09-16T14:10:52.000Z'},
  {actor:'わかモン＠かくさないネカマ',article_title:'スクロールが長すぎんだよ！！勢いだけじゃなく「読ませる文章」を書きたいと思った日',article_url:'https://note.com/notes/n8e66e8edb572',introduced_at:'2026-09-16T14:00:34.000Z'},
  {actor:'弁護士 岡本卓大',article_title:'【Geminiくんが語る神武征討記（ ・ω・）】',article_url:'https://note.com/notes/nc8bddb68eadc',introduced_at:'2026-09-16T13:47:42.000Z'},
  {actor:'わかモン＠かくさないネカマ',article_title:'寝た！！復活した！！そしたら今日もnoteがお祭りだった🤣紹介したい人、多すぎ問題！！',article_url:'https://note.com/notes/n019f3225fa66',introduced_at:'2026-09-16T13:29:28.000Z'},
  {actor:'算術01',article_title:'一番乗りを逃した01の言い訳',article_url:'https://note.com/notes/nd524d641cda8',introduced_at:'2026-09-16T13:04:28.000Z'},
  {actor:'sakita',article_title:'ネコ王子、誕生。猫たちの金言',article_url:'https://note.com/notes/n7489255affca',introduced_at:'2026-09-16T12:53:35.000Z'},
  {actor:'アイル',article_title:'ネロ王子、祝！！🌙⚔️👑✨【#ネロ1000人斬り】',article_url:'https://note.com/notes/n93e3ff2e2e48',introduced_at:'2026-09-16T11:56:24.000Z'}
];
const key = u => (String(u).match(/\/notes\/(n[a-z0-9]+)/i)||[])[1]?.toLowerCase() || String(u).split(/[?#]/)[0].replace(/\/$/,'');
const seen = new Set(data.records.map(r => key(r.article_url)));
for (const r of incoming) if (!seen.has(key(r.article_url))) { data.records.push(r); seen.add(key(r.article_url)); }
data.records.sort((a,b) => new Date(b.introduced_at)-new Date(a.introduced_at));
data.total_count = data.records.length;
data.generated_at = new Date().toISOString();
fs.writeFileSync(path, JSON.stringify(data,null,2)+'\n');
console.log(`mentions total=${data.total_count}`);
