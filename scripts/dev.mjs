import { spawn } from 'node:child_process';
import path from 'node:path';
process.env.PATH = path.dirname(process.execPath) + path.delimiter + process.env.PATH;
const build = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'], { stdio: 'inherit' });
build.on('exit', code => {
  if (code) return process.exit(code);
  const children = [spawn(process.execPath, ['dist/server/index.js'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })];
  const close = () => { for (const child of children) child.kill(); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, close);
  for (const child of children) child.once('exit', close);
});
