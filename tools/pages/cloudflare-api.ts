import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
export type CloudflareFetch = typeof fetch;
export function readWranglerToken(root: string, run: typeof spawnSync = spawnSync) {
  const result = run(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }) as SpawnSyncReturns<string>;
  if (result.status !== 0) throw new Error('请先完成 Wrangler 登录');
  try { const token = JSON.parse(result.stdout).token; if (typeof token !== 'string' || !token) throw new Error(); return token; }
  catch { throw new Error('Wrangler 凭据不可用，输出已隐藏'); }
}
export async function requestCloudflare<T>(endpoint: string, token: string, options: { method?: string; payload?: unknown; fetcher?: CloudflareFetch; apiToken?: string } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await (options.fetcher ?? fetch)(`https://api.cloudflare.com/client/v4/${endpoint}`, {
    method, headers: { Authorization: `Bearer ${options.apiToken ?? token}`, 'Content-Type': 'application/json' },
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  let data: any; try { data = await response.json(); } catch { throw new Error(`Cloudflare API HTTP ${response.status}，响应无效`); }
  if (!response.ok || !data.success) throw new Error(`Cloudflare API HTTP ${response.status}，错误码 ${data.errors?.map((error: { code: number }) => error.code).join(',') ?? 'unknown'}`);
  return data.result as T;
}
