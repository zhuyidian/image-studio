import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, Coins, Gift, LoaderCircle, ShieldCheck, Ticket } from 'lucide-react';
import { api, post } from '../api';
import { Modal } from './Modal';
import type { LedgerEntry, Package, PublicConfig, User } from '../../shared/types';

const formatDate = (date: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));
export function Wallet({ config, user, onUser, onLogin, toast }: { config: PublicConfig; user: User | null; onUser: (u: User) => void; onLogin: () => void; toast: (s: string) => void }) {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]); const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false); const [selected, setSelected] = useState<Package | null>(null);
  const [method, setMethod] = useState<'alipay' | 'wxpay'>('wxpay'); const [error, setError] = useState('');
  const refresh = async () => { if (!user) return; try { const r = await api<{ user: User; ledger: LedgerEntry[] }>('/wallet'); setLedger(r.ledger); onUser(r.user); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void refresh(); }, [user?.id]);
  useEffect(() => {
    const orderId = new URLSearchParams(location.search).get('order');
    if (!user || !orderId) return;
    let disposed = false; let attempts = 0;
    const check = async () => {
      try { const r = await api<{ order: { status: string } }>(`/payments/orders/${encodeURIComponent(orderId)}`); if (!disposed && r.order.status === 'paid') { toast('支付已确认，积分已到账'); await refresh(); history.replaceState({}, '', '/?page=wallet'); clearInterval(timer); } }
      catch (e) { if (!disposed) setError((e as Error).message); clearInterval(timer); }
      if (++attempts >= 30) clearInterval(timer);
    };
    const timer = setInterval(() => void check(), 3000); void check();
    return () => { disposed = true; clearInterval(timer); };
  }, [user?.id]);
  async function redeem(e: FormEvent) {
    e.preventDefault(); if (!user) { onLogin(); return; } setBusy(true); setError('');
    try { const r = await post<{ user: User }>('/wallet/redeem', { code }); onUser(r.user); setCode(''); toast('兑换成功，积分已到账'); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function pay() {
    if (!selected) return; setBusy(true); setError('');
    try { const r = await post<{ checkoutUrl: string }>('/payments/orders', { packageId: selected.id, method }); location.assign(r.checkoutUrl); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <section className="page-content wallet-page">
    <div className="page-heading"><span className="eyebrow">YOUR CREATIVE ENERGY</span><h1>为好灵感，补充一点能量。</h1><p>积分按实际交付的图片结算，明确失败的任务自动退回。</p></div>
    <div className="balance-panel"><div><span>可用积分</span><strong>{user ? user.credits.toLocaleString() : '—'}<small>积分</small></strong></div><div className="frozen"><span>任务冻结中</span><strong>{user?.frozen ?? 0}<small>积分</small></strong></div><Coins size={78} strokeWidth={.8} /></div>
    <div className="section-heading"><h2>选择你的灵感补给</h2><span>一次购买 · 按需使用</span></div>
    {!config.paymentEnabled && <div className="notice"><ShieldCheck size={18} /><span>在线支付暂未开放，当前可使用积分兑换码。</span></div>}
    <div className="packages">{config.packages.map((pack, i) => <article className={`package ${i === 1 ? 'featured' : ''}`} key={pack.id}>{i === 1 && <span className="recommended">创作者之选</span>}<span>{pack.name}</span><h3>{pack.credits.toLocaleString()}<small>积分</small></h3><p>{pack.subtitle}</p><strong className="package-price">¥{(pack.cents / 100).toFixed(1)}</strong><button className={`button ${i === 1 ? 'primary' : 'secondary'} full`} disabled={!config.paymentEnabled} onClick={() => { if (!user) onLogin(); else setSelected(pack); }}>{config.paymentEnabled ? '购买积分' : '暂未开放'}</button></article>)}</div>
    <div className="redeem-panel"><div className="redeem-copy"><Ticket size={23} /><div><h3>有一张积分兑换码？</h3><p>请在截止时间前兑换，每张仅限一次；到账积分不随兑换码到期而失效。</p></div></div><form onSubmit={redeem}><input aria-label="积分兑换码" placeholder="输入你的兑换码" value={code} onChange={e => setCode(e.target.value)} required minLength={8} maxLength={100} /><button className="button secondary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Gift size={16} />}兑换</button></form></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="section-heading"><h2>积分记录</h2><span>最近 100 笔 · 北京时间</span></div>
    <div className="ledger">{ledger.length ? ledger.map(item => <div className="ledger-row" key={item.id}><span className={`ledger-icon ${item.delta >= 0 ? 'positive' : ''}`}>{item.delta >= 0 ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span><div><strong>{item.note}</strong><small>{formatDate(item.createdAt)}{item.frozenDelta !== 0 ? ` · 冻结${item.frozenDelta > 0 ? '+' : ''}${item.frozenDelta}` : ''}</small></div><b className={item.delta > 0 ? 'positive-text' : ''}>{item.delta > 0 ? '+' : ''}{item.delta}</b></div>) : <div className="empty-small">{user ? '还没有积分记录，创作会从这里开始。' : '登录后查看你的积分记录。'}</div>}</div>
    {selected && <Modal title="确认积分补给" onClose={() => { if (!busy) setSelected(null); }}><div className="checkout-summary"><span>{selected.name} · {selected.credits} 积分</span><strong>¥{(selected.cents / 100).toFixed(2)}</strong></div><p className="muted">选择支付方式后，将前往支付商收银台。</p><div className="payment-methods"><button className={`method ${method === 'wxpay' ? 'chosen' : ''}`} onClick={() => setMethod('wxpay')}><span className="wechat-symbol">微</span>微信支付{method === 'wxpay' && <Check size={17} />}</button><button className={`method ${method === 'alipay' ? 'chosen' : ''}`} onClick={() => setMethod('alipay')}><span className="alipay-symbol">支</span>支付宝{method === 'alipay' && <Check size={17} />}</button></div>{error && <p className="form-error">{error}</p>}<button className="button primary full" disabled={busy} onClick={pay}>{busy ? '正在创建订单…' : '前往支付'}</button><p className="hint">到账以服务端支付确认为准，返回页面不会直接增加积分。</p></Modal>}
  </section>;
}
