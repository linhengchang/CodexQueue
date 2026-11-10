import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, access, realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { command, CommandError } from './process.js';
import { Store } from './store.js';
import { Storage } from './storage.js';
import type { Auth, Batch, TaskRun, Settings, Config } from '../shared/types.js';

export const settingsSchema = z.object({
  config: z.object({ projectRoot: z.string().min(1).max(2000), maxConcurrency: z.number().int().min(1).max(5), singleTaskTimeout: z.number().int().min(60_000).max(86_400_000), baseRef: z.string().min(1).max(200).refine(s => !s.startsWith('-')), model: z.string().max(100), installDependencies: z.boolean(), checks: z.array(z.string().min(1).max(2000)).max(10), scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  tasks: z.array(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100), branch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,99}$/), rawPrompt: z.string().min(1).max(100_000), images: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional() })).max(50)
}).superRefine((s, ctx) => { if (new Set(s.tasks.map(t => t.id)).size !== s.tasks.length) ctx.addIssue({ code: 'custom', message: '任务 ID 不能重复' }); });

const policy = `你是无人值守的开发执行器。普通技术和产品细节不向用户提问，自行判断并继续。
决策顺序：项目现有规范和实现 > 已安装依赖的官方推荐用法 > 成熟常见的行业做法 > 满足需求的简单实现。不要声称已查证未实际查证的市场惯例。
遵守目标仓库 AGENTS.md。保留用户原始需求中的具体文案、标点、数字和有语义的换行；文案缺失、模糊或冲突不得编造，记录为待确认，能独立完成的部分继续。
只处理本任务。不进行无关重构，不推送、不提交、不合并、不切换分支、不移除 worktree、不改原仓库工作目录。
技术假设、选择理由、已实现待复核事项和真正未完成事项必须分别记录。缺少凭据、必要权限或关键需求无法推断时报告 blocked，不假装完成。
禁止寻找或披露账号凭据。不要尝试绕过沙箱或权限限制。`;

export class Engine extends EventEmitter {
  controllers = new Map<string, AbortController>();
  activeBatch?: string;
  closing = false;
  starting = false;
  constructor(public store: Store, public codex = process.env.AUTO_WORK_CODEX || 'codex') { super(); }
  changed() { this.emit('change'); }
  async persist() { await this.store.save(); this.changed(); }
  async auth(): Promise<Auth> {
    const result: Auth = { installed: false, loggedIn: false, version: '', method: '', supported: false, message: '', checkedAt: new Date().toISOString() };
    try {
      const version = await command(this.codex, ['--version'], { timeout: 10_000 });
      result.installed = true; result.version = version.stdout.trim();
      const help = await command(this.codex, ['exec', '--help'], { timeout: 10_000 });
      result.supported = ['--sandbox', '--json', '--image', '--ephemeral'].every(flag => help.stdout.includes(flag));
      const login = await command(this.codex, ['login', 'status'], { timeout: 15_000 });
      const message = (login.stdout + login.stderr).split('\n').filter(s => !s.startsWith('WARNING:')).join('\n').trim();
      result.loggedIn = true; result.method = /chatgpt/i.test(message) ? 'ChatGPT' : /api key/i.test(message) ? 'API Key' : '已登录';
      result.message = result.supported ? '凭据检查通过，尚未验证网络和额度' : '当前 CLI 缺少必要参数，请升级 Codex';
    } catch (e) { result.message = result.installed ? '登录检查未通过，请在终端执行 codex login；' + (e as Error).message : '未找到 Codex CLI，请先安装并登录'; }
    return result;
  }
  async project(root: string, baseRef = 'HEAD') {
    if (!path.isAbsolute(root)) throw new Error('目标项目必须是绝对路径');
    const actual = await realpath(root);
    const repo = (await command('git', ['-C', actual, 'rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(repo) !== actual) throw new Error('请选择 Git 仓库根目录');
    const baseCommit = (await command('git', ['-C', actual, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).stdout.trim();
    const dirty = Boolean((await command('git', ['-C', actual, 'status', '--porcelain'])).stdout.trim());
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(await readFile(path.join(actual, 'package.json'), 'utf8')).scripts || {}; } catch {}
    const manager = await this.manager(actual);
    const checks = ['typecheck', 'type-check', 'check:types', 'lint'].filter(s => scripts[s]).filter((s, i, all) => s === 'lint' || i === 0).map(s => `${manager} run ${s}`);
    return { root: actual, baseCommit, dirty, scripts, checks, manager };
  }
  async manager(root: string) {
    for (const [lock, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']]) {
      try { await access(path.join(root, lock)); return manager; } catch {}
    }
    return 'npm';
  }
  async start(settings: Settings, source: Batch['source'] = 'manual') {
    if (this.closing || this.activeBatch || this.starting) throw new Error('已有批次运行中，或服务正在关闭');
    this.starting = true;
    try {
      settingsSchema.parse(settings);
      if (!settings.tasks.length) throw new Error('请先新增任务');
      for (const task of settings.tasks) await new Storage(this.store).imagePaths(task.images);
      const id = randomUUID();
      const batch: Batch = { id, createdAt: new Date().toISOString(), status: 'running', source, config: structuredClone(settings.config), baseCommit: '', tasks: settings.tasks.map(t => ({ ...structuredClone(t), status: 'queued', stage: '等待执行', sessionIds: [], checks: [] })) };
      this.store.batches.unshift(batch); this.activeBatch = id;
      await this.persist();
      void this.runBatch(batch).catch(async e => {
        batch.status = 'failed'; batch.error = (e as Error).message; batch.endedAt = new Date().toISOString(); this.activeBatch = undefined; await this.persist();
      });
      return batch;
    } finally { this.starting = false; }
  }
  async runBatch(batch: Batch) {
    const auth = await this.auth();
    if (!auth.loggedIn || !auth.supported) {
      batch.status = 'blocked'; batch.error = auth.message;
      for (const task of batch.tasks) { task.status = 'blocked'; task.error = auth.message; task.stage = '登录检查未通过'; await this.failureFiles(batch, task); }
    } else if (this.closing || batch.tasks.every(t => t.status === 'cancelled')) {
      batch.status = 'cancelled';
    } else {
      try {
        const project = await this.project(batch.config.projectRoot, batch.config.baseRef);
        batch.config.projectRoot = project.root; batch.baseCommit = project.baseCommit;
        if (!batch.config.checks.length) batch.config.checks = project.checks;
        await this.persist();
        let cursor = 0;
        const worker = async () => {
          while (cursor < batch.tasks.length) {
            const task = batch.tasks[cursor++];
            if (task.status === 'cancelled' || this.closing) { task.status = 'cancelled'; continue; }
            await this.runTask(batch, task);
          }
        };
        await Promise.all(Array.from({ length: batch.config.maxConcurrency }, worker));
        batch.status = batch.tasks.every(t => t.status === 'completed') ? 'completed' : batch.tasks.some(t => t.status === 'failed') ? 'failed' : batch.tasks.some(t => t.status === 'blocked') ? 'blocked' : 'cancelled';
      } catch (e) {
        batch.status = 'blocked'; batch.error = (e as Error).message;
        for (const task of batch.tasks) if (task.status === 'queued') { task.status = 'blocked'; task.error = batch.error; await this.failureFiles(batch, task); }
      }
    }
    batch.endedAt = new Date().toISOString(); this.activeBatch = undefined; await this.persist();
  }
  dirs(batch: Batch, task: TaskRun) { return { plan: path.join(this.store.root, 'task', batch.id, task.id), todo: path.join(this.store.root, 'todo', batch.id, task.id) }; }
  async failureFiles(batch: Batch, task: TaskRun) {
    const dirs = this.dirs(batch, task); await mkdir(dirs.plan, { recursive: true }); await mkdir(dirs.todo, { recursive: true });
    await writeFile(path.join(dirs.plan, 'error.log'), task.error || '任务未完成');
    try { await access(path.join(dirs.todo, 'todo-review.md')); } catch {
      await writeFile(path.join(dirs.todo, 'todo-review.md'), `# ${task.name}\n\n任务状态：${task.status}\n\n## 未完成事项\n${task.error || '任务未完成'}\n\n## 人工检查项\n检查保留的工作目录和日志后，修复阻塞原因并重新运行。\n\n工作目录：${task.worktree || '尚未创建'}\n分支：${task.actualBranch || '尚未创建'}\n`);
    }
  }
  async runTask(batch: Batch, task: TaskRun) {
    const controller = new AbortController(); this.controllers.set(task.id, controller);
    const timer = setTimeout(() => { task.error = '超过单任务超时时间'; controller.abort(); }, batch.config.singleTaskTimeout);
    const dirs = this.dirs(batch, task);
    const logFile = path.join(dirs.plan, 'events.log');
    let logWrites = Promise.resolve();
    const log = (s: string) => { this.emit('log', { batchId: batch.id, taskId: task.id, text: s }); logWrites = logWrites.then(() => appendFile(logFile, s)); };
    const stage = async (name: string) => { task.stage = name; log(`\n[${new Date().toISOString()}] ${name}\n`); await this.persist(); };
    const run = (program: string, args: string[], opts: { input?: string; shell?: boolean } = {}) => command(program, args, { ...opts, cwd: task.worktree || batch.config.projectRoot, signal: controller.signal, timeout: batch.config.singleTaskTimeout, onOutput: log });
    try {
      await mkdir(dirs.plan, { recursive: true }); await mkdir(dirs.todo, { recursive: true });
      task.status = 'running'; task.startedAt = new Date().toISOString(); await stage('创建 worktree');
      task.actualBranch = `${task.branch}/${batch.id.slice(0, 8)}-${task.id.slice(0, 8)}`;
      task.worktree = path.join(path.dirname(batch.config.projectRoot), '.auto-work-worktrees', path.basename(batch.config.projectRoot), batch.id, task.id);
      await mkdir(path.dirname(task.worktree), { recursive: true });
      await command('git', ['-C', batch.config.projectRoot, 'check-ref-format', '--branch', task.actualBranch], { signal: controller.signal });
      // cwd must exist before spawning git worktree add.
      await command('git', ['-C', batch.config.projectRoot, 'worktree', 'add', '-b', task.actualBranch, task.worktree, batch.baseCommit], { signal: controller.signal, onOutput: log });
      const codexPhase = async (prompt: string, mode: string, out: string, schema?: string) => {
        const args = ['-a', 'never', 'exec', '--sandbox', mode, '--ephemeral', '--json', '-C', task.worktree!, '-o', out];
        for (const image of await new Storage(this.store).imagePaths(task.images)) args.push('--image', image);
        const screenshots = path.join(dirs.plan, 'screenshots');
        if (mode === 'workspace-write') { await mkdir(screenshots, { recursive: true }); args.push('--add-dir', screenshots); }
        if (batch.config.model) args.push('-m', batch.config.model);
        if (schema) args.push('--output-schema', schema);
        args.push('-');
        const output = await run(this.codex, args, { input: `${policy}\n\n原始需求：\n${task.rawPrompt}\n\n附加图片共 ${task.images?.length || 0} 张，作为需求参考。对图片中无法辨认的文案记录待确认，不猜测。若生成验证截图，统一保存在：${screenshots}，不要把截图放入业务源码或 node_modules。\n\n${prompt}` });
        for (const line of output.stdout.split('\n')) { try { const event = JSON.parse(line); if (event.type === 'thread.started' && event.thread_id) task.sessionIds.push(event.thread_id); if (event.type === 'turn.failed' || event.type === 'error') throw new Error(event.error?.message || event.message || 'Codex 阶段失败'); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
        const content = await readFile(out, 'utf8'); if (!content.trim()) throw new Error('Codex 未生成阶段输出'); return content;
      };
      await stage('规划方案');
      const plan = await codexPhase('规划阶段：只读取项目，禁止写文件或修改代码。输出 Markdown：需求理解与边界、文件清单、技术方案、组件与数据流、风险、依赖、待复核的决策、缺失文案等阻塞事项。不要请求确认，普通细节自行决定。', 'read-only', path.join(dirs.plan, 'plan.md'));
      if (batch.config.installDependencies) {
        await stage('准备依赖');
        try {
          await access(path.join(task.worktree, 'package.json'));
          const manager = await this.manager(task.worktree);
          const args = manager === 'pnpm' ? ['install', '--frozen-lockfile', '--ignore-scripts'] : manager === 'yarn' ? ['install', '--frozen-lockfile', '--ignore-scripts'] : ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
          if (manager === 'npm') { try { await access(path.join(task.worktree, 'package-lock.json')); args.splice(0, 1, 'ci'); } catch {} }
          await run(manager, args);
        } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
      await stage('编码实现');
      const schemaFile = path.join(dirs.plan, 'result-schema.json');
      await writeFile(schemaFile, JSON.stringify({ type: 'object', properties: { status: { type: 'string', enum: ['completed', 'blocked'] }, summary: { type: 'string' }, decisions: { type: 'array', items: { type: 'string' } }, pending: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary', 'decisions', 'pending'], additionalProperties: false }));
      const result = z.object({ status: z.enum(['completed', 'blocked']), summary: z.string(), decisions: z.array(z.string()), pending: z.array(z.string()) }).parse(JSON.parse(await codexPhase(`编码阶段：按下面方案实现。必要时基于项目证据调整方案并记录原因。不要等待人工确认。必要配置缺失时保留已完成部分，报告 blocked。\n方案：\n${plan}`, 'workspace-write', path.join(dirs.plan, 'implementation.json'), schemaFile)));
      await stage('独立校验');
      let checkFailure = '';
      if (!batch.config.checks.length) checkFailure = '未检测到 typecheck/lint 校验脚本，请配置校验命令后重新运行';
      for (const check of batch.config.checks) {
        try { await run(check, [], { shell: true }); task.checks.push({ command: check, exitCode: 0 }); }
        catch (e) { if (controller.signal.aborted) throw e; task.checks.push({ command: check, exitCode: e instanceof CommandError ? e.code : null }); checkFailure += `\n校验失败：${check}`; }
        await this.persist();
      }
      await stage('生成 Review 清单');
      await codexPhase(`Review 阶段：只读，不修改代码。检查 git diff ${batch.baseCommit}（包括新增文件），以及以下实施结果和后端独立校验结果。输出 Markdown：已完成功能清单；已实现待复核决策及理由；真正未完成事项与缺失文案；校验结果；人工 review 检查点；后续优化项。明确区分事实、假设与未验证内容。\n方案：\n${plan}\n实施结果：\n${JSON.stringify(result)}\n后端校验：\n${JSON.stringify(task.checks)}\n校验问题：${checkFailure || '无'}`, 'read-only', path.join(dirs.todo, 'todo-review.md'));
      const diff = await run('git', ['diff', '--stat', batch.baseCommit]);
      await writeFile(path.join(dirs.plan, 'changes.txt'), diff.stdout);
      task.status = checkFailure ? 'failed' : result.status === 'blocked' ? 'blocked' : 'completed';
      if (checkFailure || result.status === 'blocked') { task.error = checkFailure || result.pending.join('\n') || result.summary; await this.failureFiles(batch, task); }
      task.stage = task.status === 'completed' ? '执行完成' : '需要复核';
    } catch (e) {
      task.status = controller.signal.aborted ? task.error?.includes('超时') ? 'failed' : 'cancelled' : 'failed';
      task.error ||= (e as Error).message + (e instanceof CommandError ? '\n' + e.output.slice(-5000) : '');
      task.stage = task.status === 'cancelled' ? '已取消' : '执行失败';
      await this.failureFiles(batch, task);
    } finally {
      clearTimeout(timer); this.controllers.delete(task.id); task.endedAt = new Date().toISOString();
      await logWrites; await this.persist();
    }
  }
  async cancel(batchId: string) {
    const batch = this.store.batches.find(b => b.id === batchId); if (!batch || batch.status !== 'running') return;
    for (const task of batch.tasks) { if (task.status === 'queued') { task.status = 'cancelled'; task.stage = '已取消'; } this.controllers.get(task.id)?.abort(); }
    await this.persist();
  }
  async close() {
    this.closing = true;
    if (this.activeBatch) await this.cancel(this.activeBatch);
    const until = Date.now() + 10_000;
    while (this.activeBatch && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    await this.store.save();
  }
}
