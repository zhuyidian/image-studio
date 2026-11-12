import { useEffect, useState, type FormEvent } from 'react';
import { HardDrive, LoaderCircle, Save, Trash2 } from 'lucide-react';
import type { CleanupReport, StorageAdmin, StoragePolicy } from '../../../shared/types';
import { api, post } from '../../api';
import { Modal } from '../Modal';
import { storageBytes } from '../WorksManager';
import { AdminPagination, AdminRefresh } from './AdminControls';
import { useAdminResource } from './useAdminResource';
import './storage.css';

export function StorageSettings({ toast }: { toast: (text: string) => void }) {
  const [page, setPage] = useState(1); const { data, error, loading, refresh } = useAdminResource<StorageAdmin>(`/admin/storage?page=${page}`);
  const [draft, setDraft] = useState<StoragePolicy | null>(null); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [failure, setFailure] = useState(''); const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [report, setReport] = useState<CleanupReport | null>(null);
  useEffect(() => { if (data && !dirty) setDraft(data.policy); }, [data, dirty]);
  function change(key: keyof StoragePolicy, value: number) { setDirty(true); setDraft(old => old ? { ...old, [key]: value } : old); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return; setBusy(true); setFailure('');
    try { const result = await api<{ policy: StoragePolicy }>('/admin/storage', { method: 'PUT', body: JSON.stringify(draft) }); setDraft(result.policy); setDirty(false); await refresh(); toast('存储限额和保留策略已保存'); }
    catch (e) { setFailure((e as Error).message); } finally { setBusy(false); }
  }
  async function cleanup() {
    setBusy(true); setFailure(''); try { const result = await post<CleanupReport>('/admin/storage/cleanup', { confirm: true }); setReport(result); setConfirmCleanup(false); await refresh(); toast(`清理完成，释放 ${storageBytes(result.reclaimedBytes)}`); }
    catch (e) { setFailure((e as Error).message); } finally { setBusy(false); }
  }
  const fields: { key: keyof StoragePolicy; label: string; min: number; max: number; help: string }[] = [
    { key: 'userLimitMiB', label: '每用户存储限额（MB）', min: 40, max: 1048576, help: '上传图、蒙版、生成结果和回收站均计入；不包含独立离线备份。' },
    { key: 'maxUploadMiB', label: '单张上传上限（MB）', min: 1, max: 20, help: '同时限制上传原文件和重编码后的保存大小。' },
    { key: 'dailyUploadLimit', label: '每用户每日上传次数', min: 1, max: 10000, help: '参考图与蒙版均计数，北京时间每日零点重置。删除文件不返还当日次数。' },
    { key: 'trashRetentionDays', label: '回收站保留天数', min: 1, max: 365, help: '新移入的作品按此期限计算；已有回收站截止时间保持不变。' },
    { key: 'workRetentionDays', label: '作品自动保留天数', min: 0, max: 3650, help: '0 表示不自动过期。大于 0 时，到期的已结算作品先移入回收站；旧作品也受此规则影响。' },
    { key: 'orphanRetentionDays', label: '未使用素材保留天数', min: 1, max: 365, help: '未被作品或任务使用的上传素材，到期后清理；进行中和待核对任务的素材会保留。' },
  ];
  return <section aria-label="存储管理"><div className="section-heading admin-section-heading"><div><h2><HardDrive size={19} />存储与保留策略</h2><p>控制单用户用量、回收站和到期清理。</p></div><AdminRefresh loading={loading} onRefresh={() => { setDirty(false); void refresh(); }} /></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="storage-admin-summary"><div><span>图片已用空间</span><strong>{data ? storageBytes(data.totalBytes) : '—'}</strong></div><div><span>任务预留空间</span><strong>{data ? storageBytes(data.reservedBytes) : '—'}</strong></div><div><span>保存的图片文件</span><strong>{data?.assets.toLocaleString() ?? '—'}</strong></div></div>
    {draft && <form className="admin-panel storage-settings-form" onSubmit={save}><fieldset disabled={busy}><div className="storage-settings-grid">{fields.map(field => <label key={field.key}>{field.label}<input type="number" required min={field.min} max={field.max} step={1} value={draft[field.key]} onChange={e => change(field.key, Number(e.target.value))} /><small>{field.help}</small></label>)}</div><p className="hint">生成前按每张最多 20 MB 预留空间。降低限额不会删除现有文件；超额用户清理出空间前无法继续上传或提交新生成。已开始的模型任务仍会保存产物并正常结算。</p>{draft.workRetentionDays > 0 && <div className="notice">保存后，每小时清理会将超过所填保留天数的旧作品移入回收站。恢复作品后重新计算保留时间。</div>}{failure && <p className="form-error" role="alert">{failure}</p>}<div className="modal-actions"><button className="button primary" disabled={busy || !dirty}><Save size={15} />{busy ? '处理中…' : '保存存储设置'}</button></div></fieldset></form>}
    <div className="storage-cleanup-panel"><div><h3>到期清理</h3><p>每小时执行一次。清理到期回收站与未使用素材，保留被其他作品／任务引用的图片。不会清理独立备份或删除账本。</p>{report && <small>上次：移入回收站 {report.movedToTrash} 项，永久清除 {report.purgedWorks} 项，释放 {storageBytes(report.reclaimedBytes)}，待重试文件 {report.pendingFiles} 个。</small>}</div><button className="button secondary" disabled={busy || !data} onClick={() => { setFailure(''); setConfirmCleanup(true); }}><Trash2 size={15} />立即清理到期内容</button></div>
    <div className="section-heading"><h2>用户存储用量</h2><span>按已用空间排序</span></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th scope="col">用户</th><th scope="col">图片空间</th><th scope="col">任务预留</th><th scope="col">文件数</th></tr></thead><tbody>{data?.users.items.map(user => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td>{storageBytes(user.usedBytes)}</td><td>{storageBytes(user.reservedBytes)}</td><td>{user.assets}</td></tr>)}{!data?.users.items.length && <tr><td colSpan={4} className="admin-empty">{loading ? '正在读取…' : '暂无记录'}</td></tr>}</tbody></table></div><AdminPagination result={data?.users ?? null} loading={loading} onPage={setPage} />
    {confirmCleanup && <Modal title="清理到期内容？" onClose={() => { if (!busy) setConfirmCleanup(false); }}><p className="muted">将按已保存策略永久移除到期回收站中的作品及可安全释放的图片文件，并清理过期未使用素材。仍被其他作品或任务引用的文件会保留，已消费积分不会退回。离线备份不会修改。</p>{failure && <p className="form-error" role="alert">{failure}</p>}<div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmCleanup(false)}>取消</button><button className="button works-danger" disabled={busy} onClick={cleanup}>{busy && <LoaderCircle size={15} className="spin" />}确认执行清理</button></div></Modal>}
  </section>;
}
