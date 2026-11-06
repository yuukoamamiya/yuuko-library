import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertCatalogSyncable, assertDeployable, makeRelease, makeSiteRelease, readRelease, releaseDir, syncCatalog } from './release.ts';
import { siteUrl, verifyRelease } from './verify.ts';
import { deploymentDecision, matchingDeployments, projectStateDir, readOptional, remoteDeployments, withProjectLock, writeState } from './deployment.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    plan: { type: 'string' }, report: { type: 'string' }, release: { type: 'string' }, url: { type: 'string' }, help: { type: 'boolean' },
    'site-only': { type: 'boolean' },
    retry: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log('Pages CLI:\n  prepare --plan PLAN --report UPLOAD_REPORT\n  prepare --site-only\n  status --release RELEASE\n  deploy --release RELEASE [--retry]\n  verify --release RELEASE --url HTTPS_URL\nprepare 仅生成本地正式构建；status 只读查询；deploy 会发布网站；verify 通过后同步正式书目。'); return; }
  if (positionals.length !== 1) throw new Error('只接受一个子命令');
  const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
  if (command !== 'prepare' && (values.plan || values.report || values['site-only'])) throw new Error('本命令不接受 prepare 参数');
  if (command !== 'deploy' && values.retry) throw new Error('--retry 仅用于 deploy');
  if (command === 'prepare') {
    if (values.release || values.url) throw new Error('prepare 不接受 release 或 url');
    if (values['site-only'] && (values.plan || values.report)) throw new Error('--site-only 不能与 --plan 或 --report 混用');
    if (!values['site-only'] && (!values.plan || !values.report)) throw new Error('需要 --plan 和 --report，或 --site-only');
    if (!values['site-only']) {
      const status = spawnSync(process.execPath, ['--import', 'tsx', 'tools/book/cli.ts', 'status', '--plan', values.plan!, '--json'], { cwd: root, encoding: 'utf8' });
      if (status.status !== 0) throw new Error('审核计划过期，请重新 prepare');
    }
    const build = (site: string) => {
      const result = spawnSync(process.execPath, [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'build', '--root', site],
        { cwd: root, env: { ...process.env, BOOK_SITE_ROOT: site, ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 2, 2] });
      if (result.status !== 0) throw new Error('正式构建失败');
    };
    const release = values['site-only'] ? await makeSiteRelease(root, build)
      : await makeRelease(root, values.plan!, path.resolve(values.report!), build);
    console.log(JSON.stringify({ status: 'ready', releaseId: release.id, books: release.catalog.length, changedBooks: release.books.length, digest: release.digest,
      dist: path.join(releaseDir(root, release.id), 'site/dist') }, null, 2)); return;
  }
  if (!values.release || !['deploy', 'verify', 'status'].includes(command)) throw new Error('需要有效的命令与 --release');
  const release = await readRelease(root, values.release);
  const dir = releaseDir(root, release.id);
  if (release.project !== config.pagesProject || release.branch !== config.productionBranch) throw new Error('部署目标改变，请重新准备发布');
  const accountId = new URL(config.r2Endpoint).hostname.split('.')[0];
  const stateFile = path.join(dir, 'deployment.json');
  const activeFile = path.join(projectStateDir(root, release.project), 'active.json');
  if (command === 'status') {
    const remote = matchingDeployments(release, await remoteDeployments(root, accountId, release.project));
    console.log(JSON.stringify({ releaseId: release.id, local: await readOptional(stateFile), active: await readOptional(activeFile), remote,
      next: remote.some(item => item.status === 'success') ? '运行 verify 核对线上并恢复本地同步' : '核对远端状态；未确定结果时禁止重试' }, null, 2));
    return;
  }
  if (command === 'deploy') assertDeployable(release);
  await withProjectLock(root, release.project, async () => {
    if (command === 'deploy') {
      await assertCatalogSyncable(root, release);
      const active = await readOptional(activeFile);
      if (active && active.releaseId !== release.id) throw new Error(`项目仍有未完成发布 ${active.releaseId}；先运行该发布的 status 和 verify`);
      const remote = matchingDeployments(release, await remoteDeployments(root, accountId, release.project));
      if (deploymentDecision(await readOptional(stateFile), remote, values.retry ?? false) === 'verify') {
        console.log(JSON.stringify({ status: 'already-submitted', releaseId: release.id, next: '运行 verify；未重复部署' })); return;
      }
      const submitting = { status: 'submitting', releaseId: release.id, startedAt: new Date().toISOString() };
      await writeState(activeFile, submitting);
      await writeState(stateFile, submitting);
      const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'pages', 'deploy', path.join(dir, 'site/dist'),
        '--project-name', release.project, '--branch', release.branch, '--commit-dirty=true', '--commit-message', `Publish ${release.id}`],
        { cwd: root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' });
      const state = { status: result.status === 0 ? 'submitted' : 'uncertain', exitCode: result.status,
        releaseId: release.id, project: release.project, finishedAt: new Date().toISOString() };
      await writeState(stateFile, state);
      if (result.status !== 0) throw new Error('部署结果尚未确认；先核对 Pages 部署列表及线上 release.json，不要盲目重试');
      console.log(JSON.stringify({ ...state, next: '运行 verify 核对线上发布标识并同步正式书目' }, null, 2)); return;
    }
    if (!values.url) throw new Error('verify 需要实际的 --url');
    const url = siteUrl(values.url);
    await verifyRelease(release, url);
    await syncCatalog(root, release);
    const result = { status: 'published', releaseId: release.id, url: url.origin, books: release.catalog.length, changedBooks: release.books.length,
      verifiedAt: new Date().toISOString(), localCatalogSynced: true };
    await writeState(stateFile, result);
    const active = await readOptional(activeFile);
    if (active?.releaseId === release.id) await unlink(activeFile);
    console.log(JSON.stringify(result, null, 2));
  });
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
