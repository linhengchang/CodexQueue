import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import schedule from 'node-schedule';
import type { Server } from 'node:http';
import { Store } from './store.js';
import { Engine, settingsSchema } from './engine.js';
import { stopAll } from './process.js';
import { Storage, MAX_IMAGE_BYTES } from './storage.js';
import { z } from 'zod';
import { worktreeDirectory } from './worktree-directory.js';

export async function startServer(options: { root?: string; resourceRoot?: string; dataRoot?: string; port?: number; codex?: string; trash?: (file: string) => Promise<void> } = {}) {
  const root = options.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const resourceRoot = options.resourceRoot || root;
  const store = new Store(options.dataRoot || root); await store.init(); const engine = new Engine(store, options.codex);
  const storage = new Storage(store, options.trash);
  const token = randomBytes(24).toString('hex');
  const app = express(); app.disable('x-powered-by');
  const streams = new Set<express.Response>();
  let server: Server; let origin = ''; let closed = false; let timer: schedule.Job | null = null;
  const status = () => ({ settings: store.settings, batches: store.batches, schedule: { ...store.schedule, nextRun: timer?.nextInvocation()?.toISOString() ?? null }, activeBatch: engine.activeBatch, platform: process.platform, token });
  const event = (name: string, payload: unknown) => { for (const stream of streams) stream.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`); };
  engine.on('change', () => event('state', status())); engine.on('log', data => event('log', data));
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== 'http://127.0.0.1:5173')) return res.status(403).json({ error: '只允许本地面板访问' });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-auto-work-token'] !== token) return res.status(403).json({ error: '面板会话已更新，请刷新页面' });
    if (!['GET', 'HEAD'].includes(req.method) && storage.busy) return res.status(409).json({ error: '正在清理存储，请稍后重试' });
    next();
  });
  app.use(express.json({ limit: '6mb' }));
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => (req: express.Request, res: express.Response, next: express.NextFunction) => { void fn(req, res).catch(next); };
  app.post('/api/attachments', express.raw({ type: 'application/octet-stream', limit: MAX_IMAGE_BYTES }), route(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new Error('请上传图片文件');
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'image.png'));
    res.json(await storage.upload(req.body, name));
  }));
  app.get('/api/attachments/:id', route(async (req, res) => {
    const file = (await storage.imagePaths([req.params.id]))[0];
    const image = store.attachments.find(i => i.id === req.params.id)!;
    res.type(image.mime).send(await readFile(file));
  }));
  app.get('/api/storage', route(async (_req, res) => res.json(await storage.summary())));
  app.post('/api/storage/cleanup', route(async (req, res) => {
    const input = z.object({ batchIds: z.array(z.string().uuid()).max(500), unusedImages: z.boolean(), protectImageIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000).default([]) }).parse(req.body);
    const result = await storage.cleanup(input, () => Boolean(engine.activeBatch || engine.starting)); engine.changed(); res.json(result);
  }));
  app.get('/api/status', (_req, res) => res.json(status()));
  app.get('/api/auth', route(async (_req, res) => res.json(await engine.auth())));
  app.get('/api/project', route(async (req, res) => res.json(await engine.project(String(req.query.root || ''), String(req.query.baseRef || 'HEAD')))));
  app.put('/api/settings', route(async (req, res) => { store.settings = settingsSchema.parse(req.body); await store.save(); register(); engine.changed(); res.json({ ok: true }); }));
  app.post('/api/run-now', route(async (req, res) => { const settings = settingsSchema.parse(req.body); const batch = await engine.start(settings); register(); res.status(202).json({ id: batch.id }); }));
  app.get('/api/batches/:id/directory', route(async (req, res) => res.json({ path: await worktreeDirectory(store, req.params.id, req.query.taskId ? String(req.query.taskId) : undefined) })));
  app.post('/api/batches/:id/cancel', route(async (req, res) => { await engine.cancel(req.params.id); res.json({ ok: true }); }));
  const scheduleTick = async () => {
    const date = new Date(); const today = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (store.schedule.lastDate === today) return;
    // A missed run is recorded rather than silently overlapping a previous batch.
    store.schedule.lastDate = today; store.schedule.lastError = ''; await store.save();
    try { if (storage.busy) throw new Error('正在清理存储，已跳过本次定时'); if (!store.schedule.snapshot) throw new Error('请重新设置每日定时任务'); await engine.start(structuredClone(store.schedule.snapshot), 'schedule'); }
    catch (e) { store.schedule.lastError = (e as Error).message; await store.save(); engine.changed(); }
  };
  const register = () => {
    timer?.cancel(); timer = null;
    if (store.schedule.enabled) {
      const [hour, minute] = (store.schedule.snapshot?.config.scheduleTime || store.settings.config.scheduleTime).split(':').map(Number);
      timer = schedule.scheduleJob({ hour, minute, tz: store.schedule.timezone }, () => { void scheduleTick().catch(e => { store.schedule.lastError = String(e); engine.changed(); }); });
    }
  };
  app.post('/api/schedule', route(async (req, res) => { const settings = settingsSchema.parse(req.body); if (!settings.tasks.length) throw new Error('请先新增任务'); store.settings = { config: structuredClone(settings.config), tasks: [] }; store.schedule.enabled = true; store.schedule.snapshot = structuredClone(settings); store.schedule.lastError = ''; await store.save(); register(); engine.changed(); res.json({ ok: true }); }));
  app.delete('/api/schedule', route(async (_req, res) => { store.schedule.enabled = false; store.schedule.snapshot = null; await store.save(); register(); engine.changed(); res.json({ ok: true }); }));
  app.get('/api/events', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n'); streams.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    res.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
  });
  app.get('/api/artifact/:batch/:task/:kind', route(async (req, res) => {
    const batch = store.batches.find(b => b.id === req.params.batch); const task = batch?.tasks.find(t => t.id === req.params.task);
    if (!batch || !task) return res.status(404).json({ error: '任务不存在' });
    const files: Record<string, string> = { plan: path.join(engine.dirs(batch, task).plan, 'plan.md'), review: path.join(engine.dirs(batch, task).todo, 'todo-review.md'), log: path.join(engine.dirs(batch, task).plan, 'events.log'), error: path.join(engine.dirs(batch, task).plan, 'error.log') };
    const file = files[req.params.kind]; if (!file) return res.status(404).json({ error: '文件不存在' });
    try {
      const info = await stat(file); const content = await readFile(file, 'utf8'); res.json({ content: content.slice(-200_000), path: file, truncated: info.size > 200_000 });
    } catch (e: any) { if (e.code === 'ENOENT') res.json({ content: '尚未生成', path: file }); else throw e; }
  }));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(express.static(path.join(resourceRoot, 'dist-web'), { setHeaders: res => res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'") }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: err.issues?.map((i: any) => i.message).join('；') || err.message || '操作失败' }); });
  await new Promise<void>((resolve, reject) => { server = app.listen(options.port ?? Number(process.env.PORT || 3080), '127.0.0.1', resolve); server.once('error', reject); });
  const address = server!.address(); origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 3080}`; register();
  async function close() {
    if (closed) return; closed = true; timer?.cancel();
    await engine.close(); stopAll(); for (const stream of streams) stream.end();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return { origin, close, engine, store, scheduleTick };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await startServer(); console.log(`Auto Work: ${instance.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { void instance.close().then(() => process.exit(0)); });
}
