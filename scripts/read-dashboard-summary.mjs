import process from 'node:process';
import { chromium } from 'playwright-core';

const TIME_ZONE = 'Asia/Tokyo';
const DASHBOARD_URL = 'https://note.com/dashboard';

function cookieValue(raw = '') {
  let text = raw.trim().replace(/^cookie:\s*/i, '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (!text.includes('_note_session_v5=')) return text;
  const pair = text.split(';').map((v) => v.trim()).find((v) => v.startsWith('_note_session_v5='));
  return pair ? pair.slice('_note_session_v5='.length).replace(/^["']|["']$/g, '') : '';
}

function parseMeta(text) {
  const lines = text.split(/\n+/).map((v) => v.trim()).filter(Boolean);
  const aggregatedAt = lines.find((v) => /^20\d{2}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s+集計$/.test(v)) ?? null;
  const ranges = [...new Set(lines.filter((v) => /^20\d{2}\/\d{1,2}\/\d{1,2}[〜~]20\d{2}\/\d{1,2}\/\d{1,2}$/.test(v)))];
  return { aggregated_at: aggregatedAt, ranges };
}

async function cardNumber(page, label) {
  const loc = page.getByText(label, { exact: true });
  const count = await loc.count();
  for (let i = 0; i < count; i += 1) {
    const value = await loc.nth(i).evaluate((el, expected) => {
      let node = el;
      for (let level = 0; node && level < 8; level += 1, node = node.parentElement) {
        const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
        const match = text.match(new RegExp('^' + expected + '\\s*([\\d,]+)(?:円|件)?$'));
        if (match) return Number(match[1].replaceAll(',', ''));
      }
      return null;
    }, label);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

async function readSummary(page) {
  await page.waitForTimeout(2500);
  const text = await page.locator('body').innerText();
  const meta = parseMeta(text);
  return {
    impressions: await cardNumber(page, 'インプレッション'),
    pageviews: await cardNumber(page, 'ページビュー'),
    likes: await cardNumber(page, 'スキ'),
    comments: await cardNumber(page, 'コメント'),
    sales_yen: await cardNumber(page, '売上'),
    ...meta,
  };
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
  await context.addCookies([{
    name: '_note_session_v5',
    value: cookie,
    domain: '.note.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  }]);

  const page = await context.newPage();
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  if (/login|signin/.test(page.url())) throw new Error('note session redirected to login');

  const recent28 = await readSummary(page);

  const periodButton = page.getByRole('button', { name: /過去28日間|全期間/ }).first();
  if (await periodButton.count()) {
    const current = (await periodButton.innerText()).trim();
    if (current !== '全期間') {
      await periodButton.click();
      const option = page.getByText('全期間', { exact: true }).last();
      if (await option.count()) {
        await option.click();
        await page.waitForTimeout(3500);
      }
    }
  }

  const allTime = await readSummary(page);
  console.log(JSON.stringify({ recent_28_days: recent28, all_time: allTime }, null, 2));
} finally {
  await browser.close();
}
