import { useState, type FormEvent } from 'react';
import { Check, Cpu, FlaskConical, LoaderCircle, Pencil, Plus, Star } from 'lucide-react';
import type { AdminImageModel, ImageModelInput, ImageSize, Quality, TaskMode, UpstreamQuality } from '../../../shared/types';
import { api, post } from '../../api';
import { Modal } from '../Modal';
import { useAdminResource } from './useAdminResource';
import { AdminRefresh } from './AdminControls';
import './models.css';

const modeNames: Record<TaskMode, string> = { generate: '文字生图', edit: '参考图编辑', inpaint: '局部重绘' };
const qualityNames: Record<Quality, string> = { standard: '标准', high: '精细' };
const sizeNames: Record<ImageSize, string> = { '1024x1024': '1:1 方形 · 1024×1024', '1536x1024': '3:2 横向 · 1536×1024', '1024x1536': '2:3 竖向 · 1024×1536' };
const qualityOptions: UpstreamQuality[] = ['omit', 'auto', 'low', 'medium', 'high', 'standard', 'hd'];
function emptyDraft(): ImageModelInput {
  return { name: '', description: '', tag: '', upstreamModel: '', adapter: 'images-v1', modes: ['generate'], sizes: ['1024x1024'], qualities: ['standard'], maxImages: 1,
    prices: { generate: { standard: 12, high: 24 }, edit: { standard: 12, high: 24 }, inpaint: { standard: 12, high: 24 } },
    qualityMap: { standard: 'omit', high: 'omit' }, sendSize: true, enabled: false, verified: false, isDefault: false, sortOrder: 10 };
}
export function ModelManager({ toast, onChanged }: { toast: (text: string) => void; onChanged: () => void }) {
  const { data, loading, error, refresh } = useAdminResource<{ models: AdminImageModel[]; provider: 'mock' | 'newapi' }>('/admin/models');
  const [editing, setEditing] = useState<AdminImageModel | 'new' | null>(null);
  return <section aria-label="模型管理"><div className="section-heading admin-section-heading"><div><h2><Cpu size={19} />模型管理</h2><p>配置向用户开放的模型、创作能力和每张积分价格。</p></div><AdminRefresh loading={loading} onRefresh={() => void refresh()} /></div>
    <div className="model-manager-toolbar"><p>建议先开放 2–3 个经过验证、有明确差异的模型。</p><button className="button primary" disabled={!data} onClick={() => setEditing('new')}><Plus size={16} />添加模型</button></div>
    <div className="notice"><Check size={17} /><span>{data?.provider === 'mock' ? '当前为本地模拟模式。选择不同模型只验证流程，不代表真实效果或能力。' : '模型通过现有 New API 调用；启用前需完成实际接口、能力与价格联调。'}新建配置默认停用，不会自动上架。</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="model-admin-grid">{data?.models.map(model => <article className={`model-admin-card ${!model.enabled ? 'disabled' : ''}`} key={model.id}>
      <div className="model-admin-card-heading"><div><h3>{model.name}{model.isDefault && <span className="model-default-label"><Star size={11} />默认</span>}</h3><code>{model.upstreamModel}</code></div><span className={`admin-status ${model.enabled && (data.provider === 'mock' || model.verified) ? 'succeeded' : 'failed'}`}>{!model.enabled ? '已停用' : data.provider === 'newapi' && !model.verified ? '待验证，未开放' : '已开放'}</span></div>
      <p>{model.description || '未填写适用场景介绍'}</p><div className="model-capability-tags">{model.modes.map(mode => <span key={mode}>{modeNames[mode]}</span>)}<span>最多 {model.maxImages} 张</span>{model.tag && <span>{model.tag}</span>}</div>
      <dl className="model-admin-prices">{model.modes.map(mode => <div key={mode}><dt>{modeNames[mode]}</dt><dd>{model.qualities.map(q => `${qualityNames[q]} ${model.prices[mode][q]} 积分`).join(' / ')}</dd></div>)}</dl>
      <div className="model-admin-card-footer"><span>{model.verified ? '管理员已确认联调' : '能力与价格尚未确认'} · 排序 {model.sortOrder}</span><div className="model-card-actions"><a className="text-button" href={`/?modelTest=${encodeURIComponent(model.id)}`}><FlaskConical size={13} />测试模型</a><button className="text-button" onClick={() => setEditing(model)}><Pencil size={13} />编辑配置</button></div></div>
    </article>)}</div>
    {!data && <div className="empty-small">{loading ? '正在加载模型…' : '模型加载失败，请刷新重试。'}</div>}
    {editing && <ModelForm key={editing === 'new' ? 'new' : editing.id} model={editing === 'new' ? undefined : editing} provider={data?.provider ?? 'mock'} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); onChanged(); toast('模型配置已保存，工作台将使用最新配置'); }} />}
    <p className="hint">点击“测试模型”可在管理员工作台中测试未开放的配置，无需先勾选已验证。真实测试会产生上游费用并正常扣除账户积分，测试成功不会自动上架。当前仅支持同步 Images 兼容接口。</p>
  </section>;
}
function ModelForm({ model, provider, onClose, onSaved }: { model?: AdminImageModel; provider: 'mock' | 'newapi'; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<ImageModelInput>(() => {
    if (!model) return emptyDraft();
    const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...input } = model;
    return structuredClone(input);
  });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const update = <K extends keyof ImageModelInput>(key: K, value: ImageModelInput[K], capability = false) => setDraft(d => ({ ...d, [key]: value, ...(capability ? { verified: false } : {}) }));
  const toggle = <K extends 'modes' | 'sizes' | 'qualities'>(key: K, value: ImageModelInput[K][number]) => {
    const values = draft[key] as string[];
    update(key, (values.includes(value) ? values.filter(v => v !== value) : [...values, value]) as ImageModelInput[K], true);
  };
  const valid = draft.name.trim() && draft.upstreamModel.trim() && draft.modes.length && draft.sizes.length && draft.qualities.length && (!draft.enabled || provider === 'mock' || draft.verified);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!valid || busy) return; setBusy(true); setError('');
    try {
      if (model) await api(`/admin/models/${model.id}`, { method: 'PUT', body: JSON.stringify({ ...draft, revision: model.revision }) });
      else await post('/admin/models', draft);
      onSaved();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <Modal title={model ? '编辑图片模型' : '添加图片模型'} wide onClose={() => { if (!busy) onClose(); }}><form onSubmit={save} className="model-edit-form"><fieldset disabled={busy}>
    <div className="model-form-grid"><label>展示名称<input required value={draft.name} maxLength={50} placeholder="例如：主力创作" onChange={e => update('name', e.target.value)} /></label><label>New API 模型 ID<input required value={draft.upstreamModel} maxLength={150} pattern="[a-zA-Z0-9_.:/@+\-]+" placeholder="填写中转站中的准确模型 ID" onChange={e => update('upstreamModel', e.target.value, true)} /></label><label className="model-form-full">适用场景说明<input value={draft.description} maxLength={200} placeholder="帮助用户理解这个模型适合什么创作" onChange={e => update('description', e.target.value)} /></label><label>展示标签（可选）<input value={draft.tag} maxLength={12} placeholder="例如：快速、写实" onChange={e => update('tag', e.target.value)} /></label><label>排序权重<input type="number" min={0} max={9999} step={1} required value={draft.sortOrder} onChange={e => update('sortOrder', Number(e.target.value))} /></label></div>
    <div className="model-form-section"><h3>支持的创作能力</h3><div className="model-checkboxes">{(Object.keys(modeNames) as TaskMode[]).map(mode => <label key={mode}><input type="checkbox" checked={draft.modes.includes(mode)} onChange={() => toggle('modes', mode)} />{modeNames[mode]}</label>)}</div><small>仅勾选已经实测支持的能力；局部重绘要求上游接受透明 PNG 蒙版。</small></div>
    <div className="model-form-section"><h3>支持的画幅</h3><div className="model-checkboxes">{(Object.keys(sizeNames) as ImageSize[]).map(size => <label key={size}><input type="checkbox" checked={draft.sizes.includes(size)} onChange={() => toggle('sizes', size)} />{sizeNames[size]}</label>)}</div><label className="model-check"><input type="checkbox" checked={draft.sendSize} onChange={e => update('sendSize', e.target.checked, true)} />发送 size 参数到上游</label><small>关闭后，画幅仅作为网站预期，上游将使用自身默认尺寸，交付尺寸可能不同。</small><label className="model-size-notice-field">向用户展示的尺寸说明<input value={draft.sizeNotice ?? ''} maxLength={160} placeholder="上游实际输出与请求尺寸不一致时，请说明已验证的情况" onChange={e => update('sizeNotice', e.target.value)} /></label></div>
    <div className="model-form-section"><h3>质量与生成数量</h3><div className="model-checkboxes">{(Object.keys(qualityNames) as Quality[]).map(q => <label key={q}><input type="checkbox" checked={draft.qualities.includes(q)} onChange={() => toggle('qualities', q)} />{qualityNames[q]}</label>)}</div><div className="model-form-grid">{draft.qualities.map(q => <label key={q}>{qualityNames[q]}对应的上游 quality<select value={draft.qualityMap[q]} onChange={e => update('qualityMap', { ...draft.qualityMap, [q]: e.target.value as UpstreamQuality }, true)}>{qualityOptions.map(value => <option key={value} value={value}>{value === 'omit' ? '不发送 quality 参数' : value}</option>)}</select></label>)}<label>每任务最多生成张数<input type="number" min={1} max={4} step={1} required value={draft.maxImages} onChange={e => update('maxImages', Number(e.target.value), true)} /></label></div></div>
    <div className="model-form-section"><h3>零售积分价格 · 每张</h3><p>按模型、任务类型与质量设置。提交时冻结，按实际交付张数结算。</p><div className="model-price-grid">{draft.modes.map(mode => <div key={mode}><strong>{modeNames[mode]}</strong>{draft.qualities.map(q => <label key={q}>{qualityNames[q]}<input type="number" required min={1} max={100000} step={1} value={draft.prices[mode][q]} onChange={e => update('prices', { ...draft.prices, [mode]: { ...draft.prices[mode], [q]: Number(e.target.value) } }, true)} /><span>积分</span></label>)}</div>)}</div></div>
    <div className="model-form-section"><h3>接口与上架</h3><p>接口类型：同步 Images API（生成 JSON、编辑 multipart），共用服务端配置的 New API 地址与密钥。</p><label className="model-check"><input type="checkbox" checked={draft.verified} onChange={e => update('verified', e.target.checked)} />我已验证所选模型的接口、能力参数和积分价格</label><div className="model-checkboxes"><label><input type="checkbox" checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked, isDefault: e.target.checked ? d.isDefault : false }))} />向用户开放</label><label><input type="checkbox" checked={draft.isDefault} disabled={!draft.enabled} onChange={e => update('isDefault', e.target.checked)} />设为默认推荐</label></div><small>{provider === 'mock' ? '模拟模式可验证页面流程；切换真实模式后，未确认联调的模型不会向用户开放。' : '真实模式下，只有已验证并启用的模型才会向用户开放。'}修改能力、上游模型或价格后需重新确认联调。</small></div>
    {!draft.modes.length || !draft.sizes.length || !draft.qualities.length ? <p className="form-error">任务类型、画幅和质量至少各选择一项。</p> : null}
    {draft.enabled && provider !== 'mock' && !draft.verified && <p className="form-error">启用真实模型前，请先完成并确认联调。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    </fieldset><div className="modal-actions"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy || !valid}>{busy && <LoaderCircle size={15} className="spin" />}{busy ? '正在保存…' : '保存模型配置'}</button></div></form></Modal>;
}
