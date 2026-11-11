import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { Store } from './store.js';
export async function worktreeDirectory(store: Store, batchId: string, taskId?: string) {
  const batch = store.batches.find(item => item.id === batchId);
  if (!batch) throw new Error('运行记录不存在');
  const root = path.join(path.dirname(batch.config.projectRoot), '.auto-work-worktrees', path.basename(batch.config.projectRoot));
  let directory = root;
  if (taskId) {
    const task = batch.tasks.find(item => item.id === taskId);
    if (!task?.worktree) throw new Error('该任务尚未创建 worktree');
    const expected = path.join(root, batch.id, task.id);
    if (path.resolve(task.worktree) !== expected) throw new Error('任务目录与运行记录不匹配');
    directory = expected;
  }
  try {
    const rootInfo = await lstat(root); const info = await lstat(directory);
    if (rootInfo.isSymbolicLink() || info.isSymbolicLink() || !info.isDirectory()) throw new Error('worktree 目录无效');
    const relative = path.relative(await realpath(root), await realpath(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('目录超出该项目的 worktree 范围');
  } catch (e: any) { if (e.code === 'ENOENT') throw new Error('worktree 目录不存在，可能尚未创建或已被手动清理'); throw e; }
  return directory;
}
