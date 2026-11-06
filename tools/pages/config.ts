import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type PagesConfig = {
  siteUrl: string;
  cloudflareAccountId: string;
  pagesProject: string;
  cloudflareZone: string;
  productionBranch: string;
};

export function validatePagesConfig(value: unknown): PagesConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloudflare / Pages 目标配置无效');
  }

  const config = value as Partial<PagesConfig>;
  const required = [config.siteUrl, config.cloudflareAccountId, config.pagesProject, config.cloudflareZone, config.productionBranch];
  if (required.some(field => typeof field !== 'string' || field.length === 0)) {
    throw new Error('Cloudflare / Pages 配置中的 siteUrl、cloudflareAccountId、pagesProject、cloudflareZone 和 productionBranch 必须为非空字符串');
  }
  if (!/^[a-f0-9]{32}$/u.test(config.cloudflareAccountId!)
    || !/^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u.test(config.pagesProject!)
    || !/^[a-z0-9.-]+$/u.test(config.cloudflareZone!)
    || !/^[a-z0-9-]+$/u.test(config.productionBranch!)) {
    throw new Error('Cloudflare / Pages 目标配置无效；请检查 cloudflareAccountId、pagesProject、cloudflareZone 和 productionBranch');
  }

  let url: URL;
  try {
    url = new URL(config.siteUrl ?? '');
  } catch {
    throw new Error('siteUrl 与 cloudflareZone 配置无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !url.hostname.endsWith(`.${config.cloudflareZone}`)) {
    throw new Error('siteUrl 与 cloudflareZone 配置无效');
  }

  return config as PagesConfig;
}

export async function readPagesConfig(root: string): Promise<PagesConfig> {
  const raw = await readFile(path.join(root, 'site.config.json'), 'utf8');
  return validatePagesConfig(JSON.parse(raw));
}
