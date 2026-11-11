import type { Batch, Settings, Task } from './types.js';
export function sameTask(a: Task, b: Task) {
  return a.id === b.id && a.name === b.name && a.branch === b.branch && a.rawPrompt === b.rawPrompt && JSON.stringify(a.images || []) === JSON.stringify(b.images || []);
}
export function remainingTasks(current: Task[], executed: Task[]) {
  return current.filter(task => !executed.some(done => sameTask(task, done)));
}
export function restoreHistoryTasks(current: Settings, batch: Pick<Batch, 'status' | 'config'> & { tasks: Task[] }, taskIds: string[], newId: () => string): Settings {
  if (['queued', 'running'].includes(batch.status)) throw new Error('批次尚未结束，请等待执行完成');
  const tasks = batch.tasks.filter(task => taskIds.includes(task.id));
  if (!tasks.length || tasks.length !== new Set(taskIds).size) throw new Error('历史任务不存在');
  if (current.tasks.length && current.config.projectRoot !== batch.config.projectRoot) throw new Error('当前队列属于其他项目，请先处理或清空当前队列，再加入这个项目的历史任务');
  if (current.tasks.length + tasks.length > 50) throw new Error('待执行队列最多保留 50 个任务');
  return { config: structuredClone(current.tasks.length ? current.config : batch.config), tasks: [...current.tasks, ...tasks.map(task => ({ id: newId(), name: task.name, branch: task.branch, rawPrompt: task.rawPrompt, images: [...(task.images || [])] }))] };
}
