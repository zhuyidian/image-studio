import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Ban, Check, ChevronLeft, ChevronRight, Copy, LoaderCircle, RefreshCw, Ticket } from 'lucide-react';
import { api, post } from '../api';
import { Modal } from './Modal';
import type { CreatedVoucher, Voucher, VoucherList, VoucherStatus } from '../../shared/types';
import './vouchers.css';

const statusNames: Record<VoucherStatus | 'all', string> = { all: '全部', unused: '未兑换', redeemed: '已兑换', expired: '已过期', revoked: '已作废' };
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(value));
const voucherNumber = (id: string) => `VC-${id.slice(0, 8).toUpperCase()}`;

export function VoucherManager({ brand, toast }: { brand: string; toast: (message: string) => void }) {
  const [credits, setCredits] = useState('500');
  const [period, setPeriod] = useState('30');
  const [customDays, setCustomDays] = useState('30');
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedVoucher | null>(null);
  const [createError, setCreateError] = useState('');
  const [filter, setFilter] = useState<VoucherStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<VoucherList | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [revoking, setRevoking] = useState<Voucher | null>(null);
  const [reason, setReason] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualCopy, setManualCopy] = useState('');
  const manualInput = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(0);
  const days = Number(period === 'custom' ? customDays : period);
  const amount = Number(credits);
  const valid = Number.isSafeInteger(amount) && amount >= 1 && amount <= 100000 && Number.isSafeInteger(days) && days >= 1 && days <= 365;

  const refresh = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    try {
      const result = await api<VoucherList>(`/admin/vouchers?status=${filter}&page=${page}`);
      if (requestId.current === current) { setList(result); setListError(''); }
    } catch (error) { if (requestId.current === current) setListError((error as Error).message); }
    finally { if (requestId.current === current) setLoading(false); }
  }, [filter, page]);
  useEffect(() => {
    setList(null);
    void refresh();
    const onFocus = () => void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    window.addEventListener('focus', onFocus);
    return () => { ++requestId.current; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  useEffect(() => { if (manualCopy) { manualInput.current?.focus(); manualInput.current?.select(); } }, [manualCopy]);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!valid || creating) return;
    setCreating(true); setCreateError(''); setManualCopy('');
    try {
      const result = await post<CreatedVoucher>('/admin/vouchers', { credits: amount, days, note: note.trim() });
      setCreated(result);
      setFilter('all'); setPage(1);
      if (filter === 'all' && page === 1) await refresh();
      toast('兑换码已生成，请复制保存后发给用户');
    } catch (error) {
      setCreateError(`${(error as Error).message}。如提交时网络中断，请先查看最新记录，避免重复生成。`);
      void refresh();
    } finally { setCreating(false); }
  }
  async function copy(value: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setManualCopy(''); toast(`${label}已复制`);
    } catch { setManualCopy(value); }
  }
  async function revoke(event: FormEvent) {
    event.preventDefault();
    if (!revoking || busy) return;
    setBusy(true); setRevokeError('');
    try {
      await post(`/admin/vouchers/${revoking.id}/revoke`, { reason: reason.trim() });
      setRevoking(null); toast('兑换码已作废，用户无法再兑换'); await refresh();
    } catch (error) { setRevokeError((error as Error).message); void refresh(); }
    finally { setBusy(false); }
  }
  function closeCreated() { setCreated(null); setManualCopy(''); }
  const distributionText = created ? `${brand} 积分兑换码\n兑换码：${created.code}\n可兑换：${created.voucher.credits.toLocaleString()} 积分\n兑换截止：${formatTime(created.voucher.expiresAt)}（北京时间）\n使用规则：整张码仅能成功兑换一次；到账积分不随兑换码到期而失效。\n兑换入口：${created.redemptionUrl}\n登录后进入“积分与补给”，输入兑换码即可。` : '';

  return <section className="voucher-manager" aria-label="兑换码管理">
    <div className="section-heading voucher-heading"><div><h2><Ticket size={20} />兑换码管理</h2><p>生成积分补给、查看兑换记录、管理尚未使用的兑换码。</p></div><span>时间均为北京时间</span></div>
    <form className="admin-panel voucher-form" onSubmit={generate}>
      <div className="voucher-form-heading"><h3>生成一次性兑换码</h3><span className="voucher-once"><Check size={13} />每张仅能兑换一次</span></div>
      <fieldset disabled={creating} className="voucher-fields">
        <div className="voucher-field"><label htmlFor="voucher-credits">积分数量</label><div className="voucher-presets">{[100, 500, 1000].map(value => <button className={`chip ${amount === value ? 'active' : ''}`} key={value} type="button" aria-pressed={amount === value} onClick={() => setCredits(String(value))}>{value.toLocaleString()} 积分</button>)}</div><div className="voucher-input-unit"><input id="voucher-credits" type="number" min={1} max={100000} step={1} required value={credits} onChange={event => setCredits(event.target.value)} /><span>积分</span></div><small>也可自定义，范围 1–100,000 积分。</small></div>
        <div className="voucher-field"><label htmlFor="voucher-period">兑换有效期</label><select id="voucher-period" value={period} onChange={event => setPeriod(event.target.value)}><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="custom">自定义天数</option></select>{period === 'custom' && <div className="voucher-input-unit"><input aria-label="自定义有效天数" type="number" min={1} max={365} step={1} required value={customDays} onChange={event => setCustomDays(event.target.value)} /><span>天</span></div>}<small>从生成时开始计时，自定义范围 1–365 天。</small></div>
        <div className="voucher-field voucher-note-field"><label htmlFor="voucher-note">内部备注<span>可选，仅管理员可见</span></label><input id="voucher-note" value={note} maxLength={300} onChange={event => setNote(event.target.value)} placeholder="例如：活动赠送、用户补偿、客户订单编号" /></div>
      </fieldset>
      <div className="voucher-generation-footer"><div><p>{valid ? <><strong>{amount.toLocaleString()} 积分</strong><span> · 生成后 {days} 天内有效 · 仅能兑换一次</span></> : '请填写有效的积分数量和天数'}</p><small>有效期限制兑换时间；兑换到账后的积分不随兑换码到期而失效。</small></div><button className="button primary" type="submit" disabled={creating || !valid}>{creating ? <LoaderCircle size={16} className="spin" /> : <Ticket size={16} />}{creating ? '正在生成…' : '生成兑换码'}</button></div>
      {createError && <p className="form-error" role="alert">{createError}</p>}
    </form>

    <div className="section-heading voucher-history-heading"><h3>兑换码记录</h3><button className="text-button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={13} className={loading ? 'spin' : ''} />刷新记录</button></div>
    <div className="voucher-filters" role="group" aria-label="按兑换码状态筛选">{(Object.keys(statusNames) as (VoucherStatus | 'all')[]).map(status => <button type="button" key={status} className={`chip ${status === filter ? 'active' : ''}`} aria-pressed={status === filter} onClick={() => { setList(null); setFilter(status); setPage(1); }}>{statusNames[status]}{list && <span>{list.counts[status]}</span>}</button>)}</div>
    {listError && <p className="form-error" role="alert">{listError}</p>}
    <div className="voucher-table-shell" aria-busy={loading}>
      <table className="voucher-table"><caption className="visually-hidden">兑换码历史记录，时间均为北京时间</caption><thead><tr><th scope="col">编号 / 尾号</th><th scope="col">积分 / 状态</th><th scope="col">创建 / 截止时间</th><th scope="col">创建人 / 内部备注</th><th scope="col">兑换或作废记录</th><th scope="col">操作</th></tr></thead><tbody>
        {list?.vouchers.map(voucher => <tr key={voucher.id}>
          <td><strong className="voucher-number" title={voucher.id}>{voucherNumber(voucher.id)}</strong><small>{voucher.suffix ? `IMG-····${voucher.suffix}` : '历史兑换码 · 尾号不可恢复'}</small></td>
          <td><strong>{voucher.credits.toLocaleString()} 积分</strong><span className={`voucher-status ${voucher.status}`}>{statusNames[voucher.status]}</span></td>
          <td><time dateTime={voucher.createdAt}>{formatTime(voucher.createdAt)}</time><small>截止 {formatTime(voucher.expiresAt)}</small></td>
          <td><span>{voucher.createdBy?.name ?? '命令行 / 历史记录'}</span>{voucher.createdBy && <small>{voucher.createdBy.email}</small>}<p className="voucher-internal-note">{voucher.note || '无备注'}</p></td>
          <td>{voucher.redeemedBy ? <><span>{voucher.redeemedBy.name}</span><small>{voucher.redeemedBy.email}</small><small>{formatTime(voucher.redeemedAt!)}</small></> : voucher.revokedAt ? <><span>{voucher.revokedBy?.name ?? '管理员'} 已作废</span><small>{formatTime(voucher.revokedAt)}</small></> : <span className="muted">{voucher.status === 'expired' ? '有效期已结束' : '等待用户兑换'}</span>}</td>
          <td>{voucher.status === 'unused' ? <button className="text-button voucher-revoke-button" onClick={() => { setRevoking(voucher); setReason(''); setRevokeError(''); }}><Ban size={13} />作废</button> : <span className="muted">—</span>}</td>
        </tr>)}
        {!list?.vouchers.length && <tr><td colSpan={6} className="voucher-empty">{loading ? '正在加载兑换码记录…' : listError ? '记录加载失败，请点击刷新重试。' : filter === 'all' ? '还没有兑换码，可以从上方生成第一张。' : `暂无${statusNames[filter]}的兑换码。`}</td></tr>}
      </tbody></table>
    </div>
    <div className="voucher-pagination"><span>共 {list?.total ?? 0} 条记录 · 每页 20 条</span><div><button className="icon-button" aria-label="上一页兑换码" disabled={loading || !list || list.page <= 1} onClick={() => setPage((list?.page ?? 1) - 1)}><ChevronLeft size={17} /></button><span>第 {list?.page ?? 1} / {Math.max(1, Math.ceil((list?.total ?? 0) / 20))} 页</span><button className="icon-button" aria-label="下一页兑换码" disabled={loading || !list || list.page * list.pageSize >= list.total} onClick={() => setPage((list?.page ?? 1) + 1)}><ChevronRight size={17} /></button></div></div>
    <p className="hint">完整兑换码只在生成成功时展示。历史记录不保存明文；如遗失未兑换的码，可作废后重新生成。作废不会撤回已到账积分。</p>

    {created && <Modal title="兑换码已生成" onClose={closeCreated} wide>
      <div className="voucher-success-heading"><span><Check size={23} /></span><div><h3>{created.voucher.credits.toLocaleString()} 积分 · 仅能兑换一次</h3><p>截止 {formatTime(created.voucher.expiresAt)}（北京时间）</p></div></div>
      <label className="voucher-code-label" htmlFor="new-voucher-code">完整兑换码</label><input id="new-voucher-code" className="voucher-code-input" readOnly value={created.code} onFocus={event => event.target.select()} />
      <p className="voucher-secret-note">请现在复制保存。关闭此窗口或离开页面后，将无法再次查看完整兑换码。</p>
      <div className="voucher-copy-actions"><button className="button secondary" onClick={() => void copy(created.code, '兑换码')}><Copy size={15} />复制兑换码</button><button className="button primary" onClick={() => void copy(distributionText, '完整发放说明')}><Copy size={15} />复制完整说明</button></div>
      <details className="voucher-share-preview"><summary>预览发给用户的完整说明</summary><pre>{distributionText}</pre></details>
      {manualCopy && <div className="voucher-manual-copy"><p role="status">浏览器未允许自动复制，请手动复制下面已选中的文字。</p><textarea ref={manualInput} aria-label="手动复制内容" readOnly rows={6} value={manualCopy} onFocus={event => event.target.select()} /></div>}
      <p className="hint">编号 {voucherNumber(created.voucher.id)} · 兑换成功后积分立即到账，不随兑换码有效期结束而失效。</p>
      <div className="modal-actions"><button className="button secondary" onClick={closeCreated}>关闭窗口</button></div>
    </Modal>}
    {revoking && <Modal title="作废这张兑换码？" onClose={() => { if (!busy) setRevoking(null); }}><form onSubmit={revoke}>
      <div className="voucher-revoke-summary"><strong>{voucherNumber(revoking.id)} · {revoking.credits.toLocaleString()} 积分</strong><span>{revoking.suffix ? `尾号 ${revoking.suffix}` : '历史兑换码'}</span></div>
      <p className="muted">作废后此码将无法兑换，也无法恢复。若用户已先完成兑换，系统会拒绝作废并保留到账积分。</p>
      <label className="voucher-code-label" htmlFor="voucher-revoke-reason">作废原因</label><textarea id="voucher-revoke-reason" value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：兑换码遗失，准备重新发放" minLength={2} maxLength={300} required disabled={busy} />
      {revokeError && <p className="form-error" role="alert">{revokeError}</p>}
      <div className="modal-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => setRevoking(null)}>保留兑换码</button><button className="button voucher-danger" disabled={busy || reason.trim().length < 2}>{busy ? <LoaderCircle size={15} className="spin" /> : <Ban size={15} />}{busy ? '正在作废…' : '确认作废'}</button></div>
    </form></Modal>}
  </section>;
}
