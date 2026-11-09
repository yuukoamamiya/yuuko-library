import type { Book, DownloadMirror } from '../../src/lib/book.ts';
import { checkBaiduShare, type BaiduHealthResult } from './baidu-health.ts';

export type MirrorHealthCheck = (book: Book, mirror: DownloadMirror, request?: (url: URL, init: RequestInit) => Promise<Response>, timeout?: number) => Promise<BaiduHealthResult>;

export const MIRROR_HEALTH: Record<string, MirrorHealthCheck> = { baidu: checkBaiduShare };
