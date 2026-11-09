import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIRROR_CLI } from './registry.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = `网盘镜像入口
  npm run mirror -- status|prepare|publish|recover ... --provider baidu
  --provider 默认为 baidu；其余参数原样转发给对应 provider 的 CLI。
  运行 npm run mirror -- --help --provider baidu 查看百度 provider 的完整选项。`;

const argv = process.argv.slice(2);
const rest: string[] = [];
let provider = 'baidu';
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (arg === '--provider') { provider = argv[++index] ?? ''; continue; }
  if (arg.startsWith('--provider=')) { provider = arg.slice('--provider='.length); continue; }
  rest.push(arg);
}

const providerCli = Object.prototype.hasOwnProperty.call(MIRROR_CLI, provider) ? MIRROR_CLI[provider as keyof typeof MIRROR_CLI] : null;
if (!providerCli) {
  console.error(`未知镜像 provider：${provider || '(空)'}；已注册：${Object.keys(MIRROR_CLI).join('、')}`);
  process.exitCode = 1;
} else if (!rest.length) {
  console.log(usage);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, providerCli), ...rest], { stdio: 'inherit' });
  process.exitCode = result.error ? 1 : (result.status ?? 1);
}
