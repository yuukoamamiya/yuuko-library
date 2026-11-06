import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

type Item = { path: string; kind: string; bytes: number; modifiedAt: string | null; status: 'protected' | 'candidate' | 'unknown'; reason: string };
type Unknown = { path: string; reason: string };
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const ageLimit = 30 * 86400000;

/** Build a read-only inventory. This module intentionally has no apply/delete operation. */
export async function makeCleanupPreview(root: string, request: typeof fetch = fetch) {
  const base = path.resolve(root);
  const objects: Item[] = [];
  const unknown: Unknown[] = [];
  const protectedReleases = new Set<string>();
  const protectedPlans = new Set<string>();
  const uploadReports = new Map<string, { status: string; planId?: string; name: string }>();
  const releaseData = new Map<string, any>();
  const releaseState = new Map<string, any>();
  let onlineRelease: string | null = null;
  let onlinePlan: string | null = null;
  let onlineKnown = false;
  let conservative = false;
  const relative = (p: string) => path.relative(base, p).split(path.sep).join('/');
  const validId = (s: unknown): s is string => typeof s === 'string' && idPattern.test(s);
  const canonical = (p: string) => path.resolve(p.replace(/^\\\\\?\\/u, '')).toLocaleLowerCase('en-US');
  async function safeDirectory(p: string): Promise<boolean> {
    try {
      const info = await lstat(p);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('不是普通目录或为链接');
      const actual = await realpath(p);
      const parent = await realpath(path.dirname(p));
      if (path.basename(actual).toLocaleLowerCase('en-US') !== path.basename(p).toLocaleLowerCase('en-US') || canonical(path.dirname(actual)) !== canonical(parent)) throw new Error('realpath 与预期父目录不一致');
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      unknown.push({ path: relative(p), reason: `目录边界无法验证：${(e as Error).message}` });
      conservative = true;
      return false;
    }
  }
  async function safeReadJson(p: string): Promise<any> {
    const st = await lstat(p);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('元数据不是普通文件');
    const actual = await realpath(p);
    const parent = await realpath(path.dirname(p));
    if (path.basename(actual).toLocaleLowerCase('en-US') !== path.basename(p).toLocaleLowerCase('en-US') || canonical(path.dirname(actual)) !== canonical(parent)) throw new Error('元数据 realpath 越界');
    return JSON.parse(await readFile(p, 'utf8'));
  }
  const local = path.join(base, '.local');
  let localOk = await safeDirectory(local);
  if (!localOk) {
    try { await lstat(local); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') localOk = false; }
    if (unknown.some(x => x.path === '.local')) conservative = true;
  }
  // Check ancestor too: a symlinked workspace root must not authorize traversal outside it.
  let rootOk = true;
  try {
    const rootInfo = await lstat(base);
    await realpath(base);
    if (rootInfo.isSymbolicLink()) throw new Error('根目录是符号链接');
  } catch (e) { unknown.push({ path: '.', reason: `根目录无法验证：${(e as Error).message}` }); conservative = true; rootOk = false; }

  try {
    const cfg = await safeReadJson(path.join(base, 'site.config.json'));
    if (typeof cfg.siteUrl !== 'string') throw new Error('siteUrl 缺失');
    const url = new URL(cfg.siteUrl);
    if (url.protocol !== 'https:') throw new Error('siteUrl 必须使用 HTTPS');
    const response = await request(new URL('release.json', url.href.endsWith('/') ? url : `${url.href}/`), { signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const marker = await response.json() as any;
    if (![1, 2].includes(marker.schemaVersion) || !validId(marker.releaseId)) throw new Error('线上 release marker schema 或 releaseId 未知');
    const currentRelease = marker.releaseId as string;
    onlineRelease = currentRelease;
    if (marker.planId !== undefined && marker.planId !== null) {
      if (!validId(marker.planId)) throw new Error('线上 planId 非法');
      onlinePlan = marker.planId;
    }
    protectedReleases.add(currentRelease);
    if (onlinePlan) protectedPlans.add(onlinePlan);
    onlineKnown = true;
  } catch (e) {
    unknown.push({ path: 'online release.json', reason: `线上状态未知，相关快照全部保守保护：${(e as Error).message}` });
    conservative = true;
  }
  if (!rootOk || !localOk) return { generatedAt: new Date().toISOString(), mode: 'read-only-preview' as const, onlineRelease, onlinePlan,
    retention: '仅列出 .local/plans、.local/releases、.local/uploads；不会修改或删除。旧 EPUB 与 R2 对象不在本地快照范围。候选项仅供人工审核，须另行批准清理。',
    objects, totalBytes: 0, candidateBytes: 0, unknown };

  async function listSafe(dir: string): Promise<string[]> {
    if (!(await safeDirectory(dir))) return [];
    try { return (await readdir(dir)).sort((a, b) => a.localeCompare(b, 'en')); }
    catch (e) { unknown.push({ path: relative(dir), reason: `无法读取目录：${(e as Error).message}` }); conservative = true; return []; }
  }
  const releaseRoot = path.join(local, 'releases');
  for (const name of await listSafe(releaseRoot)) {
    const dir = path.join(releaseRoot, name);
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('release 项不是普通目录');
      const data = await safeReadJson(path.join(dir, 'release.json'));
      if (!validId(data.id) || data.id !== name || ![1, 2].includes(data.schemaVersion)) throw new Error('release ID/schema 未知');
      if (data.planId != null && !validId(data.planId)) throw new Error('planId 非法');
      const state = await safeReadJson(path.join(dir, 'deployment.json'));
      if (!state || typeof state.status !== 'string' || !['prepared', 'ready', 'submitting', 'submitted', 'uncertain', 'published', 'failed'].includes(state.status)) throw new Error('deployment 状态未知');
      releaseData.set(name, data); releaseState.set(name, state);
      if (['submitting', 'submitted', 'uncertain'].includes(state.status)) protectedReleases.add(name);
      if (state.status === 'published' && state.verified !== false) protectedReleases.add(name);
    } catch (e) { unknown.push({ path: relative(dir), reason: `发布元数据/依赖未知，快照保留：${(e as Error).message}` }); conservative = true; }
  }

  // Gather all reports, then close plan -> reports -> referenced plans transitively.
  const uploadRoot = path.join(local, 'uploads');
  for (const name of await listSafe(uploadRoot)) {
    const p = path.join(uploadRoot, name);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('上传项不是普通文件');
      const report = await safeReadJson(p);
      if (report.command === 'remote-inventory' || !['verified', 'running', 'failed', 'uncertain', 'submitting', 'submitted'].includes(report.status)) throw new Error('报告 schema 或状态未知（remote-inventory 不视为已验证）');
      if (report.planId != null && !validId(report.planId)) throw new Error('planId 非法');
      uploadReports.set(name, { status: report.status, planId: report.planId, name });
      if (report.status !== 'verified' && report.planId) protectedPlans.add(report.planId);
    } catch (e) { unknown.push({ path: relative(p), reason: `上传报告未知，保留且不视为 verified：${(e as Error).message}` }); conservative = true; }
  }

  // Read page state only; any unparseable lock/marker makes the whole inventory conservative.
  const pagesRoot = path.join(local, 'pages');
  async function scanPages(dir: string): Promise<void> {
    for (const name of await listSafe(dir)) {
      const p = path.join(dir, name);
      try {
        const st = await lstat(p);
        if (st.isSymbolicLink()) throw new Error('符号链接不跟随');
        if (st.isDirectory()) { await scanPages(p); continue; }
        if (!st.isFile()) continue;
        if (name === 'active.json') {
          const data = await safeReadJson(p);
          const rid = data.releaseId ?? data.activeReleaseId;
          const pid = data.planId;
          if (!validId(rid) || (pid != null && !validId(pid))) throw new Error('active.json ID 缺失或非法');
          protectedReleases.add(rid); if (pid) protectedPlans.add(pid);
        } else if (name.endsWith('.lock')) {
          const data = await safeReadJson(p);
          const rid = data.releaseId ?? data.release;
          const pid = data.planId ?? data.plan;
          if (!validId(rid) && !validId(pid)) throw new Error('锁文件无有效 release/plan ID');
          if (rid) { if (!validId(rid)) throw new Error('锁文件 releaseId 非法'); protectedReleases.add(rid); }
          if (pid) { if (!validId(pid)) throw new Error('锁文件 planId 非法'); protectedPlans.add(pid); }
        }
      } catch (e) { unknown.push({ path: relative(p), reason: `状态无法读取，快照保守保护：${(e as Error).message}` }); conservative = true; }
    }
  }
  if (await safeDirectory(pagesRoot)) await scanPages(pagesRoot);

  const published = [...releaseState.entries()].filter(([, s]) => s.status === 'published' && s.verified !== false)
    .sort((a, b) => Date.parse(b[1].verifiedAt ?? b[1].finishedAt ?? releaseData.get(b[0])?.createdAt ?? '') - Date.parse(a[1].verifiedAt ?? a[1].finishedAt ?? releaseData.get(a[0])?.createdAt ?? ''));
  for (const [id] of published.slice(0, 2)) protectedReleases.add(id);

  const plansRoot = path.join(local, 'plans');
  const plans = new Map<string, any>();
  for (const name of await listSafe(plansRoot)) {
    const p = path.join(plansRoot, name);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('计划项不是普通目录');
      const plan = await safeReadJson(path.join(p, 'plan.json'));
      if (!validId(plan.id) || plan.id !== name || !['prepared', 'published', 'failed', 'ready', 'stale'].includes(plan.status)) throw new Error('计划 ID/状态未知');
      plans.set(name, { plan, stat: st });
      if (plan.status === 'prepared') protectedPlans.add(name);
    } catch (e) { unknown.push({ path: relative(p), reason: `计划状态未知，保留：${(e as Error).message}` }); conservative = true; }
  }
  const referencedPlans = new Set<string>(protectedPlans);
  for (const data of releaseData.values()) if (data.planId) referencedPlans.add(data.planId);
  for (const report of uploadReports.values()) if (report.planId) referencedPlans.add(report.planId);
  for (const id of referencedPlans) {
    if (!plans.has(id)) {
      unknown.push({ path: `.local/plans/${id}`, reason: '发布标记、release 或 upload 引用了缺失计划；相关快照保守保护' });
      conservative = true;
    }
  }
  if (conservative) {
    for (const id of releaseData.keys()) protectedReleases.add(id);
    for (const id of plans.keys()) protectedPlans.add(id);
    for (const item of uploadReports.values()) if (item.planId) protectedPlans.add(item.planId);
  }
  // A retained release retains its plan; a retained plan retains its reports. Iterate to closure.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, data] of releaseData) if (protectedReleases.has(id) && data.planId && !protectedPlans.has(data.planId)) { protectedPlans.add(data.planId); changed = true; }
    for (const report of uploadReports.values()) if (report.planId && protectedPlans.has(report.planId) && report.status !== 'verified') { /* retained below as an object */ }
  }

  const now = Date.now();
  async function byteSize(p: string): Promise<number> {
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new Error('符号链接不跟随');
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    for (const name of await readdir(p)) total += await byteSize(path.join(p, name));
    return total;
  }
  async function latestModification(p: string): Promise<number> {
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new Error('符号链接不跟随');
    if (!st.isDirectory()) return st.mtimeMs;
    let latest = st.mtimeMs;
    for (const name of await readdir(p)) latest = Math.max(latest, await latestModification(path.join(p, name)));
    return latest;
  }
  for (const [id, entry] of plans) {
    const p = path.join(plansRoot, id); const { plan, stat } = entry;
    let latest: number;
    try { latest = await latestModification(p); }
    catch (e) { unknown.push({ path: relative(p), reason: `计划目录含不安全链接，整项保留：${(e as Error).message}` }); objects.push({ path: relative(p), kind: 'plan', bytes: 0, modifiedAt: stat.mtime.toISOString(), status: 'unknown', reason: '目录内链接无法安全计量；人工检查' }); continue; }
    let status: Item['status'] = 'protected'; let reason = '计划状态或依赖无法证明安全';
    if (!onlineKnown) reason = '线上版本未知，保守保护';
    else if (protectedPlans.has(id)) reason = plan.status === 'prepared' ? 'prepared 计划保留' : '发布/上传依赖闭包保留';
    else if (now - Math.max(stat.mtimeMs, Date.parse(plan.createdAt) || 0, latest) < ageLimit) reason = '计划新近 30 天内，保留';
    else { status = 'candidate'; reason = '超过 30 天且未发现依赖；需人工批准后另行清理'; }
    try { objects.push({ path: relative(p), kind: 'plan', bytes: await byteSize(p), modifiedAt: stat.mtime.toISOString(), status, reason }); }
    catch (e) { unknown.push({ path: relative(p), reason: `大小无法安全计算：${(e as Error).message}` }); }
  }
  for (const id of [...new Set([...releaseData.keys(), ...unknown.filter(x => x.path.startsWith('.local/releases/')).map(x => path.basename(x.path))])].sort()) {
    const p = path.join(releaseRoot, id);
    try {
      const st = await lstat(p); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('release 项不是普通目录');
      let latest: number;
      try { latest = await latestModification(p); }
      catch (e) { unknown.push({ path: relative(p), reason: `发布目录含不安全链接，整项保留：${(e as Error).message}` }); objects.push({ path: relative(p), kind: 'release', bytes: 0, modifiedAt: st.mtime.toISOString(), status: 'unknown', reason: '目录内链接无法安全计量；人工检查' }); continue; }
      let status: Item['status'] = 'protected'; let reason = '发布状态/依赖未知，保留';
      const state = releaseState.get(id); const data = releaseData.get(id);
      if (!onlineKnown || conservative) reason = '线上或依赖扫描不完整，保守保护';
      else if (protectedReleases.has(id)) reason = id === onlineRelease ? '当前线上版本' : state?.status === 'published' ? '最近成功发布或依赖闭包保留' : 'active/lock/未完成发布保留';
      else if (!data || !state) { status = 'unknown'; reason = '元数据未知，保留'; }
      else if (now - Math.max(st.mtimeMs, Date.parse(data.createdAt) || 0, latest) < ageLimit) reason = '快照新近 30 天内，保留';
      else if (data.planId && protectedPlans.has(data.planId)) reason = `依赖保留计划 ${data.planId}`;
      else if (state.status === 'ready' || state.status === 'failed' || state.status === 'prepared') { status = 'candidate'; reason = '旧的未发布终态快照且无依赖；需人工批准后另行清理'; }
      else reason = '状态不满足候选条件，保留';
      objects.push({ path: relative(p), kind: 'release', bytes: await byteSize(p), modifiedAt: st.mtime.toISOString(), status, reason });
    } catch (e) { if (!unknown.some(x => x.path === relative(p))) unknown.push({ path: relative(p), reason: `无法安全检查：${(e as Error).message}` }); }
  }
  for (const name of await listSafe(uploadRoot)) {
    const p = path.join(uploadRoot, name);
    try {
      const st = await lstat(p); if (st.isSymbolicLink() || !st.isFile()) throw new Error('上传项不是普通文件');
      const report = uploadReports.get(name);
      const status: Item['status'] = 'protected';
      const reason = !report ? '未知/remote-inventory 报告保留' : report.status !== 'verified' ? '未完成或失败报告保留' : report.planId && protectedPlans.has(report.planId) ? '计划依赖闭包中的报告保留' : 'verified 上传报告作为审计资料保留';
      objects.push({ path: relative(p), kind: 'upload', bytes: st.size, modifiedAt: st.mtime.toISOString(), status, reason });
    } catch (e) { unknown.push({ path: relative(p), reason: `上传项无法安全检查：${(e as Error).message}` }); }
  }
  // Surface unknown snapshot entries as inventory rows too; retain their lstat size where available.
  for (const item of unknown) {
    if (!/^\.local\/(?:plans|releases|uploads)(?:\/|$)/u.test(item.path) || objects.some(o => o.path === item.path)) continue;
    const p = path.resolve(base, ...item.path.split('/'));
    try {
      const st = await lstat(p);
      const kind = item.path.startsWith('.local/plans/') ? 'plan' : item.path.startsWith('.local/releases/') ? 'release' : 'upload';
      let bytes = st.isSymbolicLink() ? st.size : 0;
      if (!st.isSymbolicLink()) { try { bytes = await byteSize(p); } catch { bytes = st.size; } }
      objects.push({ path: item.path, kind, bytes, modifiedAt: st.mtime.toISOString(), status: 'unknown', reason: item.reason });
    } catch { objects.push({ path: item.path, kind: item.path.includes('/plans/') ? 'plan' : item.path.includes('/releases/') ? 'release' : 'upload', bytes: 0, modifiedAt: null, status: 'unknown', reason: item.reason }); }
  }
  objects.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  unknown.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { generatedAt: new Date().toISOString(), mode: 'read-only-preview' as const, onlineRelease, onlinePlan,
    retention: '仅列出 .local/plans、.local/releases、.local/uploads；不会修改或删除。旧 EPUB 与 R2 对象不在本地快照范围。候选项仅供人工审核，须另行批准清理。',
    objects, totalBytes: objects.reduce((n, x) => n + x.bytes, 0), candidateBytes: objects.filter(x => x.status === 'candidate').reduce((n, x) => n + x.bytes, 0), unknown };
}
