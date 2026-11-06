import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeRelease, readRelease, releaseDir, syncCatalog } from './release.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    plan: { type: 'string' }, report: { type: 'string' }, release: { type: 'string' }, url: { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log('Pages CLI:\n  prepare --plan PLAN --report UPLOAD_REPORT\n  deploy --release RELEASE\n  verify --release RELEASE --url HTTPS_URL\nprepare 仅生成本地正式构建；deploy 会发布网站。'); return; }
  if (positionals.length !== 1) throw new Error('只接受一个子命令');
  const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
  if (command === 'prepare') {
    if (!values.plan || !values.report) throw new Error('需要 --plan 和 --report');
    const status = spawnSync(process.execPath, ['--import', 'tsx', 'tools/book/cli.ts', 'status', '--plan', values.plan, '--json'], { cwd: root, encoding: 'utf8' });
    if (status.status !== 0) throw new Error('审核计划过期，请重新 prepare');
    const release = await makeRelease(root, values.plan, path.resolve(values.report), site => {
      const result = spawnSync(process.execPath, [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'build', '--root', site],
        { cwd: root, env: { ...process.env, BOOK_SITE_ROOT: site, ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 2, 2] });
      if (result.status !== 0) throw new Error('正式构建失败');
    });
    console.log(JSON.stringify({ status: 'ready', releaseId: release.id, books: release.books.length, digest: release.digest,
      dist: path.join(releaseDir(root, release.id), 'site/dist') }, null, 2)); return;
  }
  if (!values.release || !['deploy', 'verify'].includes(command)) throw new Error('需要有效的命令与 --release');
  const release = await readRelease(root, values.release);
  const dir = releaseDir(root, release.id);
  if (command === 'deploy') {
    if (release.project !== config.pagesProject || release.branch !== config.productionBranch) throw new Error('部署目标改变，请重新准备发布');
    await writeFile(path.join(dir, 'deployment.json'), JSON.stringify({ status: 'submitting', startedAt: new Date().toISOString() }) + '\n');
    const accountId = new URL(config.r2Endpoint).hostname.split('.')[0];
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'pages', 'deploy', path.join(dir, 'site/dist'),
      '--project-name', release.project, '--branch', release.branch, '--commit-dirty=true', '--commit-message', `Publish ${release.id}`],
      { cwd: root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' });
    const state = { status: result.status === 0 ? 'submitted' : 'uncertain', exitCode: result.status,
      releaseId: release.id, project: release.project, finishedAt: new Date().toISOString() };
    await writeFile(path.join(dir, 'deployment.json'), JSON.stringify(state, null, 2) + '\n');
    if (result.status !== 0) throw new Error('部署结果尚未确认；先核对 Pages 部署列表及线上 release.json，不要盲目重试');
    console.log(JSON.stringify({ ...state, next: '运行 verify 核对线上发布标识并同步正式书目' }, null, 2)); return;
  }
  if (!values.url) throw new Error('verify 需要实际的 --url');
  const url = new URL(values.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('需要 HTTPS 站点根地址');
  const response = await fetch(new URL(`/release.json?verify=${release.id}`, url), { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error('无法读取线上发布标识');
  const marker = await response.json();
  if (marker.releaseId !== release.id || marker.books !== release.books.length) throw new Error('线上发布标识不匹配');
  const homepage = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const html = await homepage.text();
  if (!homepage.ok || !html.includes('雨宫优子图书馆') || html.includes('本地预览 · 尚未发布')) throw new Error('线上首页校验失败');
  const index = await fetch(new URL('/search-index.json', url), { signal: AbortSignal.timeout(30000) });
  const records = await index.json() as { id: string }[];
  if (!index.ok || release.books.some(book => !records.some(item => item.id === book.id))) throw new Error('线上检索索引缺少书籍');
  for (const book of release.books) {
    const page = await fetch(new URL(`/books/${book.id}/`, url), { signal: AbortSignal.timeout(30000) });
    if (!page.ok || !(await page.text()).includes(book.downloads.r2Url!)) throw new Error(`线上详情或下载链接不匹配：${book.id}`);
  }
  await syncCatalog(root, release);
  const result = { status: 'published', releaseId: release.id, url: url.origin, books: release.books.length,
    verifiedAt: new Date().toISOString(), localCatalogSynced: true };
  await writeFile(path.join(dir, 'deployment.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
