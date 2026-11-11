import type { Batch, TaskRun } from './types.js';
export type HistoryFilters = { title: string; startDate: string; endDate: string; page: number; pageSize: number };
export type HistoryGroup = { batch: Batch; tasks: TaskRun[]; matchedTasks: number };
function dayBoundary(value: string, end: boolean): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('请选择有效日期');
  const [year, month, day] = match.slice(1).map(Number);
  const local = new Date(0);
  local.setFullYear(year, month - 1, day); local.setHours(0, 0, 0, 0);
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) throw new Error('请选择有效日期');
  if (end) local.setDate(local.getDate() + 1);
  return local.getTime();
}
export function taskStartTime(task: TaskRun): number | null {
  if (!task.startedAt) return null;
  const value = Date.parse(task.startedAt);
  return Number.isFinite(value) ? value : null;
}
// Filter and paginate task instances, not batches: a large batch cannot bypass the page limit.
export function queryHistory(batches: Batch[], filters: HistoryFilters) {
  const pageSize = [10, 20, 50].includes(filters.pageSize) ? filters.pageSize : 10;
  let start: number | undefined, end: number | undefined, error = '';
  try {
    start = dayBoundary(filters.startDate, false); end = dayBoundary(filters.endDate, true);
    if (start !== undefined && end !== undefined && start >= end) throw new Error('开始日期不能晚于结束日期');
  } catch (e) { error = (e as Error).message; }
  const title = filters.title.trim().toLocaleLowerCase();
  const rows = error ? [] : batches.flatMap(batch => batch.tasks.map(task => ({batch, task, start: taskStartTime(task)}))).filter(row => {
    if (title && !row.task.name.toLocaleLowerCase().includes(title)) return false;
    if (start !== undefined || end !== undefined) {
      if (row.start === null) return false;
      if (start !== undefined && row.start < start) return false;
      if (end !== undefined && row.start >= end) return false;
    }
    return true;
  }).sort((a, b) => {
    if (a.start === null && b.start !== null) return 1;
    if (a.start !== null && b.start === null) return -1;
    if (a.start !== null && b.start !== null && a.start !== b.start) return b.start - a.start;
    return (Date.parse(b.batch.createdAt) || 0) - (Date.parse(a.batch.createdAt) || 0) || a.batch.id.localeCompare(b.batch.id) || a.task.id.localeCompare(b.task.id);
  });
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(Number.isFinite(filters.page) ? filters.page : 1)));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.batch.id, (counts.get(row.batch.id) || 0) + 1);
  const groups: HistoryGroup[] = [];
  for (const row of rows.slice((page - 1) * pageSize, page * pageSize)) {
    let group = groups.find(group => group.batch.id === row.batch.id);
    if (!group) { group = {batch: row.batch, tasks: [], matchedTasks: counts.get(row.batch.id)!}; groups.push(group); }
    group.tasks.push(row.task);
  }
  return { groups, total, matchingBatches: counts.size, page, pageSize, pages, error };
}
