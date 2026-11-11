import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/server/store.js';
import { Engine } from '../dist/server/engine.js';
import { command } from '../dist/server/process.js';
import { startServer } from '../dist/server/index.js';
import { defaultSettings } from '../dist/shared/types.js';
import { Storage } from '../dist/server/storage.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-work-test-')); const repo = path.join(root, 'business project'); const panel = path.join(root, 'panel');
  await mkdir(repo); await mkdir(panel);
  await command('git', ['init', repo]);
  await command('git', ['-C', repo, 'config', 'user.email', 'test@local.invalid']);
  await command('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'original.txt'), 'original\n');
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  await command('git', ['-C', repo, 'add', '.']); await command('git', ['-C', repo, 'commit', '-m', 'initial']);
  // Both staged and unstaged user changes must survive task execution untouched.
  await writeFile(path.join(repo, 'original.txt'), 'user staged\n'); await command('git', ['-C', repo, 'add', 'original.txt']);
  await writeFile(path.join(repo, 'original.txt'), 'user unstaged\n');
  const fake = path.join(root, 'fake-codex');
  await writeFile(fake, `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version')){ console.log('codex-cli test'); process.exit(0); }
if(args.includes('--help')){ console.log('--sandbox --json --output-schema --image --ephemeral'); process.exit(0); }
if(args.includes('login')){ console.log('Logged in using ChatGPT'); process.exit(0); }
let input='';for await(const c of process.stdin) input+=c;
const out=args[args.indexOf('-o')+1];const coding=args.includes('--output-schema');
fs.appendFileSync('codex-args.jsonl',JSON.stringify(args)+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'test-'+Date.now()}));
if(coding&&input.includes('SLOW_TASK')) await new Promise(r=>setTimeout(r,30000));
if(coding&&input.includes('FAIL_TASK')){ console.error('simulated coding failure'); process.exit(1); }
if(coding){fs.writeFileSync('generated.txt','implemented'); fs.writeFileSync(out,JSON.stringify({status:input.includes('BLOCK_TASK')?'blocked':'completed',summary:'done',decisions:['reuse existing pattern'],pending:input.includes('BLOCK_TASK')?['missing exact copy']:[]}));}
else fs.writeFileSync(out,'# Report\\n\\nVerified task artifact.');
console.log(JSON.stringify({type:'turn.completed'}));
`);
  await chmod(fake, 0o755);
  const store = new Store(panel); await store.init();
  const engine = new Engine(store, fake);
  const settings = structuredClone(defaultSettings); settings.config.projectRoot = repo; settings.config.installDependencies = false;
  const task = (prompt, name = prompt) => ({ id: randomUUID(), name, branch: 'ai/task', rawPrompt: prompt });
  return { root, repo, panel, fake, engine, store, settings, task };
}
async function settled(engine) {
  const until = Date.now() + 20000;
  while (engine.activeBatch && Date.now() < until) await new Promise(r => setTimeout(r, 30));
  assert.equal(engine.activeBatch, undefined, 'batch must settle');
}
test('parallel tasks isolate files, branch names and staging; failed sibling does not stop success', async () => {
  const f = await fixture(); f.settings.tasks = [f.task('GOOD_TASK'), f.task('FAIL_TASK')];
  const before = (await command('git', ['-C', f.repo, 'diff', '--cached'])).stdout;
  const batch = await f.engine.start(f.settings); await settled(f.engine);
  assert.equal(batch.tasks[0].status, 'completed'); assert.equal(batch.tasks[1].status, 'failed');
  assert.notEqual(batch.tasks[0].actualBranch, batch.tasks[1].actualBranch);
  assert.equal(await readFile(path.join(f.repo, 'original.txt'), 'utf8'), 'user unstaged\n');
  assert.equal((await command('git', ['-C', f.repo, 'diff', '--cached'])).stdout, before);
  assert.equal(await readFile(path.join(batch.tasks[0].worktree, 'original.txt'), 'utf8'), 'original\n');
  await access(path.join(batch.tasks[0].worktree, 'generated.txt'));
  await access(path.join(f.engine.dirs(batch, batch.tasks[0]).todo, 'todo-review.md'));
  await access(path.join(f.engine.dirs(batch, batch.tasks[1]).plan, 'error.log'));
  assert.equal(batch.tasks[0].checks.length, 2);
});
test('missing login blocks the batch before any worktree is created', async () => {
  const f = await fixture(); f.settings.tasks = [f.task('GOOD_TASK')];
  f.engine.auth = async () => ({ loggedIn: false, supported: true, message: 'login missing' });
  const batch = await f.engine.start(f.settings); await settled(f.engine);
  assert.equal(batch.status, 'blocked'); assert.equal(batch.tasks[0].worktree, undefined);
  const review = await readFile(path.join(f.engine.dirs(batch, batch.tasks[0]).todo, 'todo-review.md'), 'utf8'); assert.match(review, /login missing/);
});
test('validation failures cannot be reported as completed; blocked work stays blocked', async () => {
  const f = await fixture(); f.settings.tasks = [f.task('GOOD_TASK'), f.task('BLOCK_TASK')];
  f.settings.config.checks = [`"${process.execPath}" -e "process.exit(3)"`];
  const batch = await f.engine.start(f.settings); await settled(f.engine);
  assert.equal(batch.tasks[0].status, 'failed'); assert.equal(batch.tasks[0].checks[0].exitCode, 3);
  f.settings.tasks = [f.task('BLOCK_TASK')]; f.settings.config.checks = [`"${process.execPath}" -e "process.exit(0)"`];
  const blocked = await f.engine.start(f.settings); await settled(f.engine); assert.equal(blocked.tasks[0].status, 'blocked');
});
test('closing stops running process trees, cancels queued tasks and preserves code', async () => {
  const f = await fixture(); f.settings.config.maxConcurrency = 1; f.settings.tasks = [f.task('SLOW_TASK'), f.task('GOOD_TASK')];
  const batch = await f.engine.start(f.settings);
  const until = Date.now() + 10000;
  while (batch.tasks[0].stage !== '编码实现' && Date.now() < until) await new Promise(r => setTimeout(r, 20));
  assert.equal(batch.tasks[0].stage, '编码实现');
  await f.engine.close(); await settled(f.engine);
  assert.equal(batch.tasks[0].status, 'cancelled'); assert.equal(batch.tasks[1].status, 'cancelled'); await access(batch.tasks[0].worktree);
});
test('restart marks orphaned runs interrupted, keeping history and schedule', async () => {
  const f = await fixture(); f.store.batches = [{ id: 'test', status: 'running', tasks: [{ status: 'running' }] }]; f.store.schedule.enabled = true; await f.store.save();
  const next = new Store(f.panel); await next.init(); assert.equal(next.batches[0].status, 'interrupted'); assert.equal(next.batches[0].tasks[0].status, 'interrupted'); assert.equal(next.schedule.enabled, true);
});
test('HTTP mutations require a session token, reject external origins, and close the listener', async () => {
  const f = await fixture(); const server = await startServer({ root: f.panel, codex: f.fake, port: 0 });
  try {
    const data = await (await fetch(server.origin + '/api/status')).json();
    assert.equal((await fetch(server.origin + '/api/run-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(server.origin + '/api/status', { headers: { Origin: 'https://external.invalid' } })).status, 403);
    f.settings.tasks = [f.task('GOOD_TASK')];
    assert.equal((await fetch(server.origin + '/api/run-now', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auto-Work-Token': data.token }, body: JSON.stringify(f.settings) })).status, 202);
    await settled(server.engine);
    assert.equal(server.store.settings.tasks.length, 0, 'manual run consumes the pending queue');
    const headers = { 'Content-Type': 'application/json', 'X-Auto-Work-Token': data.token };
    assert.equal((await fetch(server.origin + '/api/schedule', { method: 'POST', headers, body: JSON.stringify(f.settings) })).status, 200);
    assert.equal(server.store.settings.tasks.length, 0, 'scheduled tasks move to their own snapshot');
    assert.equal(server.store.schedule.snapshot.tasks[0].rawPrompt, 'GOOD_TASK');
    const future = { ...f.settings, tasks: [f.task('FUTURE_TASK')] };
    await fetch(server.origin + '/api/settings', { method: 'PUT', headers, body: JSON.stringify(future) });
    await server.scheduleTick(); await settled(server.engine);
    assert.equal(server.store.batches[0].tasks[0].rawPrompt, 'GOOD_TASK', 'daily run uses the independent snapshot');
    assert.equal(server.store.settings.tasks[0].rawPrompt, 'FUTURE_TASK', 'daily run cannot consume a future manual task');
    const count = server.store.batches.length;
    await server.scheduleTick(); assert.equal(server.store.batches.length, count, 'daily tick must not duplicate a run');
  } finally { await server.close(); }
  await assert.rejects(fetch(server.origin + '/api/status'));
});
test('image references survive persistence and reach every Codex stage without base64 in prompts', async () => {
  const f = await fixture(); const storage = new Storage(f.store);
  const image = await storage.upload(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFUcAAAAASUVORK5CYII=', 'base64'), '设计图.png');
  f.settings.tasks = [{ ...f.task('IMAGE_TASK'), images: [image.id] }]; f.store.settings = f.settings; await f.store.save();
  const restored = new Store(f.panel); await restored.init(); assert.equal(restored.settings.tasks[0].images[0], image.id);
  const batch = await f.engine.start(f.settings); await settled(f.engine); assert.equal(batch.tasks[0].status, 'completed');
  const calls = (await readFile(path.join(batch.tasks[0].worktree, 'codex-args.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  for (const args of calls) { assert.equal(args[args.indexOf('--image') + 1], storage.imagePath(image.id)); assert.ok(args.includes('--ephemeral')); }
  assert.ok(calls[1].includes('--add-dir')); assert.equal(calls[0].includes('--add-dir'), false);
});

test('accepted manual run consumes pending tasks and keeps an independent historical snapshot', async () => {
  const f = await fixture(); f.settings.tasks = [f.task('GOOD_TASK')];
  const prompt = f.settings.tasks[0].rawPrompt;
  const batch = await f.engine.start(f.settings);
  assert.equal(f.store.settings.tasks.length, 0);
  f.settings.tasks[0].rawPrompt = 'changed later';
  assert.equal(batch.tasks[0].rawPrompt, prompt);
  await settled(f.engine);
  assert.equal(f.store.batches.length, 1); assert.equal(batch.tasks[0].rawPrompt, prompt);
});
