import path from 'node:path';
import { mkdir, lstat, realpath, readdir, readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
export function runtimeDataRoot({ packaged, resourceRoot, appData, override }) {
  if (override && !path.isAbsolute(override)) throw new Error('AUTO_WORK_DATA_ROOT 必须是绝对路径');
  const result = path.resolve(override || (packaged ? path.join(appData, 'Auto Work') : resourceRoot));
  if (packaged && inside(path.resolve(resourceRoot), result)) throw new Error('数据目录不能位于 App 资源包中');
  return result;
}
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function copyTree(source, target, top = '') {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('旧数据包含符号链接，已停止导入：' + source);
  if (info.isDirectory()) {
    await mkdir(target);
    for (const entry of await readdir(source)) {
      // Old trash is deliberately excluded; only managed data is imported.
      if (top === 'data' && entry === 'recycle-bin') continue;
      await copyTree(path.join(source, entry), path.join(target, entry), '');
    }
  } else if (info.isFile()) await copyFile(source, target);
  else throw new Error('旧数据包含不支持的文件：' + source);
}
// Offline, copy-only import into an unused destination. Publish state last; never overwrite data.
export async function migrateRuntimeData(sourceRoot, targetRoot) {
  const source = await realpath(sourceRoot);
  await mkdir(targetRoot, { recursive: true });
  const target = await realpath(targetRoot);
  if (inside(source, target) || inside(target, source)) throw new Error('旧目录和新数据目录不能相同或互相包含');
  const categories = ['task', 'todo', 'data'];
  for (const category of categories) if (await exists(path.join(target, category))) throw new Error('目标目录已有数据，不能覆盖导入');
  // Check the state path itself before opening it (including the data directory).
  for (const file of [path.join(source, 'data'), path.join(source, 'data/state.json')]) if ((await lstat(file)).isSymbolicLink()) throw new Error('旧数据包含符号链接');
  const state = JSON.parse(await readFile(path.join(source, 'data/state.json'), 'utf8'));
  if (![1, 2].includes(state.version || 1) || !state.settings?.config || !Array.isArray(state.settings.tasks) || !Array.isArray(state.batches) || (state.attachments && !Array.isArray(state.attachments))) throw new Error('旧版状态文件格式无效');
  // Prevent an imported schedule from starting before the user checks paths and tools.
  if (state.schedule) state.schedule.enabled = false;
  const staging = path.join(target, '.import-' + randomUUID());
  const published = [];
  await mkdir(staging);
  try {
    for (const category of categories) if (await exists(path.join(source, category))) await copyTree(path.join(source, category), path.join(staging, category), category);
    await writeFile(path.join(staging, 'data/state.json'), JSON.stringify(state, null, 2));
    for (const category of categories) {
      if (await exists(path.join(target, category))) throw new Error('目标目录已有数据，不能覆盖导入');
      if (await exists(path.join(staging, category))) { await rename(path.join(staging, category), path.join(target, category)); published.push(category); }
    }
  } catch (error) {
    for (const category of published.reverse()) await rename(path.join(target, category), path.join(staging, category));
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
  return target;
}

// Finder does not inherit interactive shell setup. Expose installed tool directories
// without sourcing shell profiles or changing the user's selected PATH priority.
export async function developmentToolPath(currentPath, home) {
  const nvm = path.join(home, '.nvm/versions/node');
  let versions = [];
  try { versions = (await readdir(nvm)).filter(v => /^v\d+\.\d+\.\d+$/.test(v) && Number(v.slice(1).split('.')[0]) >= 20).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return [...new Set([...(currentPath || '').split(path.delimiter).filter(Boolean), ...versions.map(v => path.join(nvm, v, 'bin')), path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), path.join(home, 'Library/pnpm'), path.join(home, '.local/share/pnpm'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter);
}
