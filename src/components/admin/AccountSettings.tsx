import { useEffect, useState, type FormEvent } from 'react';
import { Mail, Save } from 'lucide-react';
import { api } from '../../api';
import { useAdminResource } from './useAdminResource';
import { AdminRefresh } from './AdminControls';
import type { AccountPolicy, AccountSettingsResponse } from '../../../shared/types';
import '../accounts.css';

export function AccountSettings({ toast, onChanged }: { toast: (text: string) => void; onChanged: () => void }) {
  const { data, error, loading, refresh } = useAdminResource<AccountSettingsResponse>('/admin/account-settings');
  const [draft, setDraft] = useState<AccountPolicy | null>(null); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [saveError, setSaveError] = useState('');
  useEffect(() => { if (data && !dirty) setDraft(data.policy); }, [data, dirty]);
  function change<K extends keyof AccountPolicy>(key: K, value: AccountPolicy[K]) { setDirty(true); setDraft(old => old ? { ...old, [key]: value } : old); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return; setBusy(true); setSaveError('');
    try { const result = await api<AccountSettingsResponse>('/admin/account-settings', { method: 'PUT', body: JSON.stringify(draft) }); setDraft(result.policy); setDirty(false); await refresh(); onChanged(); toast('注册与邮箱设置已保存'); }
    catch (e) { setSaveError((e as Error).message); } finally { setBusy(false); }
  }
  return <section aria-label="账户设置"><div className="section-heading admin-section-heading"><div><h2><Mail size={18} />注册与邮箱</h2><p>管理公开注册、体验积分和邮箱验证要求。</p></div><AdminRefresh loading={loading} onRefresh={() => { setDirty(false); void refresh(); }} /></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {draft ? <div className="admin-panel account-settings-panel"><form className="account-settings-form" onSubmit={save}><fieldset disabled={busy}>
      <label className="account-setting-check"><input type="checkbox" checked={draft.registration} onChange={e => change('registration', e.target.checked)} />开放新用户注册</label>
      <label className="account-setting-check"><input type="checkbox" checked={draft.emailVerificationRequired} onChange={e => change('emailVerificationRequired', e.target.checked)} />注册及创作前要求验证邮箱</label>
      <label className="account-setting-number">新用户注册赠送积分<input type="number" required min={0} max={100000} step={1} value={draft.signupCredits} onChange={e => change('signupCredits', Number(e.target.value))} /><small>填 0 关闭赠送。只影响以后成功注册的账户，不补发或撤回现有积分。</small></label>
      <div className="account-settings-mail"><strong>邮件投递：{data?.mail.transport === 'file' ? '本地测试邮件' : data?.mail.transport === 'smtp' ? 'SMTP' : '未启用'}</strong><p>{data?.mail.transport === 'file' ? '验证码与重置链接保存在私有 data/mail/，不会向外发送。可在本机执行 npm run mail:preview 查看最新测试邮件。' : data?.mail.available ? `发信邮箱：${data.mail.from ?? '已配置'}` : '需要在服务器环境变量中配置 SMTP，邮件密码不会显示或写入网页。'}</p><p>验证码 10 分钟有效、最多尝试 5 次；重置链接 30 分钟有效，仅可使用一次。</p></div>
      {draft.registration && draft.emailVerificationRequired && !data?.mail.available && <p className="form-error">邮件服务不可用时，网站会暂停注册，已有账户仍可登录。</p>}
      {dirty && data && data.policy.revision !== draft.revision && <p className="form-error">设置已有新版本，请刷新后重新编辑。</p>}
      {saveError && <p className="form-error" role="alert">{saveError}</p>}
      <div className="modal-actions"><button className="button primary" disabled={busy || !dirty}><Save size={15} />{busy ? '保存中…' : '保存账户设置'}</button></div>
    </fieldset></form></div> : <div className="empty-small">{loading ? '正在读取账户设置…' : '暂时无法读取设置。'}</div>}
  </section>;
}
