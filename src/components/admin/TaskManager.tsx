import { useState, type FormEvent } from 'react';
import { ClipboardList, LoaderCircle, Search } from 'lucide-react';
import type { AdminTask, PageResult, TaskStatus } from '../../../shared/types';
import { post } from '../../api';
import { Modal } from '../Modal';
import { useAdminResource } from './useAdminResource';
import { AdminPagination, AdminRefresh, adminTime, taskStatusNames, TaskBadge } from './AdminControls';

export function TaskManager({ initialStatus = 'all', onUser, onChanged, toast }: { initialStatus?: TaskStatus | 'all'; onUser: (id: string) => void; onChanged: () => void; toast: (text: string) => void }) {
  const [status, setStatus] = useState<TaskStatus | 'all'>(initialStatus);
  const [page, setPage] = useState(1); const [input, setInput] = useState(''); const [query, setQuery] = useState('');
  const [target, setTarget] = useState<AdminTask | null>(null); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [releaseError, setReleaseError] = useState('');
  const { data, error, loading, refresh } = useAdminResource<PageResult<AdminTask>>(`/admin/tasks?${new URLSearchParams({ status, q: query, page: String(page) })}`);
  function search(event: FormEvent) { event.preventDefault(); setQuery(input.trim()); setPage(1); if (query === input.trim() && page === 1) void refresh(); }
  async function release(event: FormEvent) {
    event.preventDefault(); if (!target || busy) return;
    setBusy(true); setReleaseError('');
    try { await post(`/admin/tasks/${target.id}/release`, { reason: reason.trim() }); setTarget(null); toast('核对记录已保存，冻结积分已退回'); await refresh(); onChanged(); }
    catch (error) { setReleaseError((error as Error).message); void refresh(); }
    finally { setBusy(false); }
  }
  return <section aria-label="任务管理"><div className="section-heading admin-section-heading"><div><h2><ClipboardList size={19} />任务管理</h2><p>查看全站任务，结果待确认的任务需人工核对后处理。</p></div><AdminRefresh loading={loading} onRefresh={() => void refresh()} /></div>
    <div className="admin-toolbar"><form className="admin-search" onSubmit={search}><label className="admin-search-input"><Search size={16} /><input aria-label="搜索任务" placeholder="任务 ID、提示词、用户邮箱或昵称" value={input} maxLength={254} onChange={e => setInput(e.target.value)} /></label><button className="button secondary small" disabled={loading}>搜索</button>{query && <button className="text-button" type="button" onClick={() => { setInput(''); setQuery(''); setPage(1); }}>清除</button>}</form><label className="admin-role-select">状态<select aria-label="按任务状态筛选" value={status} onChange={e => { setStatus(e.target.value as TaskStatus | 'all'); setPage(1); }}><option value="all">全部状态</option>{(Object.keys(taskStatusNames) as TaskStatus[]).map(value => <option value={value} key={value}>{taskStatusNames[value]}</option>)}</select></label></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="admin-table-wrap" aria-busy={loading}><table className="admin-table tasks-table"><caption className="visually-hidden">全站图片任务</caption><thead><tr><th scope="col">任务 / 用户</th><th scope="col">状态 / 参数</th><th scope="col">积分</th><th scope="col">创建时间</th><th scope="col">操作</th></tr></thead><tbody>
      {data?.items.map(task => <tr key={task.id}><td><p className="admin-record-prompt">{task.prompt}</p><small className="admin-mono">{task.id}</small><button className="admin-user-link" onClick={() => onUser(task.user.id)}>{task.user.name}</button><small>{task.user.email}</small></td><td><TaskBadge status={task.status} />{task.isTest && <span className="admin-status">管理员模型测试</span>}<small>{task.modelName} · {task.provider === 'mock' ? '本地演示' : '模型调用'}</small><small>{task.size} · {task.count} 张</small>{task.error && <small className="admin-task-error">{task.error}</small>}</td><td><strong>已结算 {task.charged}</strong><small>提交冻结 {task.reserved}</small></td><td>{adminTime(task.createdAt)}</td><td>{task.status === 'uncertain' ? <button className="text-button" onClick={() => { setTarget(task); setReason(''); setReleaseError(''); }}>核对处理</button> : <span className="muted">—</span>}</td></tr>)}
      {!data?.items.length && <tr><td colSpan={5} className="admin-empty">{loading ? '正在加载任务…' : error ? '任务加载失败，请刷新重试。' : '没有匹配的任务。'}</td></tr>}
    </tbody></table></div><AdminPagination result={data} loading={loading} onPage={setPage} />
    {target && <Modal title="核对后释放冻结积分" onClose={() => { if (!busy) setTarget(null); }}><form onSubmit={release}>
      <div className="admin-release-summary"><strong>{target.user.name} · {target.reserved} 冻结积分</strong><p>{target.prompt}</p><small className="admin-mono">{target.id}</small></div><p className="muted">请先到 New API 核对调用与产物。仅在确认没有可交付图片后释放；此操作不会退回上游费用。</p>
      <label className="admin-reason-label" htmlFor="task-release-reason">核对过程与结论</label><textarea id="task-release-reason" value={reason} minLength={10} maxLength={300} required onChange={e => setReason(e.target.value)} placeholder="至少 10 个字符，填写核对结果" disabled={busy} />
      {releaseError && <p className="form-error" role="alert">{releaseError}</p>}<div className="modal-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => setTarget(null)}>取消</button><button className="button primary" disabled={busy || reason.trim().length < 10}>{busy && <LoaderCircle size={15} className="spin" />}确认未交付并退回积分</button></div>
    </form></Modal>}
  </section>;
}
