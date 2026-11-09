import type { DownloadMirror } from './book';
import { baiduProvider } from './baidu';

export interface MirrorProvider {
  id: string;
  label: string;
  validate(mirror: DownloadMirror, expectedSha256: string): void;
}

export const MIRROR_PROVIDERS: Record<string, MirrorProvider> = { baidu: baiduProvider };

export function validateMirror(mirror: DownloadMirror, expectedSha256: string): void {
  const provider = mirror && typeof mirror.provider === 'string' ? MIRROR_PROVIDERS[mirror.provider] : undefined;
  if (!provider) throw new Error(`未知下载镜像 provider：${mirror?.provider ?? 'unknown'}`);
  provider.validate(mirror, expectedSha256);
}

export function mirrorLabel(provider: string): string {
  return MIRROR_PROVIDERS[provider]?.label ?? provider;
}

export function mirrorList(mirrors: Record<string, DownloadMirror>): DownloadMirror[] {
  return Object.keys(mirrors).sort().map(provider => mirrors[provider]);
}
