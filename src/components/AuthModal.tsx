import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Sparkles } from 'lucide-react';
import { Modal } from './Modal';
import { post } from '../api';
import type { PublicConfig, User } from '../../shared/types';

export function AuthModal({ config, onSuccess, onClose }: { config: PublicConfig; onSuccess: (u: User) => void; onClose: () => void }) {
  const [register, setRegister] = useState(false);
  const [forgot, setForgot] = useState(false); const [code, setCode] = useState(''); const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false); const [countdown, setCountdown] = useState(0);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (countdown <= 0) return; const timer = setTimeout(() => setCountdown(v => v - 1), 1000); return () => clearTimeout(timer); }, [countdown]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (forgot) { const result = await post<{ message: string }>('/auth/password-reset/request', { email }); setNotice(result.message); return; }
      const result = await post<{ user: User }>(`/auth/${register ? 'register' : 'login'}`, { email, password, ...(register ? { name, ...(config.emailVerificationRequired ? { verificationCode: code } : {}) } : {}) }); onSuccess(result.user);
    }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function sendCode() {
    setSending(true); setError(''); setNotice('');
    try { const result = await post<{ message: string }>('/auth/register-code', { email }); setNotice(result.message); setCountdown(60); }
    catch (e) { setError((e as Error).message); } finally { setSending(false); }
  }
  async function demo() {
    setBusy(true); setError('');
    try { const result = await post<{ user: User }>('/auth/demo', {}); onSuccess(result.user); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={forgot ? '找回你的创作空间' : register ? '开启你的创作空间' : '欢迎回到创作空间'} onClose={() => { if (!busy && !sending) onClose(); }}>
    <p className="muted auth-subtitle">{forgot ? '填写注册邮箱，我们会发送一次性密码重置链接。' : register && config.signupCredits > 0 ? `完成注册即可获得 ${config.signupCredits} 体验积分。` : '让灵感留下来，让创作继续发生。'}</p>
    <form onSubmit={submit} className="auth-form">
      {register && !forgot && <label>怎么称呼你<input autoComplete="nickname" required maxLength={32} value={name} onChange={e => setName(e.target.value)} placeholder="你的创作者昵称" /></label>}
      <label>邮箱<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => { setEmail(e.target.value); setCode(''); setNotice(''); }} placeholder="you@example.com" /></label>
      {register && !forgot && config.emailVerificationRequired && <label>邮箱验证码<div className="email-code-row"><input aria-label="邮箱验证码" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="6 位验证码" /><button className="button secondary" type="button" disabled={sending || countdown > 0 || !email || !config.mailDeliveryAvailable} onClick={sendCode}>{sending ? '发送中…' : countdown ? `${countdown} 秒后重发` : '获取验证码'}</button></div></label>}
      {!forgot && <label>密码<input type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={10} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 10 个字符" /></label>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary full" disabled={busy || sending || (forgot && !config.passwordResetAvailable)}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{forgot ? '发送重置链接' : register ? '创建账户' : '登录'}</button>
    </form>
    {!register && !forgot && <div className="forgot-password-link"><button className="text-button" onClick={() => { setForgot(true); setError(''); setNotice(''); }}>忘记密码？</button></div>}
    {forgot ? <p className="auth-switch"><button className="text-button" onClick={() => { setForgot(false); setError(''); setNotice(''); }}>返回登录</button></p> : config.registration && <p className="auth-switch">{register ? '已经有账户？' : '第一次来到这里？'}<button className="text-button" disabled={busy || sending} onClick={() => { setRegister(!register); setError(''); setNotice(''); }}>{register ? '直接登录' : '注册账户'}</button></p>}
    {forgot && !config.passwordResetAvailable && <p className="hint">邮件服务暂未启用，请联系管理员协助。</p>}
    {config.demoAvailable && !forgot && <div className="demo-login"><span>先感受一下工作台</span><button className="button secondary full" disabled={busy} onClick={demo}><Sparkles size={16} />进入本地演示</button><small>演示使用共享测试账户，不调用真实生图模型。</small></div>}
  </Modal>;
}
