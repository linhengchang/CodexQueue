import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/server/store.js';
import { Storage } from '../dist/server/storage.js';
import { startServer } from '../dist/server/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFUcAAAAASUVORK5CYII=', 'base64');
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'auto-work-storage-')); const store = new Store(root); await store.init(); return { root, store, storage: new Storage(store) }; }
test('images deduplicate and referenced, draft-protected images cannot be cleaned', async () => {
  const { store, storage } = await fixture(); const image = await storage.upload(png, '../../设计图.png');
  assert.equal((await storage.upload(png, 'copy.png')).id, image.id); assert.equal(store.attachments.length, 1);
  assert.equal(image.name, '设计图.png');
  await assert.rejects(storage.upload(Buffer.from('<svg/>'), 'fake.png'), /仅支持/);
  store.settings.tasks = [{ id: randomUUID(), name: 't', branch: 'ai/t', rawPrompt: 'p', images: [image.id] }];
  const input = { batchIds: [], unusedImages: true, protectImageIds: [] };
  assert.equal((await storage.cleanup(input, () => false)).removedImages, 0);
  store.settings.tasks = [];
  assert.equal((await storage.cleanup({ ...input, protectImageIds: [image.id] }, () => false)).removedImages, 0);
  assert.equal((await storage.summary()).imageBytes, png.length);
  assert.equal((await storage.cleanup(input, () => false)).removedImages, 1);
  assert.equal((await storage.summary()).imageBytes, 0); assert.equal(store.attachments.length, 0);
});
test('history cleanup moves artifacts but keeps worktree code and its directory manifest', async () => {
  const { root, store, storage } = await fixture(); const id = randomUUID(); const taskId = randomUUID();
  const external = await mkdtemp(path.join(os.tmpdir(), 'auto-work-kept-code-')); await writeFile(path.join(external, 'important.ts'), 'user code');
  const plan = path.join(root, 'task', id, taskId); const todo = path.join(root, 'todo', id, taskId);
  await mkdir(path.join(plan, 'screenshots'), { recursive: true }); await mkdir(todo, { recursive: true });
  await writeFile(path.join(plan, 'screenshots', 'check.png'), png); await writeFile(path.join(plan, 'events.log'), 'log'); await writeFile(path.join(todo, 'todo-review.md'), 'review');
  const image = await storage.upload(png, 'design.png');
  store.batches = [{ id, status: 'completed', createdAt: new Date().toISOString(), config: store.settings.config, baseCommit: 'sha', tasks: [{ id: taskId, name: 't', images: [image.id], worktree: external, actualBranch: 'ai/t', status: 'completed' }] }];
  assert.equal((await storage.cleanup({ batchIds: [], unusedImages: true, protectImageIds: [] }, () => false)).removedImages, 0);
  assert.equal((await storage.summary()).screenshotBytes, png.length);
  const result = await storage.cleanup({ batchIds: [id], unusedImages: true, protectImageIds: [] }, () => false);
  assert.equal(result.removedBatches, 1); assert.equal(result.removedImages, 1); assert.equal(store.batches.length, 0);
  assert.equal(await readFile(path.join(external, 'important.ts'), 'utf8'), 'user code');
  const manifest = JSON.parse(await readFile(path.join(root, 'data/worktree-records', id + '.json'), 'utf8')); assert.equal(manifest.tasks[0].worktree, external);
  await assert.rejects(access(plan)); await access(path.join(root, 'data/recycle-bin'));
});
test('active work and symlink redirections are rejected by cleanup', async () => {
  const { root, store, storage } = await fixture();
  await assert.rejects(storage.cleanup({ batchIds: [], unusedImages: true, protectImageIds: [] }, () => true), /任务正在运行/);
  const id = randomUUID(); const external = await mkdtemp(path.join(os.tmpdir(), 'auto-work-link-target-')); await writeFile(path.join(external, 'keep.txt'), 'keep');
  await mkdir(path.join(root, 'task')); await symlink(external, path.join(root, 'task', id));
  store.batches = [{ id, status: 'completed', tasks: [], config: store.settings.config }];
  await assert.rejects(storage.cleanup({ batchIds: [id], unusedImages: false, protectImageIds: [] }, () => false), /符号链接/);
  assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep'); assert.equal(store.batches.length, 1);
});
test('binary upload HTTP API validates, serves images and requires auth for cleanup', async () => {
  const { root } = await fixture(); const server = await startServer({ root, port: 0 });
  try {
    const { token } = await (await fetch(server.origin + '/api/status')).json();
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Auto-Work-Token': token, 'X-File-Name': encodeURIComponent('设计图.png') };
    const upload = await fetch(server.origin + '/api/attachments', { method: 'POST', headers, body: png }); assert.equal(upload.status, 200); const image = await upload.json();
    const response = await fetch(server.origin + '/api/attachments/' + image.id); assert.equal(response.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal((await fetch(server.origin + '/api/attachments', { method: 'POST', headers, body: '<svg/>' })).status, 400);
    assert.equal((await fetch(server.origin + '/api/storage/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const cleanup = await fetch(server.origin + '/api/storage/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auto-Work-Token': token }, body: JSON.stringify({ batchIds: [], unusedImages: true }) }); assert.equal(cleanup.status, 200);
    assert.equal((await (await fetch(server.origin + '/api/storage')).json()).imageCount, 0);
  } finally { await server.close(); }
});
