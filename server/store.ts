import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { defaultSettings, type Settings, type Batch, type Attachment } from '../shared/types.js';
export class Store {
  settings: Settings = structuredClone(defaultSettings);
  batches: Batch[] = [];
  attachments: Attachment[] = [];
  schedule = { enabled: false, lastDate: '', lastError: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  private writes = Promise.resolve();
  constructor(public root: string) {}
  async init() {
    await mkdir(path.join(this.root, 'data'), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(path.join(this.root, 'data/state.json'), 'utf8'));
      this.settings = saved.settings ?? this.settings; this.batches = saved.batches ?? [];
      this.attachments = saved.attachments ?? [];
      this.schedule = { ...this.schedule, ...saved.schedule };
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
    const data = JSON.stringify({ settings: this.settings, batches: this.batches, attachments: this.attachments, schedule: this.schedule }, null, 2);
    this.writes = this.writes.then(async () => {
      const target = path.join(this.root, 'data/state.json');
      await writeFile(target + '.tmp', data); await rename(target + '.tmp', target);
    });
    return this.writes;
  }
}
