import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Input, type Plan, planDir, readPlan, readPlanStatus } from './plan.ts';
import { prepareBooks, validatePlan, servePreview } from './workflow.ts';
import { CliError } from './errors.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const jsonRead = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const HELP = `本地上架工具（尚未实现云发布）
  prepare --id ID --epub FILE --model MODEL [--category ID] [--update]
  prepare --id ID --epub FILE --kind transcription [--category ID]
  prepare --manifest FILE  # JSON 数组；批量准备为一个审核计划
  preview --plan PLAN [--port 4321]
  validate --plan PLAN
  status --plan PLAN
  新增书籍必须指定 --category 分类ID，可重复一次；更新未指定时保留原分类。
  分类ID：philosophy / politics-society / political-economy / history / culture-media / language-translation。
  所有命令可附加 --json；只有本地文件操作，不上传或部署。`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    id: { type: 'string' }, epub: { type: 'string' }, model: { type: 'string' }, kind: { type: 'string' },
    update: { type: 'boolean' }, manifest: { type: 'string' }, plan: { type: 'string' },
    port: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    category: { type: 'string', multiple: true },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  if (positionals.length !== 1) throw new CliError('只允许一个子命令');
  let data: unknown; let plan: Plan | undefined; let status = 'ok';
  let outputPlanId: string | null = null;
  let outputWarnings: string[] = [];
  if (command === 'prepare') {
    if (values.plan || values.port) throw new CliError('prepare 不接受 plan 或 port 参数');
    if (values.manifest && [values.id, values.epub, values.model, values.kind, values.update, values.category].some(value => value !== undefined)) {
      throw new CliError('manifest 不能与单书参数混用');
    }
    const inputs: Input[] = values.manifest ? await jsonRead(path.resolve(values.manifest)) : [{
      id: values.id!, epub: values.epub!, model: values.model, kind: values.kind as Input['kind'],
      update: values.update,
      categories: values.category,
    }];
    if (!Array.isArray(inputs)) throw new CliError('manifest 必须为 JSON 数组');
    plan = await prepareBooks(ROOT,inputs); status = 'prepared';
    outputPlanId = plan.id;
    data = { planId: plan.id, count: plan.books.length, reviewHash: plan.reviewHash,
      report: path.join(planDir(ROOT,plan.id), 'report.md'), changes: plan.changes };
  } else if (['preview', 'validate', 'status'].includes(command)) {
    if (!values.plan) throw new CliError('需要 --plan');
    if ([values.id, values.epub, values.model, values.kind, values.update, values.manifest, values.category].some(value => value !== undefined)) {
      throw new CliError('本命令不接受修改书籍的参数');
    }
    if (command === 'status') {
      const result = await readPlanStatus(ROOT, values.plan);
      if (result.kind === 'legacy-stale') {
        outputPlanId = result.id;
        outputWarnings = result.changes.flatMap(change => change.warnings.map(warning => `${change.id}: ${warning}`));
        status = 'stale';
        data = { planId: result.id, books: result.bookCount, blockers: [result.reason], changes: result.changes, remoteWrites: false };
        process.exitCode = 3;
      } else {
        plan = result.plan;
        outputPlanId = plan.id;
        outputWarnings = plan.changes.flatMap(change => change.warnings.map(warning => `${change.id}: ${warning}`));
        status = result.blockers.length ? 'stale' : 'prepared';
        data = { planId: plan.id, books: plan.books.length, blockers: result.blockers, changes: plan.changes, remoteWrites: false };
        if (result.blockers.length) process.exitCode = 3;
      }
    } else {
      plan = await readPlan(ROOT, values.plan);
      outputPlanId = plan.id;
      outputWarnings = plan.changes.flatMap(change => change.warnings.map(warning => `${change.id}: ${warning}`));
      if (command === 'preview') {
        const port = Number(values.port ?? 4321);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CliError('port 必须在 1024–65535 之间');
        data = { url: await servePreview(ROOT, plan, port), books: plan.books.length, planId: plan.id };
        status = 'previewing';
      } else {
        data = await validatePlan(ROOT, plan);
        status = 'valid';
      }
    }
  } else throw new CliError(`尚未实现的命令：${command}。运行 --help 查看可用命令`);
  if (values.json) console.log(JSON.stringify({ schemaVersion: 1, command, planId: outputPlanId ?? plan!.id, status, data,
    warnings: outputWarnings, error: null }));
  else console.log(JSON.stringify({ status, ...data as object }, null, 2));
}
main().catch(error => {
  const code = error instanceof CliError ? error.exitCode : 4;
  const message = (error as Error).message;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, command: process.argv[2],
    planId: null, status: 'failed', data: null, warnings: [], error: { code, message } }));
  else process.stderr.write(`错误：${message}\n`);
  process.exitCode = code;
});
