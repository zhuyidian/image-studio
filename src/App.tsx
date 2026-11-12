import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, CircleHelp, Coins, Compass, Images, LayoutGrid, LogOut, Menu, PanelLeftClose, Settings2, Sparkles, X } from 'lucide-react';
import { api, post, ApiError } from './api';
import { Studio, type StudioPage } from './components/Studio';
import { AuthModal } from './components/AuthModal';
import { Wallet } from './components/Wallet';
import { Admin } from './components/Admin';
import { Modal } from './components/Modal';
import { PasswordResetModal, VerifyEmailModal } from './components/AccountModals';
import type { PublicConfig, Task, User } from '../shared/types';

type Page = StudioPage | 'wallet' | 'admin';
function currentPage(): Page { const p = new URLSearchParams(location.search).get('page'); return ['works', 'inspiration', 'wallet', 'admin'].includes(p || '') ? p as Page : 'studio'; }
const pageNames = { studio: '创作工作台', works: '我的作品', inspiration: '灵感探索', wallet: '积分与补给', admin: '运营管理' };
export default function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null); const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>(currentPage); const [tasks, setTasks] = useState<Task[]>([]);
  const [auth, setAuth] = useState(false); const [help, setHelp] = useState(false); const [mobileMenu, setMobileMenu] = useState(false);
  const [message, setMessage] = useState(''); const [loadError, setLoadError] = useState(''); const [offline, setOffline] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [passwordReset, setPasswordReset] = useState(() => new URLSearchParams(location.hash.slice(1)).get('reset') ?? '');
  const [verifyEmail, setVerifyEmail] = useState(false);
  useEffect(() => {
    const readReset = () => { const token = new URLSearchParams(location.hash.slice(1)).get('reset'); if (token) { setPasswordReset(token); history.replaceState({}, '', location.pathname + location.search); } };
    readReset(); window.addEventListener('hashchange', readReset); return () => window.removeEventListener('hashchange', readReset);
  }, []);
  const toast = useCallback((text: string) => setMessage(text), []);
  const refreshConfig = useCallback(async () => {
    const latest = await api<PublicConfig>('/config');
    setConfig(latest);
  }, []);
  const navigate = useCallback((next: Page) => { setPage(next); setMobileMenu(false); history.pushState({}, '', next === 'studio' ? '/' : `/?page=${next}`); }, []);
  useEffect(() => { const onPop = () => setPage(currentPage()); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  useEffect(() => { if (message) { const t = setTimeout(() => setMessage(''), 4500); return () => clearTimeout(t); } }, [message]);
  useEffect(() => { void Promise.all([api<PublicConfig>('/config'), api<{ user: User | null }>('/auth/me')]).then(([c, u]) => { setConfig(c); setUser(u.user); document.title = `${c.name} · 图片创作工作台`; }).catch(e => setLoadError(e.message)); }, []);
  useEffect(() => {
    const refresh = () => { void refreshConfig().catch(() => undefined); };
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 30000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refreshConfig]);
  useEffect(() => { void refreshConfig().catch(() => undefined); }, [user?.id, user?.role, refreshConfig]);
  useEffect(() => {
    if (!user?.id) { setTasks([]); return; }
    let disposed = false;
    const refresh = async () => {
      try {
        const u = await api<{ user: User | null }>('/auth/me');
        if (!u.user) { if (!disposed) { setUser(null); setTasks([]); setOffline(false); setVerifyEmail(false); toast('登录已失效，请重新登录'); } return; }
        const t = await api<{ tasks: Task[] }>('/tasks');
        if (!disposed) { setTasks(t.tasks); setUser(u.user); setOffline(false); }
      }
      catch (error) {
        if (!disposed && error instanceof ApiError && error.status === 401) { setUser(null); setTasks([]); setOffline(false); setVerifyEmail(false); }
        else if (!disposed) setOffline(true);
      }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [user?.id]);
  if (loadError) return <main className="fatal"><span className="brand-icon">✳</span><h1>暂时无法连接创作空间</h1><p>{loadError}</p><button className="button primary" onClick={() => location.reload()}>重新连接</button></main>;
  if (!config) return <main className="fatal"><span className="brand-icon loading-logo">✳</span><p>正在准备你的创作空间…</p></main>;
  return <div className="app-shell">
    {mobileMenu && <button className="mobile-backdrop" aria-label="关闭菜单" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'open' : ''}`}>
      <a className="brand" href="/" onClick={e => { e.preventDefault(); navigate('studio'); }}><span className="brand-icon">✳</span><span>{config.name}<small>一点灵感，无限可能</small></span></a>
      <button className="new-creation" onClick={() => { setResetToken(v => v + 1); navigate('studio'); }}><Sparkles size={17} />开始新的创作<ArrowRight size={15} /></button>
      <span className="nav-caption">我的创作空间</span>
      <nav aria-label="主导航">{([{ id: 'studio', title: '创作工作台', icon: LayoutGrid }, { id: 'works', title: '我的作品', icon: Images }, { id: 'inspiration', title: '灵感探索', icon: Compass }] as const).map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><item.icon size={18} />{item.title}{page === item.id && <span className="nav-active-dot" />}</button>)}<div className="nav-separator" /><button className={page === 'wallet' ? 'active' : ''} onClick={() => navigate('wallet')}><Coins size={18} />积分与补给</button>{user?.role === 'admin' && <button className={page === 'admin' ? 'active' : ''} onClick={() => navigate('admin')}><Settings2 size={18} />运营管理</button>}</nav>
      <div className="sidebar-bottom"><div className="side-note"><span>给想象力，留一点空间。</span><p>每一张好图，<br />都始于一个小小的念头。</p><span className="side-note-star">✳</span></div>{user && <button className="side-credits" onClick={() => navigate('wallet')}><span><Coins size={15} />可用积分</span><strong>{user.credits.toLocaleString()}<ArrowRight size={14} /></strong>{user.frozen > 0 && <small>{user.frozen} 积分用于进行中的任务</small>}</button>}<button className="help-button" onClick={() => setHelp(true)}><CircleHelp size={17} />使用帮助<span>↗</span></button><div className="sidebar-account">{user ? <><span className="avatar">{user.name.slice(0, 1)}</span><span><strong>{user.name}</strong><small>我的创作账户</small></span><button className="icon-button" aria-label="退出登录" onClick={async () => { try { await post('/auth/logout', {}); setUser(null); navigate('studio'); toast('已退出登录'); } catch (e) { toast((e as Error).message); } }}><LogOut size={16} /></button></> : <><span className="avatar guest">Y</span><span><strong>你好，创作者</strong><button className="text-button" onClick={() => setAuth(true)}>登录你的空间</button></span></>}</div></div>
    </aside>
    <div className="main-column"><header className="topbar"><div><button className="icon-button mobile-toggle" aria-label="打开导航菜单" onClick={() => setMobileMenu(true)}><Menu size={20} /></button><span>我的空间</span><span className="breadcrumb-slash">/</span><strong>{pageNames[page]}</strong></div><div className="topbar-right">{user ? <button className="top-balance" onClick={() => navigate('wallet')}><Coins size={15} /><strong>{user.credits}</strong><span>积分</span><span className="top-plus">+</span></button> : <button className="button secondary small" onClick={() => setAuth(true)}>登录 / 注册<ArrowRight size={14} /></button>}<button className="icon-button top-help" aria-label="查看帮助" onClick={() => setHelp(true)}><CircleHelp size={19} /></button></div></header>
      {config.provider === 'mock' && <div className="demo-banner"><span className="status-dot" />本地演示模式<span>示例图片用于验证流程，不调用真实模型。</span></div>}
      {offline && <div className="notice connection-notice" role="status">连接暂时中断，正在重新连接。已经提交的任务会在后台继续执行。</div>}
      {user && config.emailVerificationRequired && !user.emailVerified && <div className="email-verify-banner"><span>请先验证邮箱，再开始创作或兑换积分。你的历史作品仍可查看。</span><button className="text-button" onClick={() => setVerifyEmail(true)}>验证邮箱</button></div>}
      <div hidden={!['studio', 'works', 'inspiration'].includes(page)}><Studio config={config} user={user} tasks={tasks} resetToken={resetToken} page={['studio', 'works', 'inspiration'].includes(page) ? page as StudioPage : 'studio'} onNavigate={navigate} onLogin={() => setAuth(true)} onRefreshConfig={refreshConfig} onSubmitted={(task, u) => { setTasks(previous => [task, ...previous.filter(t => t.id !== task.id)]); setUser(u); }} toast={toast} /></div>
      {page === 'wallet' && <Wallet config={config} user={user} onUser={setUser} onLogin={() => setAuth(true)} toast={toast} />}
      {page === 'admin' && (user?.role === 'admin' ? <Admin key={user.id} brand={config.name} toast={toast} onModelsChanged={() => { void refreshConfig().catch(e => toast((e as Error).message)); }} /> : <section className="page-content"><div className="empty-works"><h2>需要管理员权限</h2><p>请使用管理员账户登录后查看。</p>{!user && <button className="button primary" onClick={() => setAuth(true)}>登录</button>}</div></section>)}
      <footer className="site-footer"><span>© {new Date().getFullYear()} {config.name}</span><span>一点灵感，无限可能<span className="footer-star">✳</span></span></footer>
    </div>
    {auth && !passwordReset && <AuthModal config={config} onClose={() => setAuth(false)} onSuccess={u => { setTasks([]); setUser(u); setAuth(false); toast(`欢迎，${u.name}`); }} />}
    {passwordReset && <PasswordResetModal token={passwordReset} onClose={() => setPasswordReset('')} onSuccess={() => { setPasswordReset(''); setUser(null); setTasks([]); setAuth(true); toast('密码已重置，请使用新密码登录'); }} />}
    {verifyEmail && user && <VerifyEmailModal user={user} mailAvailable={config.mailDeliveryAvailable} onClose={() => setVerifyEmail(false)} onSuccess={u => { setUser(u); setVerifyEmail(false); toast('邮箱已验证，可以继续创作'); }} />}
    {help && <Modal title="让创作更顺手" onClose={() => setHelp(false)}><div className="help-content"><h3>从一个画面开始</h3><p>文字生图适合从零创作；参考图编辑可以调整已有图片；局部重绘需要先上传图片，再涂抹要修改的区域。每种创作方式只展示支持该操作的模型。</p><h3>选择创作模型</h3><p>默认推荐模型可以直接使用。切换模型后，画幅、质量、数量和价格会按支持范围调整，请在提交前核对。</p><h3>积分如何计算？</h3><p>积分按所选模型、任务类型、质量与张数计算，以创作按钮旁显示的费用为准。提交时冻结，成功按交付张数结算；明确失败释放积分。结果不明的任务会暂时冻结，等待核对。已提交任务保留当时的模型与单价。</p><h3>页面关闭后怎么办？</h3><p>任务在服务端执行。再次登录后，可以在“我的作品”中查看进度和下载结果。</p><h3>关于本地演示</h3><p>演示模式输出的是程序绘制的示意图，用来验证账户、积分和任务流程，不代表真实模型的图片质量或编辑效果。</p><h3>项目与许可</h3><p>部分画布坐标与缩放逻辑改编自 MIT 开源项目 GPT Image Playground，完整许可见项目 THIRD_PARTY_NOTICES.md。</p></div></Modal>}
    {message && <div className="toast" role="status"><Check size={17} />{message}<button aria-label="关闭提示" onClick={() => setMessage('')}><X size={14} /></button></div>}
  </div>;
}
