import { chromium } from 'playwright-core';

const baseUrl = process.env.NERO_TEST_URL ?? 'http://127.0.0.1:4173';
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: ['--no-sandbox'],
});

try {
  for (const viewport of [
    { name: 'Pixel', width: 412, height: 915 },
    { name: 'small-phone', width: 360, height: 800 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    const result = await page.evaluate(() => {
      const visible = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const board = document.querySelector('#observation-board')?.getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        boardLeft: board?.left ?? null,
        boardRight: board?.right ?? null,
        articleType: visible('#article-type'),
        outliers: visible('#toggle-outliers'),
        capture: visible('#toggle-capture'),
        chart: visible('#article-rate-chart'),
        hashtags: visible('#hashtags'),
      };
    });

    if (errors.length) throw new Error(`${viewport.name}: page error: ${errors.join(' | ')}`);
    if (result.documentWidth > result.viewportWidth + 1) throw new Error(`${viewport.name}: horizontal overflow ${result.documentWidth}px > ${result.viewportWidth}px`);
    if (result.boardLeft < -1 || result.boardRight > result.viewportWidth + 1) throw new Error(`${viewport.name}: observation board exceeds viewport`);
    for (const key of ['articleType', 'outliers', 'capture', 'chart', 'hashtags']) {
      if (!result[key]) throw new Error(`${viewport.name}: ${key} is not visible`);
    }
    console.log(`${viewport.name}: mobile smoke ok`, result);
    await page.close();
  }
} finally {
  await browser.close();
}
