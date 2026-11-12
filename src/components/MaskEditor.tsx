import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Eraser, Undo2, Paintbrush, Check } from 'lucide-react';
import { Modal } from './Modal';
import { clientPointToCanvasPoint, type Point } from '../lib/viewportTransform';
import type { Asset } from '../../shared/types';

export function MaskEditor({ reference, onSave, onClose }: { reference: Asset; onSave: (blob: Blob) => Promise<void>; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const previous = useRef<Point | null>(null);
  const undo = useRef<ImageData[]>([]);
  const [brush, setBrush] = useState(42);
  const [erasing, setErasing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [strokes, setStrokes] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const c = canvas.current!;
    c.width = reference.width; c.height = reference.height;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setLoaded(true);
  }, [reference]);
  const draw = (event: PointerEvent<HTMLCanvasElement>, start = false) => {
    if (!loaded || saving || (!start && !previous.current)) return;
    const c = canvas.current!; const ctx = c.getContext('2d')!;
    const p = clientPointToCanvasPoint(c.getBoundingClientRect(), { x: event.clientX, y: event.clientY }, { width: c.width, height: c.height });
    if (start) {
      undo.current.push(ctx.getImageData(0, 0, c.width, c.height));
      const historyLimit = Math.max(1, Math.min(8, Math.floor(32 * 1024 * 1024 / (c.width * c.height * 4))));
      while (undo.current.length > historyLimit) undo.current.shift();
      c.setPointerCapture(event.pointerId); previous.current = p; setStrokes(v => v + 1);
    }
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#f5825e'; ctx.lineWidth = brush * c.width / c.getBoundingClientRect().width;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
    ctx.moveTo(previous.current!.x, previous.current!.y); ctx.lineTo(p.x + .01, p.y + .01); ctx.stroke(); previous.current = p;
  };
  const save = () => {
    const c = canvas.current!; const ctx = c.getContext('2d')!; const pixels = ctx.getImageData(0, 0, c.width, c.height);
    let painted = false;
    // OpenAI-compatible masks: transparent = edit, opaque = preserve.
    for (let i = 0; i < pixels.data.length; i += 4) {
      const alpha = pixels.data[i + 3]; if (alpha > 0) painted = true;
      pixels.data[i] = 255; pixels.data[i + 1] = 255; pixels.data[i + 2] = 255; pixels.data[i + 3] = 255 - alpha;
    }
    if (!painted) { setError('请先涂抹需要修改的区域'); return; }
    const output = document.createElement('canvas'); output.width = c.width; output.height = c.height;
    output.getContext('2d')!.putImageData(pixels, 0, 0);
    setSaving(true); setError('');
    output.toBlob(blob => {
      if (!blob) { setError('蒙版导出失败，请重试'); setSaving(false); return; }
      void onSave(blob).catch(e => { setError(e.message); setSaving(false); });
    }, 'image/png');
  };
  return <Modal title="涂抹需要修改的区域" wide onClose={() => { if (!saving) onClose(); }}>
    <div className="mask-tools"><button className={!erasing ? 'chip active' : 'chip'} onClick={() => setErasing(false)}><Paintbrush size={16} />画笔</button><button className={erasing ? 'chip active' : 'chip'} onClick={() => setErasing(true)}><Eraser size={16} />擦除</button><label>笔刷<input aria-label="笔刷大小" type="range" min="8" max="100" value={brush} onChange={e => setBrush(Number(e.target.value))} /></label><button className="chip" disabled={!strokes || saving} onClick={() => { const image = undo.current.pop(); if (image) canvas.current!.getContext('2d')!.putImageData(image, 0, 0); setStrokes(v => Math.max(0, v - 1)); }}><Undo2 size={16} />撤销</button></div>
    <div className="mask-stage"><div style={{ aspectRatio: `${reference.width}/${reference.height}`, width: `min(100%, ${Math.min(560, 480 * reference.width / reference.height)}px)` }}><img src={reference.url} alt="待编辑的参考图片" /><canvas ref={canvas} aria-label="蒙版画布" onPointerDown={e => draw(e, true)} onPointerMove={e => draw(e)} onPointerUp={() => { previous.current = null; }} onPointerCancel={() => { previous.current = null; }} /></div></div>
    <p className="hint">橙色区域将交给模型修改，其余区域尽量保留。最终效果取决于模型能力。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose} disabled={saving}>取消</button><button className="button primary" disabled={saving} onClick={save}><Check size={16} />{saving ? '保存中…' : '使用此区域'}</button></div>
  </Modal>;
}
