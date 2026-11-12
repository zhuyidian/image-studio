import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { PageResult, TaskStatus } from '../../../shared/types';

export const adminTime = (date: string | null) => date ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date)) : '—';
export const taskStatusNames: Record<TaskStatus, string> = { queued: '等待开始', running: '正在创作', succeeded: '已完成', partial: '部分完成', failed: '失败', uncertain: '待核对' };
export function TaskBadge({ status }: { status: TaskStatus }) { return <span className={`admin-status ${status}`}>{taskStatusNames[status]}</span>; }
export function AdminRefresh({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return <button className="text-button" disabled={loading} onClick={onRefresh}><RefreshCw size={13} className={loading ? 'spin' : ''} />刷新</button>;
}
export function AdminPagination({ result, loading, onPage }: { result: Pick<PageResult<unknown>, 'page' | 'pageSize' | 'total'> | null; loading: boolean; onPage: (page: number) => void }) {
  const page = result?.page ?? 1; const pages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 20)));
  return <div className="admin-pagination"><span>共 {result?.total.toLocaleString() ?? '—'} 条 · 每页 20 条</span><div><button className="icon-button" aria-label="上一页" disabled={loading || !result || page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={17} /></button><span>第 {page} / {pages} 页</span><button className="icon-button" aria-label="下一页" disabled={loading || !result || page >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={17} /></button></div></div>;
}
