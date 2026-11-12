import { useState } from 'react';
import type { AdminTask, AdminUserDetail, LedgerEntry, PageResult, Voucher } from '../../../shared/types';
import { Modal } from '../Modal';
import { useAdminResource } from './useAdminResource';
import { AdminPagination, AdminRefresh, adminTime, TaskBadge } from './AdminControls';

type RecordTab = 'ledger' | 'vouchers' | 'tasks';
const tabs: { id: RecordTab; label: string }[] = [{ id: 'ledger', label: '积分流水' }, { id: 'vouchers', label: '兑换记录' }, { id: 'tasks', label: '任务记录' }];
export function UserDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading, refresh } = useAdminResource<AdminUserDetail>(`/admin/users/${id}`);
  const [tab, setTab] = useState<RecordTab>('ledger'); const [recordVersion, setRecordVersion] = useState(0);
  return <Modal title="用户详情" wide onClose={onClose}>
    {error && <p className="form-error" role="alert">{error}</p>}
    {data ? <>
      <div className="admin-profile"><span className="admin-profile-avatar">{data.user.name.slice(0, 1)}</span><div><h3>{data.user.name}<span className={`admin-role ${data.user.role}`}>{data.user.role === 'admin' ? '管理员' : '普通用户'}</span></h3><p>{data.user.email}</p><small className="admin-mono">{data.user.id}</small></div><AdminRefresh loading={loading} onRefresh={() => { void refresh(); setRecordVersion(v => v + 1); }} /></div>
      <p className="admin-profile-date">注册于 {adminTime(data.user.createdAt)}（北京时间）</p>
      <div className="admin-detail-stats"><div><span>可用积分</span><strong>{data.user.credits.toLocaleString()}</strong></div><div><span>冻结积分</span><strong>{data.user.frozen.toLocaleString()}</strong></div><div><span>累计任务</span><strong>{data.stats.totalTasks.toLocaleString()}</strong></div><div><span>已结算积分</span><strong>{data.stats.chargedCredits.toLocaleString()}</strong></div></div>
      <div className="admin-record-tabs" role="group" aria-label="用户记录类型">{tabs.map(item => <button className={tab === item.id ? 'selected' : ''} aria-pressed={tab === item.id} key={item.id} onClick={() => setTab(item.id)}>{item.label}<span>{item.id === 'ledger' ? data.stats.ledgerEntries : item.id === 'vouchers' ? data.stats.redeemedVouchers : data.stats.totalTasks}</span></button>)}</div>
      <UserRecords key={`${id}:${tab}:${recordVersion}`} userId={id} tab={tab} />
    </> : <div className="empty-small">{loading ? '正在加载用户详情…' : '无法读取此用户。'}</div>}
  </Modal>;
}
function UserRecords({ userId, tab }: { userId: string; tab: RecordTab }) {
  const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useAdminResource<PageResult<LedgerEntry | Voucher | AdminTask>>(`/admin/users/${userId}/${tab}?page=${page}`);
  const columns = tab === 'ledger' ? 4 : tab === 'vouchers' ? 3 : 4;
  return <div className="admin-user-records">
    <div className="admin-record-toolbar"><span>{tab === 'ledger' ? '可用余额变化与冻结变化分别记录，冻结不代表最终消费。' : tab === 'vouchers' ? '仅展示该用户成功兑换的记录。' : '查看任务状态、生成参数和积分结算情况。'}</span><AdminRefresh loading={loading} onRefresh={() => void refresh()} /></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="admin-table-wrap" aria-busy={loading}><table className="admin-table detail-table"><caption className="visually-hidden">用户{tabs.find(t => t.id === tab)?.label}</caption>
      <thead><tr>{(tab === 'ledger' ? ['记录与说明', '可用变化', '冻结变化', '时间'] : tab === 'vouchers' ? ['编号 / 尾号', '到账积分', '兑换时间'] : ['任务', '状态 / 参数', '积分', '时间']).map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{tab === 'ledger' && (data?.items as LedgerEntry[] | undefined)?.map(item => <tr key={item.id}><td><strong>{item.note}</strong>{item.taskId && <small className="admin-mono">任务 {item.taskId}</small>}</td><td className={item.delta > 0 ? 'admin-credit-positive' : ''}>{item.delta > 0 ? '+' : ''}{item.delta.toLocaleString()}</td><td>{item.frozenDelta > 0 ? '+' : ''}{item.frozenDelta.toLocaleString()}</td><td>{adminTime(item.createdAt)}</td></tr>)}
        {tab === 'vouchers' && (data?.items as Voucher[] | undefined)?.map(item => <tr key={item.id}><td><strong className="admin-mono">VC-{item.id.slice(0, 8).toUpperCase()}</strong><small>{item.suffix ? `尾号 ${item.suffix}` : '历史兑换码'}</small><small>{item.note || '无内部备注'}</small></td><td className="admin-credit-positive">+{item.credits.toLocaleString()}</td><td>{adminTime(item.redeemedAt)}</td></tr>)}
        {tab === 'tasks' && (data?.items as AdminTask[] | undefined)?.map(item => <tr key={item.id}><td><p className="admin-record-prompt">{item.prompt}</p><small className="admin-mono">{item.id}</small>{item.error && <small className="admin-task-error">{item.error}</small>}</td><td><TaskBadge status={item.status} />{item.isTest && <span className="admin-status">模型测试</span>}<small>{item.modelName}</small><small>{item.size} · {item.count} 张 · {item.quality === 'high' ? '精细' : '标准'}</small></td><td><strong>已结算 {item.charged}</strong><small>提交冻结 {item.reserved}</small></td><td>{adminTime(item.createdAt)}{item.finishedAt && <small>完成 {adminTime(item.finishedAt)}</small>}</td></tr>)}
        {!data?.items.length && <tr><td colSpan={columns} className="admin-empty">{loading ? '正在加载记录…' : error ? '记录加载失败，请刷新重试。' : '暂无记录。'}</td></tr>}
      </tbody></table></div>
    <AdminPagination result={data} loading={loading} onPage={setPage} />
  </div>;
}
