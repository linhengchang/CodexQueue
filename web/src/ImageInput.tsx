import { useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';

export function ImageInput({ images, onChange, onUploading, upload, notify, children }: { images: string[]; onChange: (ids: string[]) => void; onUploading: (value: boolean) => void; upload: (file: File) => Promise<{ id: string }>; notify: (message: string) => void; children: ReactNode }) {
  const input = useRef<HTMLInputElement>(null); const idsRef = useRef(images); idsRef.current = images;
  const [uploading, setUploading] = useState(false); const [dragging, setDragging] = useState(false); const [preview, setPreview] = useState<string>();
  const inFlight = useRef(false);
  async function add(files: File[]) {
    if (inFlight.current) return notify('图片正在上传，请稍候');
    if (files.length + idsRef.current.length > 8) return notify('每个任务最多添加 8 张图片');
    inFlight.current = true; setUploading(true); onUploading(true);
    try {
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('仅支持 PNG、JPEG、WebP 图片');
        if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB');
        const bitmap = await createImageBitmap(file).catch(() => { throw new Error('图片无法读取，请重新导出后上传'); });
        const pixels = bitmap.width * bitmap.height; bitmap.close();
        if (pixels > 32_000_000) throw new Error('图片分辨率过大，请缩小到 3200 万像素以内');
        const image = await upload(file);
        const next = [...new Set([...idsRef.current, image.id])]; idsRef.current = next; onChange(next);
      }
    } catch (e) { notify((e as Error).message); }
    finally { inFlight.current = false; setUploading(false); onUploading(false); if (input.current) input.current.value = ''; }
  }
  return <div className={'image-input ' + (dragging ? 'dragging' : '')} onPaste={e => { const files = [...e.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { e.preventDefault(); void add(files); } }} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); void add([...e.dataTransfer.files]); }}>
    {children}
    <div className="image-toolbar"><button type="button" className="button small" onClick={() => input.current?.click()} disabled={uploading}>{uploading ? <Loader2 className="spin" size={15}/> : <ImagePlus size={15}/>}添加图片</button><span>支持拖拽、截图粘贴 · 最多 8 张 · 每张 10 MB</span><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => void add([...e.target.files || []])}/></div>
    {images.length > 0 && <div className="image-thumbnails">{images.map((id, index) => <div className="image-thumbnail" key={id}><button className="thumbnail-preview" type="button" onClick={() => setPreview(id)} aria-label={`预览图片 ${index + 1}`}><img src={'/api/attachments/' + id} alt={`需求参考图片 ${index + 1}`}/></button><button type="button" className="remove-image" aria-label={`移除图片 ${index + 1}`} disabled={uploading} onClick={() => onChange(images.filter(image => image !== id))}><X size={12}/></button><small>图片 {index + 1}</small></div>)}</div>}
    <p className="image-storage-note">图片保存在本地 data/attachments/，相同图片只保存一份。移除附件后可在「存储管理」清理未引用图片。</p>
    {preview && <div className="image-preview" onClick={() => setPreview(undefined)} role="dialog" aria-label="图片预览"><button className="icon-button" type="button" aria-label="关闭图片预览"><X size={24}/></button><img src={'/api/attachments/' + preview} alt="需求参考图片预览"/></div>}
  </div>;
}
