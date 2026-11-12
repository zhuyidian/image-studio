import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle, MailCheck } from 'lucide-react';
import { Modal } from './Modal';
import { post } from '../api';
import type { User } from '../../shared/types';
import './accounts.css';

export function PasswordResetModal({ token, onClose, onSuccess }: { token: string; onClose: () => void; onSuccess: () => void }) {
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (password !== confirmation) { setError('两次输入的密码不一致'); return; }
    setBusy(true); setError('');
    try { await post('/auth/password-reset/confirm', { token, password }); onSuccess(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Modal title="设置新密码" onClose={() => { if (!busy) onClose(); }}><p className="muted auth-subtitle">重置后，所有设备的登录状态将失效，请使用新密码重新登录。</p><form className="auth-form" onSubmit={submit}><label>新密码<input type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 10 个字符" /></label><label>确认新密码<input type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}重置密码</button></form></Modal>;
}
export function VerifyEmailModal({ user, mailAvailable, onClose, onSuccess }: { user: User; mailAvailable: boolean; onClose: () => void; onSuccess: (user: User) => void }) {
  const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => { if (!countdown) return; const timer = setTimeout(() => setCountdown(v => v - 1), 1000); return () => clearTimeout(timer); }, [countdown]);
  async function send() { setSending(true); setError(''); try { const r = await post<{ message: string }>('/auth/verify-email/request', {}); setNotice(r.message); setCountdown(60); } catch (e) { setError((e as Error).message); } finally { setSending(false); } }
  async function confirm(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const r = await post<{ user: User }>('/auth/verify-email/confirm', { code }); onSuccess(r.user); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <Modal title="验证邮箱" onClose={() => { if (!busy && !sending) onClose(); }}><p className="muted auth-subtitle">请验证 {user.email}，完成后即可继续创作和兑换积分。</p><form className="auth-form" onSubmit={confirm}><label>邮箱验证码<div className="email-code-row"><input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="6 位验证码" /><button type="button" className="button secondary" disabled={!mailAvailable || sending || busy || countdown > 0} onClick={send}>{sending ? '发送中…' : countdown ? `${countdown} 秒后重发` : '获取验证码'}</button></div></label>{notice && <p className="auth-notice" role="status">{notice}</p>}{!mailAvailable && <p className="hint">邮件服务尚未启用，请联系管理员。</p>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || sending || !mailAvailable}><MailCheck size={16} />确认验证</button></form></Modal>;
}
