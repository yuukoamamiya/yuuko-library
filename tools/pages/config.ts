import { readFile } from 'node:fs/promises';
import path from 'node:path';
export type PagesConfig = { siteUrl: string; cloudflareAccountId: string; pagesProject: string; cloudflareZone: string; productionBranch: string };
export function validatePagesConfig(value: unknown): PagesConfig {
 const config=value as Partial<PagesConfig>|null;
 if(!config||typeof config!=='object'||! /^[a-f0-9]{32}$/u.test(config.cloudflareAccountId??'')||! /^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u.test(config.pagesProject??'')||! /^[a-z0-9.-]+$/u.test(config.cloudflareZone??'')||! /^[a-z0-9-]+$/u.test(config.productionBranch??'')) throw new Error('Cloudflare / Pages 目标配置无效；请检查 cloudflareAccountId、pagesProject、cloudflareZone 和 productionBranch');
 try{const url=new URL(config.siteUrl??'');if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.'+config.cloudflareZone))throw new Error()}catch{throw new Error('siteUrl 与 cloudflareZone 配置无效')}
 return config as PagesConfig;
}
export async function readPagesConfig(root:string):Promise<PagesConfig>{return validatePagesConfig(JSON.parse(await readFile(path.join(root,'site.config.json'),'utf8')))}
