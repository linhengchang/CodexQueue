import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, symlink, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runtimeDataRoot, migrateRuntimeData, developmentToolPath } from '../desktop/runtime-data.mjs';
import { Store } from '../dist/server/store.js';
import { Storage } from '../dist/server/storage.js';
import { startServer } from '../dist/server/index.js';

test('packaged data is independent of app location; source mode stays compatible', () => {
  assert.equal(runtimeDataRoot({ packaged: false, resourceRoot: '/source' }), path.resolve('/source'));
  const options = { packaged: true, resourceRoot: '/Applications/Auto Work.app/Contents/Resources/app.asar', appData: '/user/app-data' };
  assert.equal(runtimeDataRoot(options), path.resolve('/user/app-data/Auto Work'));
  assert.equal(runtimeDataRoot({ ...options, resourceRoot: '/other/App.app' }), runtimeDataRoot(options));
  assert.throws(() => runtimeDataRoot({ ...options, override: 'relative' }), /绝对路径/);
  assert.throws(() => runtimeDataRoot({ ...options, override: options.resourceRoot + '/tmp' }), /资源包/);
});
test('legacy data import preserves originals, reports and worktree mapping, pauses schedule, refuses overwrite and symlinks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-work-import-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const target = path.join(root, 'target');
  const store = new Store(source); await store.init();
  store.batches = [{ id: 'batch', status: 'completed', config: store.settings.config, tasks: [{ id: 'task', name: 'test', worktree: '/business/worktree' }] }];
  store.schedule.enabled = true; await store.save();
  await mkdir(path.join(source, 'task/batch/task'), { recursive: true }); await writeFile(path.join(source, 'task/batch/task/events.log'), 'history');
  await mkdir(path.join(source, 'todo/batch/task'), { recursive: true }); await writeFile(path.join(source, 'todo/batch/task/todo-review.md'), 'review');
  await mkdir(path.join(source, 'data/recycle-bin')); await writeFile(path.join(source, 'data/recycle-bin/old'), 'trash');
  await migrateRuntimeData(source, target);
  const imported = JSON.parse(await readFile(path.join(target, 'data/state.json')));
  assert.equal(imported.batches[0].tasks[0].worktree, '/business/worktree'); assert.equal(imported.schedule.enabled, false);
  assert.equal(JSON.parse(await readFile(path.join(source, 'data/state.json'))).schedule.enabled, true);
  assert.equal(await readFile(path.join(target, 'task/batch/task/events.log'), 'utf8'), 'history');
  assert.equal(await readFile(path.join(target, 'todo/batch/task/todo-review.md'), 'utf8'), 'review');
  await assert.rejects(access(path.join(target, 'data/recycle-bin')));
  await assert.rejects(migrateRuntimeData(source, target), /已有数据/);
  await assert.rejects(migrateRuntimeData(source, path.join(source, 'nested')), /互相包含/);
  await symlink('/tmp', path.join(source, 'task/redirect'));
  const rejected = path.join(root, 'rejected'); await assert.rejects(migrateRuntimeData(source, rejected), /符号链接/);
  assert.deepEqual(await readdir(rejected), []);
});
test('separate resources serve UI while uploads and cleanup affect only writable data', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-work-package-')); t.after(() => rm(root, { recursive: true, force: true }));
  const resources = path.join(root, 'app.asar'); const data = path.join(root, 'user-data');
  await mkdir(path.join(resources, 'dist-web'), { recursive: true }); await writeFile(path.join(resources, 'dist-web/index.html'), '<title>Packaged UI</title>');
  const server = await startServer({ resourceRoot: resources, dataRoot: data, port: 0, trash: file => rm(file, { recursive: true }) });
  try {
    assert.match(await (await fetch(server.origin)).text(), /Packaged UI/);
    const storage = new Storage(server.store, file => rm(file, { recursive: true }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFUcAAAAASUVORK5CYII=', 'base64');
    const image = await storage.upload(png, 'test.png');
    assert.equal((await fetch(server.origin + '/api/attachments/' + image.id)).status, 200);
    assert.equal((await storage.summary()).root, data);
    assert.equal((await storage.cleanup({ batchIds: [], unusedImages: true, protectImageIds: [] }, () => false)).removedImages, 1);
    assert.deepEqual(await readdir(resources), ['dist-web']);
    assert.equal(await readFile(path.join(resources, 'dist-web/index.html'), 'utf8'), '<title>Packaged UI</title>');
    await access(path.join(data, 'data/state.json'));
  } finally { await server.close(); }
});

test('Finder tool environment finds modern nvm tools while keeping explicit PATH precedence', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'auto-work-path-')); t.after(() => rm(home, { recursive: true, force: true }));
  for (const version of ['v18.0.0', 'v20.0.0', 'v24.20.0']) await mkdir(path.join(home, '.nvm/versions/node', version), { recursive: true });
  const result = (await developmentToolPath('/custom/bin:/usr/bin:/bin', home)).split(path.delimiter);
  assert.equal(result[0], '/custom/bin');
  assert.ok(result.indexOf(path.join(home, '.nvm/versions/node/v24.20.0/bin')) < result.indexOf(path.join(home, '.nvm/versions/node/v20.0.0/bin')));
  assert.ok(!result.includes(path.join(home, '.nvm/versions/node/v18.0.0/bin')));
});
