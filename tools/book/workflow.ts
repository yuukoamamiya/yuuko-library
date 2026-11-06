import { readFile, writeFile, readdir, mkdir, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { extractEpub, sha256 } from './epub.ts';
import type { Book } from '../../src/lib/books.ts';
import { validateCategories, categoryLabel } from '../../src/lib/categories.ts';
import { type Input, type Plan, SOURCE_PATHS, planDir, inventory, exists, sourceFingerprint, inspectPlan } from './plan.ts';
import { CliError } from './errors.ts';
const jsonRead = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
async function jsonWrite(file: string, data: unknown) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
function checkInput(input: Input) {
  const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || typeof input.epub !== 'string'
    || (input.model !== undefined && typeof input.model !== 'string')
    || (input.update !== undefined && typeof input.update !== 'boolean')) {
    throw new CliError('manifest 条目字段类型无效');
  }
  if (!input.id || input.id.length > 80 || !idPattern.test(input.id)) {
    throw new CliError('id 必须为不超过 80 字符的小写英文、数字及连字符');
  }
  if (!input.epub || !input.epub.toLowerCase().endsWith('.epub')) {
    throw new CliError(`${input.id} 需要本地 EPUB 路径`);
  }
  if (input.kind && !['ai-translation', 'transcription'].includes(input.kind)) {
    throw new CliError('无效的版本类型');
  }
  if (input.kind === 'transcription' ? input.model !== undefined : !input.model?.trim()) {
    throw new CliError('AI 译本必须填写 model；中文出版物转录不得填写 model');
  }
  if (!input.update || input.categories !== undefined) {
    try { validateCategories(input.categories); }
    catch (error) { throw new CliError((error as Error).message); }
  }
}
function buildSite(root: string, dir: string) {
  const site = path.join(dir, 'site');
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'build', '--root', site], {
    cwd: root,
    env: { ...process.env, BOOK_SITE_ROOT: site, ASTRO_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 2, 2],
  });
  if (result.error || result.status !== 0) {
    throw new CliError(`构建失败：${result.error?.message ?? result.status}`, 4);
  }
}
export async function prepareBooks(root:string,inputs:Input[],onProgress:(message:string)=>void=message=>process.stderr.write(message+'\n')): Promise<Plan> {

  if (!inputs.length || inputs.length > 200) throw new CliError('每批应包含 1–200 本书');
  inputs.forEach(checkInput);
  if (new Set(inputs.map(input => input.id)).size !== inputs.length) throw new CliError('本批包含重复 id');
  const id = `p-${randomUUID()}`;
  const dir = planDir(root, id);
  const baseFingerprint = await sourceFingerprint(root);
  const config = await jsonRead(path.join(root, 'site.config.json'));
  const changes: Plan['changes'] = []; const books: Book[] = [];
  for (const input of inputs) {
    const bookFile = path.join(root, 'catalog/books', `${input.id}.json`);
    const present = await exists(bookFile);
    if (present !== Boolean(input.update)) throw new CliError(present
      ? `${input.id} 已存在；更新需要 --update` : `${input.id} 不存在，不能更新`, 3);
  }
  await mkdir(path.join(dir, 'inputs'), { recursive: true });
  try {
    const site = path.join(dir, 'site');
    for (const relative of SOURCE_PATHS.filter(name => name !== 'tools')) {
      const source = path.join(root, relative);
      if (await exists(source)) await cp(source, path.join(site, relative), { recursive: true });
    }
    for (const input of inputs) {
      const frozen = path.join(dir, 'inputs', `${input.id}.epub`);
      await copyFile(path.resolve(input.epub), frozen);
      const metadata = await extractEpub(frozen);
      let cover: string | null = null;
      if (metadata.cover) {
        cover = `/covers/${input.id}/${sha256(metadata.cover.bytes)}.${metadata.cover.extension}`;
        const destination = path.join(site, 'public', cover.slice(1));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, metadata.cover.bytes);
      }
      const previous: Book | null = input.update ? await jsonRead(path.join(root, 'catalog/books', `${input.id}.json`)) : null;
      const r2Key = `books/${input.id}/${metadata.sha256}.epub`;
      const book: Book = { schemaVersion: 1, id: input.id,
        title: metadata.title, authors: metadata.authors, description: metadata.description, subjects: metadata.subjects,
        categories: input.categories ?? previous!.categories,
        cover, edition: input.kind === 'transcription' ? { kind: 'transcription', model: null }
          : { kind: 'ai-translation', model: input.model!.trim() },
        file: { sha256: metadata.sha256, bytes: metadata.bytes,
          filename: previous?.file.sha256 === metadata.sha256 && previous.file.bytes === metadata.bytes
            ? previous.file.filename : path.basename(input.epub) },
        downloads: { r2Key, r2Url: config.downloadsUrl ? new URL(r2Key, config.downloadsUrl.replace(/\/?$/u, '/')).href : null,
          baidu: previous?.file.sha256 === metadata.sha256 ? previous.downloads.baidu : null },
        publishedAt: previous?.publishedAt ?? null, updatedAt: previous?.updatedAt ?? null };
      const warnings = [...metadata.warnings];
      if (previous?.downloads.baidu && previous.file.sha256 !== metadata.sha256) warnings.push('新文件不沿用原百度分享链接');
      changes.push({ id: book.id, operation: input.update ? 'update' : 'add', warnings });
      books.push(book);
      await jsonWrite(path.join(site, 'catalog/books', `${input.id}.json`), book);
      onProgress(`已准备 ${books.length}/${inputs.length}：${book.title}`);
    }
    if (await sourceFingerprint(root) !== baseFingerprint) throw new CliError('准备期间工作区发生变化，请重新准备', 3);
    await jsonWrite(path.join(site, 'catalog/preview.json'), { planId: id, bookIds: books.map(book => book.id) });
    buildSite(root, dir);
    const files = await inventory(dir, ['inputs', 'site']);
    const plan: Plan = { schemaVersion: 1, id, status: 'prepared', createdAt: new Date().toISOString(),
      baseFingerprint, reviewHash: '', inventory: files, books, changes };
    plan.reviewHash = sha256(JSON.stringify({ baseFingerprint, inventory: files, books, changes }));
    await jsonWrite(path.join(dir, 'plan.json'), plan);
    await writeFile(path.join(dir, 'report.md'), [
      `# 本地上架预览 ${id}`, '', `审核摘要：${plan.reviewHash}`, '',
      '尚未上传、创建分享或部署。请先预览并确认具体内容。', '',
      ...books.flatMap(book => [`## ${book.title}`, `- ID：${book.id}`, `- 作者：${book.authors.join(' / ')}`,
        `- 版本：${book.edition.kind === 'transcription' ? '中文出版物转录' : book.edition.model}`,
        `- 分类：${book.categories.map(categoryLabel).join('、')}`, `- 标签：${book.subjects.join('、') || '无'}`, `- 文件：${book.file.bytes} bytes / ${book.file.sha256}`,
        `- 警告：${changes.find(change => change.id === book.id)!.warnings.join('；') || '无'}`, '']),
    ].join('\n'), 'utf8');
    return plan;
  } catch (error) {
    await jsonWrite(path.join(dir, 'failure.json'), { status: 'failed', error: (error as Error).message });
    throw error;
  }
}
export async function validatePlan(root:string,plan:Plan) {
  const errors = await inspectPlan(root,plan);
  if (errors.length) throw new CliError(errors.join('；'), 3);
  const dir = planDir(root,plan.id); const site = path.join(dir, 'site');
  for (const book of plan.books) {
    const metadata = await extractEpub(path.join(dir, 'inputs', `${book.id}.epub`));
    if (metadata.sha256 !== book.file.sha256 || metadata.title !== book.title) throw new CliError(`${book.id} 输入与记录不一致`, 4);
    if (book.downloads.r2Url && !book.downloads.r2Url.startsWith('https://')) throw new CliError('下载 URL 必须使用 HTTPS', 4);
    const record = await jsonRead(path.join(site, 'catalog/books', `${book.id}.json`));
    if (JSON.stringify(record) !== JSON.stringify(book)) throw new CliError('书目与计划记录不一致', 4);
  }
  buildSite(root, dir);
  const dist = path.join(site, 'dist');
  const index: { id: string }[] = await jsonRead(path.join(dist, 'search-index.json'));
  for (const book of plan.books) {
    if (!index.some(entry => entry.id === book.id) || !await exists(path.join(dist, 'books', book.id, 'index.html'))) {
      throw new CliError(`${book.id} 缺少页面或索引`, 4);
    }
  }
  async function checkArtifacts(folder: string): Promise<void> {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) await checkArtifacts(file);
      else if (/\.epub$/iu.test(item.name)) throw new CliError('构建产物不应包含 EPUB', 4);
      else if (/\.html$/u.test(item.name)) {
        const html = await readFile(file, 'utf8');
        for (const match of html.matchAll(/(?:href|src)="(\/[^"?#]*)(?:[?#][^"]*)?"/gu)) {
          const target = decodeURIComponent(match[1]);
          if (target.startsWith('//')) continue;
          const relative = target.endsWith('/') ? `${target}index.html` : target;
          if (!(await exists(path.join(dist, relative)))) throw new CliError(`失效的内部链接：${target}`, 4);
        }
      }
    }
  }
  await checkArtifacts(dist);
  const afterBuild = await inspectPlan(root,plan);
  if (afterBuild.length) throw new CliError(`重新构建与审核内容不一致：${afterBuild.join('；')}`, 3);
  return { valid: true, books: plan.books.length, reviewHash: plan.reviewHash };
}
export async function servePreview(root:string,plan:Plan,port:number) {
  const errors = await inspectPlan(root,plan);
  if (errors.length) throw new CliError(errors.join('；'), 3);
  const distRoot = path.join(planDir(root,plan.id), 'site/dist');
  if (!(await exists(path.join(distRoot, 'index.html')))) throw new CliError('预览构建不存在，请运行 validate', 4);
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const relative = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
      const filename = path.resolve(distRoot, '.' + relative);
      if (!filename.startsWith(distRoot + path.sep) || /\.epub$/iu.test(filename)) { response.writeHead(404).end(); return; }
      const bytes = await readFile(filename);
      response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${port}/`;
}

