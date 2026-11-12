import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowRight, Check, ChevronDown, Clock3, Expand, ImagePlus, Images, Layers2, LoaderCircle, Paintbrush, Plus, Search, Sparkles, WandSparkles, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Asset, ImageSize, PublicConfig, Quality, Task, TaskMode, User } from '../../shared/types';
import { api, post, ApiError } from '../api';
import { Artwork, inspirations } from './Artwork';
import { MaskEditor } from './MaskEditor';
import { Modal } from './Modal';
import { clampViewTransform, zoomAtPoint, type ViewTransform } from '../lib/viewportTransform';
import './studio-models.css';

export type StudioPage = 'studio' | 'works' | 'inspiration';
const statusLabel: Record<Task['status'], string> = { queued: '等待开始', running: '正在创作', succeeded: '创作完成', partial: '部分完成', failed: '生成失败', uncertain: '结果待确认' };
const activeTask = (t: Task) => ['queued', 'running', 'uncertain'].includes(t.status);
interface Props { config: PublicConfig; user: User | null; tasks: Task[]; page: StudioPage; resetToken: number; onNavigate: (p: StudioPage) => void; onLogin: () => void; onRefreshConfig: () => Promise<void>; onSubmitted: (task: Task, user: User) => void; toast: (s: string) => void }

export function Studio({ config, user, tasks, page, resetToken, onNavigate, onLogin, onRefreshConfig, onSubmitted, toast }: Props) {
  const [prompt, setPrompt] = useState(''); const [mode, setMode] = useState<TaskMode>('generate');
  const [size, setSize] = useState<ImageSize>('1024x1024'); const [quality, setQuality] = useState<Quality>('standard'); const [count, setCount] = useState(1);
  const [modelId, setModelId] = useState(() => new URLSearchParams(location.search).get('modelTest') ?? '');
  const [adminTesting, setAdminTesting] = useState(() => new URLSearchParams(location.search).has('modelTest'));
  const [reference, setReference] = useState<Asset | null>(null); const [mask, setMask] = useState<Asset | null>(null); const [showMask, setShowMask] = useState(false);
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); const [query, setQuery] = useState(''); const [preview, setPreview] = useState<Task | null>(null);
  const upload = useRef<HTMLInputElement>(null); const promptInput = useRef<HTMLTextAreaElement>(null);
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const linkedTestModel = useRef(new URLSearchParams(location.search).get('modelTest'));
  useEffect(() => { setReference(null); setMask(null); setPreview(null); setShowMask(false); submission.current = null; }, [user?.id]);
  useEffect(() => { if (resetToken) { setPrompt(''); setMode('generate'); setReference(null); setMask(null); setError(''); submission.current = null; } }, [resetToken]);
  const testMode = user?.role === 'admin' && adminTesting;
  const modelSource = testMode ? config.adminTestModels ?? [] : config.models;
  const models = modelSource.filter(m => m.modes.includes(mode));
  const model = models.find(m => m.id === modelId) ?? models.find(m => m.isDefault) ?? models[0];
  const actualSize = model?.sizes.includes(size) ? size : model?.sizes[0] ?? size;
  const actualQuality = model?.qualities.includes(quality) ? quality : model?.qualities[0] ?? quality;
  const actualCount = Math.min(count, model?.maxImages ?? 1);
  const unitPrice = model?.prices[mode][actualQuality] ?? 0;
  const cost = unitPrice * actualCount;
  useEffect(() => {
    if (model && model.id !== modelId) {
      if (modelId) setError(`已切换为支持当前任务的“${model.name}”，请核对参数与积分价格后提交。`);
      setModelId(model.id);
    }
  }, [model?.id, modelId]);
  useEffect(() => { setSize(actualSize); setQuality(actualQuality); setCount(actualCount); }, [actualSize, actualQuality, actualCount]);
  useEffect(() => {
    if (!linkedTestModel.current || user?.role !== 'admin' || !config.adminTestModels) return;
    const target = config.adminTestModels.find(item => item.id === linkedTestModel.current);
    if (target) {
      setAdminTesting(true); setModelId(target.id);
      setMode(previous => target.modes.includes(previous) ? previous : target.modes[0]);
      setError('');
    }
    linkedTestModel.current = null;
  }, [config.adminTestModels, user?.role]);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!user) { onLogin(); return; }
    if (!model) { setError('当前任务类型暂无可用模型，请选择其他创作方式或联系管理员'); return; }
    if (mode !== 'generate' && !reference) { setError('请先上传参考图片'); return; }
    if (mode === 'inpaint' && !mask) { setError('请先涂抹需要修改的区域'); return; }
    const body = { prompt, mode, size: actualSize, quality: actualQuality, count: actualCount, modelId: model.id, modelRevision: model.revision, expectedUnitPrice: unitPrice, ...(testMode ? { adminTest: true } : {}), ...(mode !== 'generate' && reference ? { referenceId: reference.id } : {}), ...(mode === 'inpaint' && mask ? { maskId: mask.id } : {}) };
    const fingerprint = JSON.stringify(body);
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = await post<{ task: Task; user: User }>('/tasks', body, { 'Idempotency-Key': submission.current.key });
      onSubmitted(result.task, result.user); submission.current = null; toast(testMode ? '模型测试已提交，结果可在作品中查看' : '任务已加入创作队列，可在作品中查看进度');
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.code?.startsWith('MODEL_')) { await onRefreshConfig().catch(() => undefined); }
    } finally { setBusy(false); }
  }
  async function uploadReference(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return; if (!user) { onLogin(); return; }
    if (file.size > 20 * 1024 * 1024) { setError('请选择 20MB 以内的图片'); return; }
    setUploading(true); setError('');
    try { const form = new FormData(); form.set('file', file); form.set('kind', 'reference'); const r = await api<{ asset: Asset }>('/assets', { method: 'POST', body: form }); setReference(r.asset); setMask(null); }
    catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  function useInspiration(item: typeof inspirations[number]) { setPrompt(item.prompt); setMode('generate'); setError(''); onNavigate('studio'); requestAnimationFrame(() => promptInput.current?.focus()); }
  function reuse(task: Task) {
    setPrompt(task.prompt); setSize(task.size); setQuality(task.quality); setCount(task.count);
    const reuseMode = task.outputs[0] || task.referenceId ? 'edit' : 'generate';
    const reuseSource = task.isTest && user?.role === 'admin' ? config.adminTestModels ?? [] : config.models;
    setAdminTesting(task.isTest && user?.role === 'admin');
    const reuseModel = reuseSource.find(m => m.id === task.modelId && m.modes.includes(reuseMode));
    if (reuseModel) setModelId(reuseModel.id);
    else if (task.modelId) toast('原模型当前不支持此操作，请核对可选模型和积分价格');
    if (task.outputs[0]) { setReference(task.outputs[0]); setMode('edit'); } else if (task.referenceId) {
      setReference({ id: task.referenceId, url: `/api/assets/${task.referenceId}`, width: 0, height: 0, kind: 'reference' }); setMode('edit');
      const image = new Image(); image.onload = () => setReference({ id: task.referenceId!, url: `/api/assets/${task.referenceId}`, width: image.naturalWidth, height: image.naturalHeight, kind: 'reference' }); image.src = `/api/assets/${task.referenceId}`;
    } else { setMode('generate'); setReference(null); }
    setMask(null); setError(''); setPreview(null); onNavigate('studio'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const shown = tasks.filter(t => (!query || t.prompt.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || filter === 'active' && activeTask(t) || filter === 'done' && ['succeeded', 'partial'].includes(t.status) || filter === 'failed' && t.status === 'failed'));
  return <section className="page-content studio-page">
    {page === 'studio' && <>
      <div className="page-heading studio-heading"><div><span className="eyebrow"><span className="tiny-spark">✳</span> A LITTLE IDEA, A NEW POSSIBILITY</span><h1>让每一点灵感，<span>都有画面。</span></h1><p>描述你想象中的画面，剩下的，交给创作。</p></div><div className="heading-note"><span className="note-orbit">✳</span><span>你的想象力<br/>值得被看见</span></div></div>
      {user?.role === 'admin' && <div className="studio-admin-test-bar"><div><strong>管理员模型测试</strong><p>{testMode ? '可以选择尚未开放的模型。测试不会自动上架或标记已验证。' : '新模型可以先测试，再决定是否向用户开放。'}</p></div><label><input type="checkbox" checked={adminTesting} disabled={busy} onChange={e => { setAdminTesting(e.target.checked); setError(''); submission.current = null; if (e.target.checked) void onRefreshConfig().catch(() => undefined); }} />{testMode ? '测试模式已开启' : '开启测试模式'}</label></div>}
      {testMode && <div className="notice studio-test-notice">{config.provider === 'newapi' ? '本次为真实模型测试，会产生 New API 调用费用，并按所选配置冻结和结算你的账户积分。' : '当前为本地模拟测试，不会调用真实模型。'} 建议先选择标准质量、1 张图片验证。</div>}
      <form className="composer" onSubmit={submit}>
        <div className="mode-tabs" role="tablist" aria-label="创作方式">{([{ id: 'generate', label: '文字生图', icon: Sparkles }, { id: 'edit', label: '参考图编辑', icon: ImagePlus }, { id: 'inpaint', label: '局部重绘', icon: Paintbrush }] as const).map(tab => <button type="button" key={tab.id} role="tab" aria-selected={mode === tab.id} className={mode === tab.id ? 'selected' : ''} onClick={() => { setMode(tab.id); setError(''); }}><tab.icon size={17} />{tab.label}</button>)}</div>
        <div className="composer-body">
          <div className="studio-model-picker"><label htmlFor="studio-model">创作模型</label><div className="studio-model-select"><select id="studio-model" value={model?.id ?? ''} disabled={busy || !models.length} onChange={e => { setModelId(e.target.value); setError(''); }}>{!models.length && <option value="">当前创作方式暂无可用模型</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? ' · 推荐' : item.tag ? ` · ${item.tag}` : ''}</option>)}</select><ChevronDown size={14} /></div>{model && <span className="studio-model-price">{unitPrice} 积分 / 张</span>}</div>
          {model ? <div className="studio-model-info"><p>{testMode ? '按后台能力配置测试该模型，实际支持情况以测试结果为准。' : model.description || '选择适合你的创作模型。'}</p><span>{testMode && <b>仅管理员测试</b>}{model.tag && <b>{model.tag}</b>}{model.modes.map(value => <span key={value}>{value === 'generate' ? '文字生图' : value === 'edit' ? '参考图编辑' : '局部重绘'}</span>)}</span></div> : <div className="notice studio-no-model"><span>{testMode ? '暂无支持此操作的模型配置，请在模型管理中添加或调整配置。' : '该创作方式还没有向用户开放的模型。'}</span>{user?.role === 'admin' && !testMode && <button type="button" className="text-button" onClick={() => { setAdminTesting(true); setError(''); void onRefreshConfig().catch(() => undefined); }}>开启管理员测试</button>}</div>}
          {model?.sizeNotice && <p className="studio-size-notice">{model.sizeNotice}</p>}
          <label className="prompt-label" htmlFor="prompt">你想创作什么？<span>细节越具体，画面越接近你的想象</span></label>
          <textarea id="prompt" ref={promptInput} value={prompt} onChange={e => setPrompt(e.target.value)} minLength={2} maxLength={4000} required placeholder={mode === 'generate' ? '例如：午后阳光穿过拱形窗，一张原木桌，一枝橄榄叶。温暖、安静，像一本生活方式杂志的封面…' : '描述你想对图片做的修改，例如：将背景换成温暖的米色摄影棚，保留主体与构图…'} />
          <div className="prompt-foot"><span><WandSparkles size={13} />主体 + 场景 + 风格 + 光线</span><span>{prompt.length} / 4000</span></div>
          {mode !== 'generate' && <div className="reference-section"><input ref={upload} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadReference} aria-label="上传参考图" />{reference ? <div className="reference-preview"><img src={reference.url} alt="当前参考图片" /><div><strong>参考图片已就绪</strong><span>{reference.width} × {reference.height}</span><button type="button" className="text-button" onClick={() => upload.current?.click()} disabled={uploading}>更换图片</button></div><button type="button" className="icon-button" aria-label="移除参考图片" onClick={() => { setReference(null); setMask(null); }}><X size={16} /></button></div> : <button type="button" className="upload-zone" onClick={() => { if (!user) onLogin(); else upload.current?.click(); }} disabled={uploading}>{uploading ? <LoaderCircle size={22} className="spin" /> : <ImagePlus size={23} />}<span>{uploading ? '正在上传…' : '点击上传一张参考图'}</span><small>PNG、JPEG、WebP · 最大 20MB</small></button>}{mode === 'inpaint' && reference && <button type="button" className={`mask-button ${mask ? 'complete' : ''}`} onClick={() => setShowMask(true)} disabled={!reference.width}>{mask ? <Check size={17} /> : <Paintbrush size={17} />}{mask ? '编辑区域已保存 · 重新涂抹' : '涂抹需要修改的区域'}</button>}</div>}
          <div className="controls-row"><label className="select-field"><span>画面比例</span><select aria-label="画面比例" value={actualSize} disabled={!model || busy || model.sizeControl === 'upstream-default'} onChange={e => setSize(e.target.value as ImageSize)}>{(model?.sizes ?? []).map(value => <option key={value} value={value}>{model?.sizeControl === 'upstream-default' ? '模型默认' : value === '1024x1024' ? '1:1 方形' : value === '1536x1024' ? '3:2 横向' : '2:3 竖向'}</option>)}</select><ChevronDown size={13} /></label><label className="select-field"><span>创作质量</span><select aria-label="创作质量" value={actualQuality} disabled={!model || busy} onChange={e => setQuality(e.target.value as Quality)}>{(model?.qualities ?? []).map(value => <option key={value} value={value}>{value === 'standard' ? '标准' : '精细'}</option>)}</select><ChevronDown size={13} /></label><div className="count-field"><span>生成数量</span><div>{Array.from({ length: model?.maxImages ?? 1 }, (_, i) => i + 1).map(n => <button type="button" disabled={!model || busy} className={actualCount === n ? 'selected' : ''} aria-label={`生成 ${n} 张`} aria-pressed={actualCount === n} key={n} onClick={() => setCount(n)}>{n}</button>)}</div></div><div className="model-pill"><span className="status-dot" />{model?.name ?? '暂无模型'}</div></div>
        </div>
        <div className="composer-footer"><p><ShieldIcon /><span>本次 <strong>{model ? `${cost} 积分` : '—'}</strong><span className="footer-divider">/</span>成功交付后结算</span></p><button className="button primary generate-button" disabled={!model || busy || uploading || (!!user && user.credits < cost)} type="submit">{busy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{busy ? '正在提交…' : !model ? '暂无可用模型' : user && user.credits < cost ? '积分不足' : testMode ? '开始模型测试' : '开始创作'}<ArrowRight size={16} /></button></div>
        {error && <div className="composer-error" role="alert">{error}</div>}
      </form>
      <div className="section-heading inspiration-heading"><div><h2>给灵感一个起点<span className="section-tag">INSPIRATION</span></h2><p>选一个方向，让想象再往前一步。</p></div><button className="text-button dark" onClick={() => onNavigate('inspiration')}>探索灵感<ArrowRight size={14} /></button></div>
      <div className="inspiration-grid">{inspirations.map(item => <button className="inspiration-card" key={item.type} onClick={() => useInspiration(item)}><div className="inspiration-art"><Artwork type={item.type} /><span className="art-hint">风格示意</span><span className="use-prompt"><Plus size={15} />使用此灵感</span></div><div className="inspiration-caption"><strong>{item.title}</strong><span>{item.tag}<ArrowRight size={13} /></span></div></button>)}</div>
    </>}
    {page === 'inspiration' && <><div className="page-heading"><span className="eyebrow">A PLACE TO BEGIN</span><h1>下一张好图，从这里开始。</h1><p>这些插画用来展示创作方向，点击后可以继续调整提示词。</p></div><div className="inspiration-grid expanded">{inspirations.map(item => <button className="inspiration-card" key={item.type} onClick={() => useInspiration(item)}><div className="inspiration-art"><Artwork type={item.type} /><span className="art-hint">风格示意</span><span className="use-prompt"><Plus size={15} />使用此灵感</span></div><div className="inspiration-caption"><strong>{item.title}</strong><span>{item.tag}</span></div><p>{item.prompt}</p></button>)}</div></>}
    {page !== 'inspiration' && <div className={page === 'works' ? 'works-section full-works' : 'works-section'}><div className="section-heading"><div><h2>{page === 'works' ? '我的作品' : '最近的创作'}<span className="count-badge">{tasks.length}</span></h2>{page === 'works' && <p>每一次想象，都值得好好收藏。最近 100 项任务。</p>}</div>{page === 'studio' ? <button className="text-button dark" onClick={() => onNavigate('works')}>全部作品<ArrowRight size={14} /></button> : <button className="button secondary" onClick={() => onNavigate('studio')}><Plus size={16} />新的创作</button>}</div>
      {page === 'works' && <div className="works-toolbar"><div className="filter-tabs">{[['all', '全部'], ['active', '进行中'], ['done', '已完成'], ['failed', '失败']].map(([id, label]) => <button key={id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}</button>)}</div><label className="search-field"><Search size={16} /><input aria-label="搜索作品提示词" placeholder="搜索你的创作" value={query} onChange={e => setQuery(e.target.value)} /></label></div>}
      {(page === 'studio' ? tasks.slice(0, 4) : shown).length ? <div className="works-grid">{(page === 'studio' ? tasks.slice(0, 4) : shown).map(task => <article className="work-card" key={task.id}><button className={`work-image ${!task.outputs.length ? 'pending-image' : ''}`} onClick={() => setPreview(task)} aria-label={`查看作品：${task.prompt}`}>{task.outputs[0] ? <><img src={task.outputs[0].url} alt={task.prompt} loading="lazy" /><span className="expand-image"><Expand size={18} /></span></> : <div className="task-placeholder">{['queued', 'running'].includes(task.status) ? <div className="generating-orbit"><Sparkles size={26} /></div> : <Layers2 size={30} strokeWidth={1.2} />}<strong>{statusLabel[task.status]}</strong><span>{task.status === 'uncertain' ? '核对中，请勿重复提交' : task.status === 'failed' ? '本次积分已退回' : '好画面，值得等一会儿'}</span></div>}<span className={`task-badge ${task.status}`}>{task.isTest ? `模型测试 · ${statusLabel[task.status]}` : task.provider === 'mock' && task.outputs.length ? '本地演示' : statusLabel[task.status]}</span>{task.outputs.length > 1 && <span className="output-count"><Images size={12} />{task.outputs.length}</span>}</button><div className="work-caption"><strong>{task.prompt}</strong><div><span>{task.charged || task.reserved} 积分 · {task.quality === 'high' ? '精细' : '标准'}</span><span>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(new Date(task.createdAt))}</span></div></div></article>)}</div> : <div className="empty-works"><div className="empty-icon"><Images size={29} strokeWidth={1.2} /><span>✦</span></div><h3>{query || filter !== 'all' ? '没有找到匹配的作品' : '你的第一张作品，即将诞生'}</h3><p>{user ? '写下一个灵感，或从上方挑选一个创作方向。' : '登录后，创作与作品会保存在你的账户中。'}</p>{!user && <button className="text-button" onClick={onLogin}>登录并开始创作<ArrowRight size={14} /></button>}</div>}
    </div>}
    {showMask && reference && <MaskEditor reference={reference} onClose={() => setShowMask(false)} onSave={async blob => { const form = new FormData(); form.set('file', blob, 'mask.png'); form.set('kind', 'mask'); const r = await api<{ asset: Asset }>('/assets', { method: 'POST', body: form }); setMask(r.asset); setShowMask(false); toast('编辑区域已保存'); }} />}
    {preview && <Preview task={tasks.find(t => t.id === preview.id) ?? preview} onClose={() => setPreview(null)} onReuse={() => reuse(tasks.find(t => t.id === preview.id) ?? preview)} />}
  </section>;
}
function ShieldIcon() { return <span className="credit-spark">✧</span>; }
function Preview({ task, onClose, onReuse }: { task: Task; onClose: () => void; onReuse: () => void }) {
  const [index, setIndex] = useState(0); const [transform, setTransform] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const container = useRef<HTMLDivElement>(null); const drag = useRef<{ x: number; y: number } | null>(null);
  function zoom(factor: number) { const rect = container.current!.getBoundingClientRect(); setTransform(t => zoomAtPoint(t, { x: rect.width / 2, y: rect.height / 2 }, t.scale * factor, rect)); }
  return <Modal title="作品详情" onClose={onClose} wide>{task.outputs.length ? <><div className="preview-stage" ref={container} onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!drag.current) return; const delta = { x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }; setTransform(t => clampViewTransform({ ...t, x: t.x + delta.x, y: t.y + delta.y }, container.current!.getBoundingClientRect())); drag.current = { x: e.clientX, y: e.clientY }; }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><img draggable={false} src={task.outputs[index].url} alt={task.prompt} style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: 'top left' }} /></div><div className="preview-tools"><button className="icon-button" aria-label="缩小图片" onClick={() => zoom(1 / 1.3)}><ZoomOut size={17} /></button><span>{Math.round(transform.scale * 100)}%</span><button className="icon-button" aria-label="放大图片" onClick={() => zoom(1.3)}><ZoomIn size={17} /></button><button className="text-button" onClick={() => setTransform({ scale: 1, x: 0, y: 0 })}>复位</button><span className="spacer" />{task.outputs.map((_, i) => <button className={`chip ${index === i ? 'active' : ''}`} key={i} onClick={() => { setIndex(i); setTransform({ scale: 1, x: 0, y: 0 }); }}>{i + 1}</button>)}</div></> : <div className="empty-small"><Clock3 size={25} /><h3>{statusLabel[task.status]}</h3><p>{task.error || '任务正在后台执行，关闭页面后仍可回来查看。'}</p></div>}<div className="preview-detail"><span className="eyebrow">你的创作描述</span><p>{task.prompt}</p><small>{task.outputs[0] ? `${task.outputs[index].width}×${task.outputs[index].height}` : task.size} · {task.modelName}{task.isTest ? ' · 管理员模型测试' : ''} · 已结算 {task.charged} 积分{task.provider === 'mock' ? ' · 本地演示，非 AI 生成' : ''}</small>{task.error && task.outputs.length > 0 && <p className="hint">{task.error}</p>}</div><div className="modal-actions">{!activeTask(task) && <button className="button secondary" onClick={onReuse}><WandSparkles size={16} />{task.outputs.length ? '以此图继续编辑' : '调整后重试'}</button>}{task.outputs.length > 0 && <a className="button primary" href={`${task.outputs[index].url}?download=1`} download><ArrowDownToLine size={16} />下载图片</a>}</div></Modal>;
}
