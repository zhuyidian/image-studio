import { useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Sparkles } from 'lucide-react';
import { Modal } from './Modal';
import { post } from '../api';
import type { PublicConfig, User } from '../../shared/types';

export function AuthModal({ config, onSuccess, onClose }: { config: PublicConfig; onSuccess: (u: User) => void; onClose: () => void }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await post<{ user: User }>(`/auth/${register ? 'register' : 'login'}`, { email, password, ...(register ? { name } : {}) }); onSuccess(result.user); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function demo() {
    setBusy(true); setError('');
    try { const result = await post<{ user: User }>('/auth/demo', {}); onSuccess(result.user); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={register ? '开启你的创作空间' : '欢迎回到创作空间'} onClose={() => { if (!busy) onClose(); }}>
    <p className="muted auth-subtitle">{register && config.signupCredits > 0 ? `注册即可获得 ${config.signupCredits} 体验积分。` : '让灵感留下来，让创作继续发生。'}</p>
    <form onSubmit={submit} className="auth-form">
      {register && <label>怎么称呼你<input autoComplete="nickname" required maxLength={32} value={name} onChange={e => setName(e.target.value)} placeholder="你的创作者昵称" /></label>}
      <label>邮箱<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label>
      <label>密码<input type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={10} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 10 个字符" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{register ? '创建账户' : '登录'}</button>
    </form>
    {config.registration && <p className="auth-switch">{register ? '已经有账户？' : '第一次来到这里？'}<button className="text-button" onClick={() => { setRegister(!register); setError(''); }}>{register ? '直接登录' : '注册账户'}</button></p>}
    {config.demoAvailable && <div className="demo-login"><span>先感受一下工作台</span><button className="button secondary full" disabled={busy} onClick={demo}><Sparkles size={16} />进入本地演示</button><small>演示使用共享测试账户，不调用真实生图模型。</small></div>}
  </Modal>;
}
