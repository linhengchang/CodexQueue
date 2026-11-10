import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, lstat, realpath, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export class Storage {
  busy = false;
  constructor(public store: Store, private trash?: (file: string) => Promise<void>) {}
  get imageRoot() { return path.join(this.store.root, 'data', 'attachments'); }
  async regular(file: string, root: string) {
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件超出管理目录');
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('不处理符号链接');
    const canonical = await realpath(file); const canonicalRoot = await realpath(this.store.root);
    if (!canonical.startsWith(canonicalRoot + path.sep)) throw new Error('文件超出项目管理目录');
    return info;
  }
  imagePath(id: string) {
    const image = this.store.attachments.find(i => i.id === id);
    if (!image || !/^[a-f0-9]{64}$/.test(id) || !['png', 'jpg', 'webp'].includes(image.extension)) throw new Error('图片不存在或已被清理');
    return path.join(this.imageRoot, `${id}.${image.extension}`);
  }
  async imagePaths(ids: string[] = []) {
    const files: string[] = [];
    for (const id of ids) { const file = this.imagePath(id); const info = await this.regular(file, this.imageRoot); if (!info.isFile()) throw new Error('图片文件无效'); files.push(file); }
    return files;
  }
  async upload(bytes: Buffer, name: string) {
    if (this.busy) throw new Error('正在清理存储，请稍后重试');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB');
    let extension = '', mime = '';
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { extension = 'png'; mime = 'image/png'; }
    else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) { extension = 'jpg'; mime = 'image/jpeg'; }
    else if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') { extension = 'webp'; mime = 'image/webp'; }
    if (!extension) throw new Error('仅支持 PNG、JPEG、WebP 图片，请勿仅修改文件扩展名');
    const id = createHash('sha256').update(bytes).digest('hex');
    const exists = this.store.attachments.find(i => i.id === id);
    if (exists) { await this.imagePaths([id]); return exists; }
    await mkdir(this.imageRoot, { recursive: true });
    // Refuse a redirected attachment directory before writing any upload.
    await this.regular(this.imageRoot, this.imageRoot);
    const image = { id, name: path.basename(name).slice(0, 200) || `image.${extension}`, extension, mime, bytes: bytes.length, createdAt: new Date().toISOString() };
    await writeFile(path.join(this.imageRoot, `${id}.${extension}`), bytes, { flag: 'wx' }).catch((e: any) => { if (e.code !== 'EEXIST') throw e; });
    if (!this.store.attachments.some(i => i.id === id)) this.store.attachments.push(image);
    await this.store.save(); return this.store.attachments.find(i => i.id === id)!;
  }
  referenced(excludeIds: string[] = []) {
    return new Set([...excludeIds, ...this.store.settings.tasks.flatMap(t => t.images || []), ...this.store.batches.flatMap(b => b.tasks.flatMap(t => t.images || []))]);
  }
  async files(root: string): Promise<{ path: string; bytes: number }[]> {
    let info;
    try { info = await this.regular(root, root); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
    if (!info.isDirectory()) throw new Error('管理目录无效');
    const result: { path: string; bytes: number }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) result.push(...await this.files(file));
      else if (entry.isFile()) result.push({ path: file, bytes: (await this.regular(file, root)).size });
    }
    return result;
  }
  async summary() {
    const [images, artifacts, reviews, manifests] = await Promise.all([this.files(this.imageRoot), this.files(path.join(this.store.root, 'task')), this.files(path.join(this.store.root, 'todo')), this.files(path.join(this.store.root, 'data', 'worktree-records'))]);
    const sum = (files: { bytes: number }[]) => files.reduce((n, f) => n + f.bytes, 0);
    const referenced = this.referenced();
    const stateBytes = (await this.regular(path.join(this.store.root, 'data', 'state.json'), path.join(this.store.root, 'data'))).size + sum(manifests);
    const screenshots = artifacts.filter(f => /\.(png|jpe?g|webp)$/i.test(f.path));
    const logs = artifacts.filter(f => f.path.endsWith('.log'));
    const reports = artifacts.filter(f => !screenshots.includes(f) && !logs.includes(f));
    const batches = this.store.batches.map(batch => {
      const batchFiles = [...artifacts, ...reviews].filter(f => f.path.startsWith(path.join(this.store.root, 'task', batch.id) + path.sep) || f.path.startsWith(path.join(this.store.root, 'todo', batch.id) + path.sep));
      return { id: batch.id, createdAt: batch.createdAt, status: batch.status, bytes: sum(batchFiles), tasks: batch.tasks.map(t => t.name), worktrees: batch.tasks.map(t => t.worktree).filter(Boolean) };
    });
    return { root: this.store.root, imagePath: this.imageRoot, taskPath: path.join(this.store.root, 'task'), todoPath: path.join(this.store.root, 'todo'), trashMode: this.trash ? 'system' : 'local', recyclePath: path.join(this.store.root, 'data', 'recycle-bin'), totalBytes: sum([...images, ...artifacts, ...reviews]) + stateBytes, stateBytes, imageBytes: sum(images), imageCount: images.length, unusedImageCount: this.store.attachments.filter(i => !referenced.has(i.id)).length, logBytes: sum(logs), screenshotBytes: sum(screenshots), reportBytes: sum([...reports, ...reviews]), batches };
  }
  async moveToTrash(file: string, root: string) {
    try { await this.regular(file, root); } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
    // Scan every descendant before moving a directory; never follow symlinks.
    if ((await lstat(file)).isDirectory()) await this.files(file);
    if (this.trash) await this.trash(file);
    else {
      const recycle = path.join(this.store.root, 'data', 'recycle-bin'); await mkdir(recycle, { recursive: true });
      await rename(file, path.join(recycle, `${Date.now()}-${randomUUID()}-${path.basename(file)}`));
    }
    return true;
  }
  async cleanup(input: { batchIds: string[]; unusedImages: boolean; protectImageIds: string[] }, isRunning: () => boolean) {
    if (this.busy || isRunning()) throw new Error('有任务正在运行或清理尚未完成，请稍后再试');
    this.busy = true;
    try {
      const batches = input.batchIds.map(id => { const batch = this.store.batches.find(b => b.id === id); if (!batch || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('批次不存在'); if (['running', 'queued'].includes(batch.status)) throw new Error('不能清理运行中的批次'); return batch; });
      let removedBatches = 0, removedImages = 0;
      for (const batch of batches) {
        for (const category of ['task', 'todo']) await this.moveToTrash(path.join(this.store.root, category, batch.id), path.join(this.store.root, category));
        // Preserve a manifest outside the worktree so code can still be found after removing history.
        const manifestDir = path.join(this.store.root, 'data', 'worktree-records'); await mkdir(manifestDir, { recursive: true });
        await writeFile(path.join(manifestDir, `${batch.id}.json`), JSON.stringify({ id: batch.id, projectRoot: batch.config.projectRoot, baseCommit: batch.baseCommit, tasks: batch.tasks.map(t => ({ name: t.name, worktree: t.worktree, branch: t.actualBranch })) }, null, 2));
        this.store.batches = this.store.batches.filter(b => b.id !== batch.id); removedBatches++; await this.store.save();
      }
      if (input.unusedImages) {
        const referenced = this.referenced(input.protectImageIds);
        for (const image of [...this.store.attachments]) {
          if (referenced.has(image.id)) continue;
          await this.moveToTrash(this.imagePath(image.id), this.imageRoot);
          this.store.attachments = this.store.attachments.filter(i => i.id !== image.id); removedImages++; await this.store.save();
        }
      }
      return { removedBatches, removedImages, trashMode: this.trash ? 'system' : 'local' };
    } finally { this.busy = false; }
  }
}
