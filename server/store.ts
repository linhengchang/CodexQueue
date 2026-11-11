import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { sameTask } from '../shared/task-queue.js';
import { defaultSettings, type Settings, type Batch, type Attachment, type ScheduleState } from '../shared/types.js';
export class Store {
  settings: Settings = structuredClone(defaultSettings);
  batches: Batch[] = [];
  attachments: Attachment[] = [];
  schedule: ScheduleState = { enabled: false, lastDate: '', lastError: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, snapshot: null };
  private writes = Promise.resolve();
  constructor(public root: string) {}
  async init() {
    await mkdir(path.join(this.root, 'data'), { recursive: true });
    try {
      const raw = await readFile(path.join(this.root, 'data/state.json'), 'utf8');
      const saved = JSON.parse(raw);
      this.settings = saved.settings ?? this.settings; this.batches = saved.batches ?? [];
      this.attachments = saved.attachments ?? [];
      this.schedule = { ...this.schedule, ...saved.schedule };
      if ((saved.version || 1) < 2) {
        await mkdir(path.join(this.root, 'data', 'backups'), { recursive: true });
        await writeFile(path.join(this.root, 'data', 'backups', 'state-before-queue-v2.json'), raw, { flag: 'wx' }).catch((e: any) => { if (e.code !== 'EEXIST') throw e; });
        // Preserve existing daily tasks before migrating the old reusable list to a queue.
        if (this.schedule.enabled && !this.schedule.snapshot) this.schedule.snapshot = structuredClone(this.settings);
        this.settings.tasks = this.settings.tasks.filter(task => !this.schedule.snapshot?.tasks.some(done => sameTask(task, done)) && !this.batches.some(batch => batch.config.projectRoot === this.settings.config.projectRoot && batch.tasks.some(done => sameTask(task, done))));
      }
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('状态文件无法读取，请检查 data/state.json：' + e.message); }
    for (const batch of this.batches) {
      if (batch.status === 'running' || batch.status === 'queued') {
        batch.status = 'interrupted'; batch.endedAt = new Date().toISOString();
        for (const task of batch.tasks) if (task.status === 'running' || task.status === 'queued') { task.status = 'interrupted'; task.error = '上次服务意外退出，修改已保留，请人工检查后重新运行。'; }
      }
    }
    await this.save();
  }
  save() {
    const data = JSON.stringify({ version: 2, settings: this.settings, batches: this.batches, attachments: this.attachments, schedule: this.schedule }, null, 2);
    this.writes = this.writes.then(async () => {
      const target = path.join(this.root, 'data/state.json');
      await writeFile(target + '.tmp', data); await rename(target + '.tmp', target);
    });
    return this.writes;
  }
}
