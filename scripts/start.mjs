import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 20) { console.error('Auto Work 需要 Node.js 20 或更新版本。'); process.exit(1); }
process.env.PATH = path.dirname(process.execPath) + path.delimiter + process.env.PATH;
async function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, stdio: 'inherit', env: process.env });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => child.kill(signal));
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`启动步骤失败（${code}）`)));
  });
}
try {
  const require = createRequire(import.meta.url);
  await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.server.json']);
  await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
  await run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build']);
  const electron = require('electron');
  await run(electron, [root]);
} catch (e) { console.error(String(e)); process.exitCode = 1; }
