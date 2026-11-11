import path from 'node:path';
import os from 'node:os';
import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

type Environment = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; applicationRoots?: string[]; commonDirectories?: string[] };
// Finder does not inherit interactive-shell PATH additions. Resolve an executable,
// never a shell alias, without loading shell startup scripts or credential files.
export async function findCodex(requested = 'codex', options: Environment = {}): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  const candidates: string[] = [];
  const addDirectory = (directory: string) => { for (const name of names) candidates.push(path.join(directory, name)); };
  const explicit = requested !== 'codex';
  if (explicit) candidates.push(path.resolve(requested));
  else {
    for (const directory of (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) addDirectory(directory);
    for (const directory of options.commonDirectories ?? [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) addDirectory(directory);
    if (platform === 'win32' && env.APPDATA) addDirectory(path.join(env.APPDATA, 'npm'));
    const nvm = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
    try {
      const versions = (await readdir(nvm)).filter(name => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) addDirectory(path.join(nvm, version, 'bin'));
    } catch {}
    if (platform === 'darwin') {
      for (const directory of options.applicationRoots ?? ['/Applications', path.join(home, 'Applications')]) {
        for (const app of ['ChatGPT.app', 'Codex.app']) {
          candidates.push(path.join(directory, app, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'));
          candidates.push(path.join(directory, app, 'Contents', 'Resources', 'codex'));
        }
      }
    }
  }
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error(explicit ? '配置的 Codex 路径不存在或不可执行，请检查 AUTO_WORK_CODEX' : '未找到 Codex CLI。请检查安装路径，或通过 AUTO_WORK_CODEX 指定可执行文件的完整路径');
}
