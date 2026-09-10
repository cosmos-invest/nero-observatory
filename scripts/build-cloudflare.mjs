import fs from 'node:fs/promises';

const OUT_DIR = 'dist';
const ROOT_FILES = [
  'index.html',
  'app.js',
  'observatory-core.mjs',
  'analysis-core.mjs',
  'styles.css',
  'chart-labels.css',
  'public-overrides.css',
  '.nojekyll',
];
const DATA_FILES = [
  'public_dashboard.json',
  'article_metrics.json',
  'articles.json',
  'mentions.json',
];

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(`${OUT_DIR}/data`, { recursive: true });

for (const file of ROOT_FILES) {
  await fs.copyFile(file, `${OUT_DIR}/${file}`);
}
for (const file of DATA_FILES) {
  await fs.copyFile(`data/${file}`, `${OUT_DIR}/data/${file}`);
}

console.log(`Cloudflare Pages bundle ready in ${OUT_DIR}/`);
