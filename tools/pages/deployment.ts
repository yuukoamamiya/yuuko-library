import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readWranglerToken, requestCloudflare } from './cloudflare-api.ts';
import type { Release } from './release.ts';

export async function readOptional(file: string) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeState(file: string, value: unknown) {
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  await rename(file + '.tmp', file);
}
export function projectStateDir(root: string, project: string) {
  if (!/^[a-z0-9-]+$/u.test(project)) throw new Error('Pages 项目名无效');
  return path.join(root, '.local/pages', project);
}
export async function withProjectLock<T>(root: string, project: string, run: () => Promise<T>): Promise<T> {
  const dir = projectStateDir(root, project); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'publish.lock');
  let lock;
  try { lock = await open(file, 'wx'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Pages 项目已锁定；先检查锁中 PID 对应进程，进程终止后才可手动清除锁');
    throw error;
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await run(); }
  finally { await lock.close(); await unlink(file); }
}
export interface RemoteDeployment { id: string; status: string; url: string; branch: string; message: string }
export function matchingDeployments(release: Release, records: RemoteDeployment[]) {
  return records.filter(item => item.branch === release.branch && item.message === `Publish ${release.id}`);
}
export function deploymentDecision(previous: { status: string } | null, remote: RemoteDeployment[], retry: boolean) {
  if (remote.some(item => item.status === 'success') || previous?.status === 'published') return 'verify';
  if (remote.some(item => !['failure', 'canceled', 'cancelled'].includes(item.status))) throw new Error('远端部署仍在进行或状态未知，停止重复部署');
  if (previous || remote.length) {
    if (!remote.length) throw new Error('已有提交记录但远端尚未定位；运行 status 并核对 Pages 控制台，禁止盲目重试');
    if (!retry) throw new Error('远端已确认失败；复查 status 后使用 deploy --retry 显式重试');
  }
  return 'deploy';
}
export async function remoteDeployments(root: string, account: string, project: string): Promise<RemoteDeployment[]> {
  if (!/^[a-f0-9]{32}$/u.test(account) || !/^[a-z0-9-]+$/u.test(project)) throw new Error('Cloudflare 目标配置无效');
  const token = readWranglerToken(root);
  const records: RemoteDeployment[] = [];
  for (let page = 1; ; page++) {
    const pageRecords = await requestCloudflare<any[]>(`accounts/${account}/pages/projects/${project}/deployments?page=${page}&per_page=25`, token);
    records.push(...pageRecords.map((item: any) => ({ id: item.id, url: item.url, status: item.latest_stage?.status ?? 'unknown',
      branch: item.deployment_trigger?.metadata?.branch ?? '', message: item.deployment_trigger?.metadata?.commit_message ?? '' })));
    if (pageRecords.length < 25) break;
  }
  return records;
}
