import { useState, type FormEvent } from 'react';
import { Search, Users } from 'lucide-react';
import type { AdminUser, PageResult } from '../../../shared/types';
import { useAdminResource } from './useAdminResource';
import { AdminPagination, AdminRefresh, adminTime } from './AdminControls';

export function UserManager({ onSelect }: { onSelect: (id: string) => void }) {
  const [input, setInput] = useState(''); const [query, setQuery] = useState('');
  const [role, setRole] = useState('all'); const [status, setStatus] = useState('all'); const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useAdminResource<PageResult<AdminUser>>(`/admin/users?${new URLSearchParams({ q: query, role, status, page: String(page) })}`);
  function search(event: FormEvent) { event.preventDefault(); setQuery(input.trim()); setPage(1); if (query === input.trim() && page === 1) void refresh(); }
  return <section aria-label="用户管理">
    <div className="section-heading admin-section-heading"><div><h2><Users size={19} />全部用户</h2><p>分页覆盖所有账户，包含管理员；时间为北京时间。</p></div><AdminRefresh loading={loading} onRefresh={() => void refresh()} /></div>
    <div className="admin-toolbar"><form className="admin-search" onSubmit={search}><label className="admin-search-input"><Search size={16} /><input aria-label="搜索用户" placeholder="邮箱、昵称或用户 ID" maxLength={254} value={input} onChange={event => setInput(event.target.value)} /></label><button className="button secondary small" type="submit" disabled={loading}>搜索</button>{query && <button className="text-button" type="button" onClick={() => { setInput(''); setQuery(''); setPage(1); }}>清除</button>}</form><label className="admin-role-select">角色<select aria-label="按用户角色筛选" value={role} onChange={event => { setRole(event.target.value); setPage(1); }}><option value="all">全部角色</option><option value="user">普通用户</option><option value="admin">管理员</option></select></label></div>
    <div className="admin-toolbar"><label className="admin-role-select">账户状态<select aria-label="按账户状态筛选" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="all">全部状态</option><option value="active">正常</option><option value="disabled">已禁用</option></select></label></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="admin-table-wrap" aria-busy={loading}><table className="admin-table users-table"><caption className="visually-hidden">全部注册用户，每页 20 位</caption><thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">可用 / 冻结积分</th><th scope="col">注册时间</th><th scope="col">操作</th></tr></thead><tbody>
      {data?.items.map(user => <tr key={user.id}><td><button className="admin-user-link" onClick={() => onSelect(user.id)}>{user.name}</button><small>{user.email}</small><small className="admin-mono admin-user-id">{user.id}</small></td><td><span className={`admin-role ${user.role}`}>{user.role === 'admin' ? '管理员' : '普通用户'}</span><small><span className={user.status === 'disabled' ? 'admin-role account-disabled-tag' : 'admin-role'}>{user.status === 'disabled' ? '已禁用' : '正常'}</span></small><small>{user.emailVerified ? '邮箱已验证' : '邮箱未验证'}</small></td><td><strong>{user.credits.toLocaleString()} 可用</strong><small>{user.frozen.toLocaleString()} 冻结</small></td><td><time dateTime={user.createdAt}>{adminTime(user.createdAt)}</time></td><td><button className="text-button" onClick={() => onSelect(user.id)}>查看详情</button></td></tr>)}
      {!data?.items.length && <tr><td colSpan={5} className="admin-empty">{loading ? '正在加载用户…' : error ? '用户加载失败，请刷新重试。' : query || role !== 'all' || status !== 'all' ? '没有匹配的用户，请调整搜索条件。' : '还没有注册用户。'}</td></tr>}
    </tbody></table></div>
    <AdminPagination result={data} loading={loading} onPage={setPage} />
  </section>;
}
