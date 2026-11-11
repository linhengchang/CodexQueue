import spawn from 'cross-spawn';
export class CommandError extends Error { constructor(message: string, public code: number | null, public output = '') { super(message); } }
const active = new Set<ReturnType<typeof spawn>>();
export function killTree(child: ReturnType<typeof spawn>) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}
export function stopAll() { for (const child of active) killTree(child); }
export function command(program: string, args: string[], options: { cwd?: string; input?: string; timeout?: number; signal?: AbortSignal; onOutput?: (s: string) => void; shell?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new CommandError('任务已取消或超时', null));
    // Only explicitly configured validation commands use a shell. Git paths and prompts never do.
    const child = spawn(program, args, { cwd: options.cwd, env: process.env, detached: process.platform !== 'win32', windowsHide: true, shell: options.shell ?? false, stdio: ['pipe', 'pipe', 'pipe'] });
    active.add(child);
    let stdout = '', stderr = '', stopped = false;
    const abort = () => { stopped = true; killTree(child); };
    const timer = setTimeout(abort, options.timeout ?? 120_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', b => { const s = String(b); stdout = (stdout + s).slice(-2_000_000); options.onOutput?.(s); });
    child.stderr!.on('data', b => { const s = String(b); stderr = (stderr + s).slice(-200_000); options.onOutput?.(s); });
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.input);
    const clean = () => { clearTimeout(timer); active.delete(child); options.signal?.removeEventListener('abort', abort); };
    child.once('error', e => { clean(); reject(new CommandError(e.message, null)); });
    child.once('close', code => {
      clean();
      // A command must not leave a background server behind after its stage ends.
      if (process.platform !== 'win32') killTree(child);
      if (stopped) reject(new CommandError('任务已取消或超时', null, stderr));
      else if (code !== 0) reject(new CommandError(`${program} 执行失败（${code}）`, code, [stderr, stdout].filter(Boolean).join('\n')));
      else resolve({ stdout, stderr, code: 0 });
    });
  });
}
