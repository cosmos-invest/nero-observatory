import process from 'node:process';
import { chromium } from 'playwright-core';

const TIME_ZONE = 'Asia/Tokyo';
const DASHBOARD_URL = 'https://note.com/dashboard';

function cookieValue(raw = '') {
  let text = raw.trim().replace(/^cookie:\s*/i, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text.includes('_note_session_v5=')) return text;
  const pair = text.split(';').map((v) => v.trim()).find((v) => v.startsWith('_note_session_v5='));
  return pair ? pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g, '') : '';
}

function nearestNumber(lines, label) {
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== label) continue;
    for (let j = i + 1; j <= Math.min(lines.length - 1, i + 5); j += 1) {
      const m = lines[j].match(/^([\d,]+)(?:円|件)?$/);
      if (m) {
        candidates.push(Number(m[1].replaceAll(',', '')));
        break;
      }
    }
  }
  return candidates.length ? Math.max(...candidates) : null;
}

function parse(text) {
  const lines = text.split(/\n+/).map((v) => v.trim()).filter(Boolean);
  const agg = lines.find((v) => /^20\d{2}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s+集計$/.test(v)) ?? null;
  const ranges = lines.filter((v) => /^20\d{2}\/\d{1,2}\/\d{1,2}[〜~]20\d{2}\/\d{1,2}\/\d{1,2}$/.test(v));
  const normalized = lines.join('\n');
  const block = normalized.match(/インプレッション\n([\d,]+)\nページビュー\n([\d,]+)\nスキ\n([\d,]+)\nコメント\n([\d,]+)\n売上\n([\d,]+)円/);
  return {
    impressions: block ? Number(block[1].replaceAll(',', '')) : nearestNumber(lines, 'インプレッション'),
    pageviews: block ? Number(block[2].replaceAll(',', '')) : nearestNumber(lines, 'ページビュー'),
    likes: block ? Number(block[3].replaceAll(',', '')) : nearestNumber(lines, 'スキ'),
    comments: block ? Number(block[4].replaceAll(',', '')) : null,
    sales_yen: block ? Number(block[5].replaceAll(',', '')) : null,
    aggregated_at: agg,
    ranges: [...new Set(ranges)],
    summary_block_found: Boolean(block),
  };
}

async function readSummary(page) {
  await page.waitForTimeout(2500);
  return parse(await page.locator('body').innerText());
}

const cookie = cookieValue(process.env.NOTE_SESSION_COOKIE ?? '');
if (!cookie) throw new Error('NOTE_SESSION_COOKIE is required');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
try {
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: TIME_ZONE });
  await context.addCookies([{ name:'_note_session_v5', value:cookie, domain:'.note.com', path:'/', secure:true, httpOnly:true, sameSite:'Lax' }]);
  const page = await context.newPage();
  await page.goto(DASHBOARD_URL, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForTimeout(8000);
  if (/login|signin/.test(page.url())) throw new Error('note session redirected to login');

  const initial = await readSummary(page);
  let allTime = null;

  const periodButton = page.getByRole('button', { name: /過去28日間|全期間/ }).first();
  if (await periodButton.count()) {
    const name = (await periodButton.innerText()).trim();
    if (name !== '全期間') {
      await periodButton.click();
      const option = page.getByText('全期間', { exact:true }).last();
      if (await option.count()) {
        await option.click();
        await page.waitForTimeout(3500);
      }
    }
    allTime = await readSummary(page);
  }

  console.log(JSON.stringify({ initial, all_time: allTime }, null, 2));
} finally {
  await browser.close();
}
