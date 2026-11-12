import { useEffect, useState } from 'react';
import { ArrowRight, ClipboardList, Cpu, HardDrive, LayoutDashboard, Mail, Ticket, Users } from 'lucide-react';
import type { AdminOverview } from '../../shared/types';
import { VoucherManager } from './VoucherManager';
import { UserManager } from './admin/UserManager';
import { UserDetail } from './admin/UserDetail';
import { TaskManager } from './admin/TaskManager';
import { ModelManager } from './admin/ModelManager';
import { AccountSettings } from './admin/AccountSettings';
import { StorageSettings } from './admin/StorageSettings';
import { useAdminResource } from './admin/useAdminResource';
import { AdminRefresh, adminTime } from './admin/AdminControls';
import './admin/admin.css';

type AdminTab = 'overview' | 'users' | 'vouchers' | 'tasks' | 'models' | 'accounts' | 'storage';
const tabs = [{ id: 'overview', label: '概览', icon: LayoutDashboard }, { id: 'users', label: '用户管理', icon: Users }, { id: 'models', label: '模型管理', icon: Cpu }, { id: 'vouchers', label: '兑换码管理', icon: Ticket }, { id: 'tasks', label: '任务管理', icon: ClipboardList }, { id: 'accounts', label: '注册与邮箱', icon: Mail }, { id: 'storage', label: '存储管理', icon: HardDrive }] as const;
function currentTab(): AdminTab {
  const value = new URLSearchParams(location.search).get('adminTab');
  return tabs.some(tab => tab.id === value) ? value as AdminTab : 'overview';
}
export function Admin({ brand, toast, onModelsChanged }: { brand: string; toast: (text: string) => void; onModelsChanged: () => void }) {
  const [tab, setTab] = useState<AdminTab>(currentTab);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [usersVersion, setUsersVersion] = useState(0);
  const [taskStatus, setTaskStatus] = useState<'all' | 'uncertain'>('all');
  const { data, error, loading, refresh } = useAdminResource<AdminOverview>('/admin');
  useEffect(() => { const onPop = () => { setTab(currentTab()); setSelectedUser(null); }; window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  function navigate(next: AdminTab, uncertain = false) {
    setTab(next); setSelectedUser(null);
    if (next === 'tasks') { setTaskStatus(uncertain ? 'uncertain' : 'all'); setTasksVersion(v => v + 1); }
    const url = new URL(location.href); url.searchParams.set('page', 'admin'); url.searchParams.set('adminTab', next); history.pushState({}, '', url);
  }
  return <section className="page-content admin-page">
    <div className="page-heading"><span className="eyebrow">STUDIO OPERATIONS</span><h1>运营工作台</h1><p>查看全站用户、管理积分发放与图片任务。</p></div>
    <nav className="admin-nav" aria-label="后台栏目">{tabs.map(item => <button className={tab === item.id ? 'selected' : ''} aria-current={tab === item.id ? 'page' : undefined} key={item.id} onClick={() => navigate(item.id)}><item.icon size={17} />{item.label}</button>)}</nav>
    {tab === 'overview' && <section aria-label="运营概览"><div className="section-heading admin-section-heading"><div><h2>全站概览</h2><p>统计所有账户与任务，不受列表分页限制。</p></div><AdminRefresh loading={loading} onRefresh={() => void refresh()} /></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="admin-overview-stats"><button onClick={() => navigate('users')}><span>账户总数</span><strong>{data?.totalUsers.toLocaleString() ?? '—'}</strong><small>含 {data?.totalAdmins ?? '—'} 位管理员</small><Users size={21} /></button><button onClick={() => navigate('tasks')}><span>累计任务</span><strong>{data?.totalTasks.toLocaleString() ?? '—'}</strong><small>所有图片任务</small><ClipboardList size={21} /></button><button onClick={() => navigate('tasks', true)}><span>结果待核对</span><strong>{data?.uncertainTasks.toLocaleString() ?? '—'}</strong><small>点击查看待处理任务</small><ArrowRight size={21} /></button><div><span>订单总数</span><strong>{data?.totalOrders.toLocaleString() ?? '—'}</strong><small>已支付 {data?.paidOrders ?? '—'} 笔</small></div></div>
      <div className="admin-credit-summary"><span>全站可用积分 <strong>{data?.totalAvailableCredits.toLocaleString() ?? '—'}</strong></span><span>任务冻结积分 <strong>{data?.totalFrozenCredits.toLocaleString() ?? '—'}</strong></span></div>
      <div className="section-heading"><h2>最新注册</h2><button className="text-button" onClick={() => navigate('users')}>查看全部用户<ArrowRight size={14} /></button></div>
      <div className="admin-table-wrap"><table className="admin-table recent-users-table"><thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">注册时间（北京时间）</th><th scope="col">操作</th></tr></thead><tbody>{data?.recentUsers.map(user => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td><span className={`admin-role ${user.role}`}>{user.role === 'admin' ? '管理员' : '普通用户'}</span></td><td>{adminTime(user.createdAt)}</td><td><button className="text-button" onClick={() => setSelectedUser(user.id)}>查看详情</button></td></tr>)}{!data?.recentUsers.length && <tr><td colSpan={4} className="admin-empty">{loading ? '正在加载…' : error ? '加载失败，请刷新重试。' : '暂无用户。'}</td></tr>}</tbody></table></div>
    </section>}
    {tab === 'users' && <UserManager key={usersVersion} onSelect={setSelectedUser} />}
    {tab === 'models' && <ModelManager toast={toast} onChanged={onModelsChanged} />}
    {tab === 'accounts' && <AccountSettings toast={toast} onChanged={onModelsChanged} />}
    {tab === 'storage' && <StorageSettings toast={toast} />}
    {tab === 'vouchers' && <VoucherManager brand={brand} toast={toast} />}
    {tab === 'tasks' && <TaskManager key={tasksVersion} initialStatus={taskStatus} onUser={setSelectedUser} onChanged={() => void refresh()} toast={toast} />}
    {selectedUser && <UserDetail key={selectedUser} id={selectedUser} onClose={() => setSelectedUser(null)} onChanged={() => { setUsersVersion(v => v + 1); void refresh(); }} toast={toast} />}
  </section>;
}
