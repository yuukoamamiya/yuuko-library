import { readFile, writeFile, mkdir, open, unlink, rename } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { r2Settings } from './config.ts';
import { downloadOrigin, transferBook, TransferError, type ObjectStore } from './transfer.ts';
import type { Book } from '../../src/lib/books.ts';
import { requireCurrentPlan, planDir } from '../book/plan.ts';
import type { UploadReport } from './report.ts';

export function safeMessage(error: unknown): string {
  if (error instanceof TransferError) return error.message;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 401 || status === 403 ? 'R2 认证失败或桶权限不足'
    : status === 404 ? 'R2 存储桶或对象不存在' : 'R2 操作失败；请检查网络、权限和本地配置';
}
async function connection(root: string) {
  try { loadEnvFile(path.join(root, '.env.local')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TransferError('无法读取本机 .env.local');
  }
  const config = JSON.parse(await readFile(path.join(root, 'site.config.json'), 'utf8'));
  let settings: ReturnType<typeof r2Settings>;
  try { settings = r2Settings(config, process.env); } catch (error) { throw new TransferError((error as Error).message); }
  const client = new S3Client({ region: 'auto', endpoint: settings.endpoint, credentials: settings.credentials,
    maxAttempts: 2, requestHandler: { connectionTimeout: 10000, requestTimeout: 120000 } });
  return { config, settings, client };
}
function objectStore(client: S3Client, bucket: string): ObjectStore {
  return {
    async head(key) {
      try {
        const value = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { bytes: value.ContentLength ?? -1, sha256: value.Metadata?.sha256 ?? '',
          contentType: value.ContentType ?? '', contentDisposition: value.ContentDisposition ?? '' };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async put(key, bytes, headers) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: '*',
        ContentType: headers.contentType, ContentDisposition: headers.contentDisposition,
        CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256: headers.sha256 } }));
    },
  };
}
async function loadPlan(root: string, id: string) {
  let plan; try { plan = await requireCurrentPlan(root, id); } catch { throw new TransferError('审核计划过期或内容被修改，请重新 prepare'); }
  const dir = planDir(root, id);
  if (!plan.books.length || plan.books.length > 200) throw new TransferError('计划内容无效');
  return { plan, dir };
}

export async function executeR2(root: string, command: string, planId?: string, bookId?: string, onProgress: (message: string) => void = () => {}) {
  if (!['check', 'upload', 'verify'].includes(command)) throw new TransferError('命令无效；运行 --help 查看帮助');
  const { config, settings, client } = await connection(root);
  try {
    if (command === 'check') {
      await client.send(new HeadBucketCommand({ Bucket: settings.bucket }));
      const result = await client.send(new ListObjectsV2Command({ Bucket: settings.bucket, MaxKeys: 1 }));
      return { status: 'connected', bucket: settings.bucket, endpoint: settings.endpoint,
        bucketReadable: true, listingReadable: true, sampleObjectCount: result.KeyCount ?? 0,
        writePermissionVerified: false, publicDownloadVerified: false, remoteWrites: false };
    }
    if (!planId) throw new TransferError('上传或验证需要 --plan');
    const { plan, dir } = await loadPlan(root, planId);
    const origin = downloadOrigin(config.downloadsUrl);
    const books = bookId ? plan.books.filter(book => book.id === bookId) : [...plan.books];
    if (!books.length) throw new TransferError('计划中没有指定书籍');
    const pilot = books.find(book => book.id === 'mute-compulsion') ?? books[0];
    const ordered = [pilot, ...books.filter(book => book.id !== pilot.id)];
    const store = objectStore(client, settings.bucket);
    const reportDir = path.join(root, '.local/uploads'); await mkdir(reportDir, { recursive: true });
    const lockPath = path.join(reportDir, `${settings.bucket}.lock`);
    let lock;
    try { lock = await open(lockPath, 'wx'); } catch { throw new TransferError('此桶已有上传或验证进程；先检查锁文件和正在运行的进程'); }
    const reportPath = path.join(reportDir, `${planId}${bookId ? `-${pilot.id}` : ''}-${command}.json`);
    const report: UploadReport = {
      schemaVersion: 1, command, planId, reviewHash: plan.reviewHash, bucket: settings.bucket, origin,
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', expected: books.length, verified: [], failures: [] };
    let queue = Promise.resolve();
    function checkpoint() {
      const value = JSON.stringify(report, null, 2) + '\n';
      queue = queue.then(async () => { await writeFile(reportPath + '.tmp', value, 'utf8'); await rename(reportPath + '.tmp', reportPath); });
      return queue;
    }
    async function run(book: Book) {
      try {
        const bytes = await readFile(path.join(dir, 'inputs', `${book.id}.epub`));
        const verified = await transferBook({ book, bytes, origin, store, readOnly: command === 'verify' });
        report.verified.push(verified); await checkpoint();
        onProgress(`已校验 ${report.verified.length}/${books.length}：${book.title} (${verified.action})`);
        return true;
      } catch (error) {
        report.failures.push({ id: book.id, message: safeMessage(error) }); await checkpoint();
        onProgress(`校验失败：${book.title}；${safeMessage(error)}`);
        return false;
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, planId, command, startedAt: report.startedAt }));
      await checkpoint();
      // The first object must pass a complete public GET before starting the batch.
      if (await run(ordered[0])) {
        let next = 1;
        const workers = await Promise.allSettled(Array.from({ length: Math.min(3, ordered.length - 1) }, async () => {
          while (next < ordered.length) { const book = ordered[next++]; await run(book); }
        }));
        if (workers.some(worker => worker.status === 'rejected')) throw new TransferError('本地校验日志写入失败；远端对象保留，可修复后重试');
      }
      report.status = report.failures.length || report.verified.length !== books.length ? 'failed' : 'verified';
      report.finishedAt = new Date().toISOString(); await checkpoint();
      return { status: report.status, planId, bucket: settings.bucket, expected: books.length, verified: report.verified.length,
        uploaded: report.verified.filter(item => item.action === 'uploaded').length,
        reused: report.verified.filter(item => item.action === 'reused').length,
        failures: report.failures, report: reportPath, websiteDeployed: false };
    } finally { try { await queue; } finally { await lock.close(); await unlink(lockPath); } }
  } finally { client.destroy(); }
}
