import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function main() {
  try { loadEnvFile(path.join(root, '.env.local')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本地环境配置');
  }
  const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
  const account = new URL(config.r2Endpoint).hostname.split('.')[0];
  const hostname = new URL(config.siteUrl).hostname;
  if (!/^[a-f0-9]{32}$/u.test(account) || !/^[a-z0-9-]+$/u.test(config.pagesProject)
    || !/^[a-z0-9.-]+$/u.test(config.cloudflareZone) || !hostname.endsWith('.' + config.cloudflareZone)) throw new Error('Cloudflare 目标配置无效');
  const command = process.argv[2];
  if (!['domain-status', 'domain-add', 'dns-status', 'dns-add', 'project-status'].includes(command)) throw new Error('接受 domain-status / domain-add / dns-status / dns-add / project-status');
  let token: string | undefined;
  if (!token) {
    // Capture credentials from Wrangler in memory; never echo or persist the output.
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    if (result.status !== 0) throw new Error('请先完成 Wrangler 登录');
    try { token = JSON.parse(result.stdout).token; } catch { throw new Error('Wrangler 凭据输出无效，内容已隐藏'); }
  }
  if (!token) throw new Error('Cloudflare 凭据不可用');
  async function api(endpoint: string, method = 'GET', payload?: unknown): Promise<any> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${endpoint}`, { method,
      headers: { Authorization: `Bearer ${endpoint.includes('/dns_records') ? process.env.CLOUDFLARE_DNS_API_TOKEN ?? token : token}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(`Cloudflare API HTTP ${response.status}，错误码 ${data.errors?.map((error: { code: number }) => error.code).join(',') ?? 'unknown'}`);
    return data.result;
  }
  const projectPath = `accounts/${account}/pages/projects/${encodeURIComponent(config.pagesProject)}`;
  if (command === 'project-status') {
    const project = await api(projectPath);
    console.log(JSON.stringify({ name: project.name, subdomain: project.subdomain, domains: project.domains,
      deployment: project.canonical_deployment ? { id: project.canonical_deployment.id, url: project.canonical_deployment.url, status: project.canonical_deployment.latest_stage?.status } : null }, null, 2)); return;
  }
  if (command.startsWith('domain-')) {
    const domains = await api(`${projectPath}/domains`);
    let domain = domains.find((item: { name: string }) => item.name === hostname);
    if (!domain && command === 'domain-add') domain = await api(`${projectPath}/domains`, 'POST', { name: hostname });
    console.log(JSON.stringify({ hostname, domain: domain ?? null }, null, 2)); return;
  }
  const zones = await api(`zones?name=${encodeURIComponent(config.cloudflareZone)}`);
  if (zones.length !== 1) throw new Error('无法唯一定位域名所属 Zone');
  const zone = zones[0];
  const recordsPath = `zones/${zone.id}/dns_records`;
  const records = await api(`${recordsPath}?name=${encodeURIComponent(hostname)}`);
  const project = await api(projectPath);
  const expected = project.subdomain;
  if (command === 'dns-add') {
    if (records.length && !records.every((item: { type: string; content: string }) => item.type === 'CNAME' && item.content === expected)) {
      throw new Error('目标域名已有其他 DNS 记录，未覆盖');
    }
    if (!records.length) records.push(await api(recordsPath, 'POST', { type: 'CNAME', name: hostname, content: expected, ttl: 1, proxied: true }));
  }
  console.log(JSON.stringify({ hostname, expected, records: records.map((item: { type: string; name: string; content: string; proxied: boolean }) =>
    ({ type: item.type, name: item.name, content: item.content, proxied: item.proxied })) }, null, 2));
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
