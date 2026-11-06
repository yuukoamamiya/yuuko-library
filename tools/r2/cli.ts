import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { executeR2, safeMessage } from './workflow.ts';
import { TransferError } from './transfer.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true,
    options: { plan: { type: 'string' }, book: { type: 'string' }, help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('R2 工具：\n  check\n  upload --plan PLAN [--book ID]\n  verify --plan PLAN [--book ID]\n上传先验证首本再启动整批；verify 只读；不会部署网站。');
    return;
  }
  if (positionals.length !== 1 || !['check', 'upload', 'verify'].includes(command)) throw new TransferError('命令无效；运行 --help 查看帮助');
  if (command === 'check' && (values.plan || values.book)) throw new TransferError('check 不接受 plan 或 book 参数');
  const result = await executeR2(root, command, values.plan, values.book, message => process.stderr.write(message + '\n'));
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exitCode = 5;
}
main().catch(error => {
  // Never print SDK errors, signed requests, credential objects or server XML.
  console.error(JSON.stringify({ status: 'failed', message: safeMessage(error) }));
  process.exitCode = 5;
});
