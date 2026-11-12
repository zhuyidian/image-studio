import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AccountPolicy, User } from '../shared/types.js';
import type { Config } from './config.js';
import { Store, AppError, hash, type UserRow } from './store.js';
import type { MailDelivery } from './mail.js';

export const accountPolicySchema = z.object({ registration: z.boolean(), signupCredits: z.number().int().min(0).max(100000), emailVerificationRequired: z.boolean(), revision: z.number().int().positive() }).strict();
type Purpose = 'register' | 'verify' | 'reset';
interface Challenge { id: string; email: string; user_id: string | null; purpose: Purpose; token_hash: string; expires_at: string; created_at: string; consumed_at: string | null; attempts: number; auth_version: number | null }
const timestamp = () => new Date().toISOString();
export class Accounts {
  constructor(private store: Store, private config: Config, private mail: MailDelivery) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS account_policy (id INTEGER PRIMARY KEY CHECK(id=1), config_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_challenges (id TEXT PRIMARY KEY,email TEXT NOT NULL,user_id TEXT REFERENCES users(id),purpose TEXT NOT NULL,
        token_hash TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,consumed_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,auth_version INTEGER);
      CREATE INDEX IF NOT EXISTS challenge_email ON auth_challenges(email,purpose,created_at);`);
    store.db.prepare('INSERT OR IGNORE INTO account_policy VALUES (1,?)').run(JSON.stringify({ registration: config.registration, signupCredits: config.signupCredits, emailVerificationRequired: config.emailVerificationRequired, revision: 1 }));
  }
  policy(): AccountPolicy { return JSON.parse(String(this.store.db.prepare('SELECT config_json FROM account_policy WHERE id=1').get()!.config_json)); }
  updatePolicy(raw: unknown, actorId: string) {
    const input = accountPolicySchema.parse(raw);
    return this.store.tx(() => {
      const old = this.policy(); if (old.revision !== input.revision) throw new AppError(409, '注册设置已更新，请刷新后重试');
      const policy = { ...input, revision: old.revision + 1 };
      this.store.db.prepare('UPDATE account_policy SET config_json=? WHERE id=1').run(JSON.stringify(policy));
      this.store.audit(actorId, 'account.policy.update', 'account_policy', JSON.stringify(policy)); return policy;
    });
  }
  mailStatus() { return { transport: this.config.mailTransport, available: this.mail.available, from: this.config.SMTP_FROM ?? null }; }
  requireVerified(user: User) { if (this.policy().emailVerificationRequired && !user.emailVerified) throw new AppError(403, '请先验证邮箱后再使用此功能', 'EMAIL_VERIFICATION_REQUIRED'); }
  private issue(email: string, purpose: Purpose, user?: UserRow) {
    return this.store.tx(() => {
      const time = Date.now();
      const previous = this.store.db.prepare('SELECT created_at FROM auth_challenges WHERE email=? AND purpose=? ORDER BY created_at DESC LIMIT 1').get(email, purpose) as { created_at: string } | undefined;
      if (previous && time - Date.parse(previous.created_at) < 60000) return null;
      const { n } = this.store.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges WHERE email=? AND purpose=? AND created_at>?').get(email, purpose, new Date(time - 3600000).toISOString()) as { n: number };
      if (n >= 5) return null;
      this.store.db.prepare('UPDATE auth_challenges SET consumed_at=? WHERE email=? AND purpose=? AND consumed_at IS NULL').run(timestamp(), email, purpose);
      const id = randomUUID(); const secret = purpose === 'reset' ? randomBytes(32).toString('base64url') : String(randomInt(100000, 1000000));
      const expiresAt = new Date(time + (purpose === 'reset' ? 30 : 10) * 60000).toISOString();
      this.store.db.prepare('INSERT INTO auth_challenges (id,email,user_id,purpose,token_hash,expires_at,created_at,auth_version) VALUES (?,?,?,?,?,?,?,?)').run(id, email, user?.id ?? null, purpose, hash(id + ':' + secret), expiresAt, timestamp(), user?.auth_version ?? null);
      return { id, secret, expiresAt };
    });
  }
  async requestCode(email: string, purpose: 'register' | 'verify', userId?: string) {
    if (!this.mail.available) throw new AppError(503, '邮件服务尚未配置，请联系管理员');
    const existing = this.store.findUser(email);
    const isEligible = purpose === 'register' ? !existing : Boolean(existing && existing.id === userId && existing.status === 'active' && !existing.email_verified_at);
    const challenge = this.issue(email, purpose, purpose === 'verify' ? existing : undefined);
    if (!challenge || !isEligible) return;
    try {
      await this.mail.send({ to: email, subject: `${this.config.APP_NAME} 邮箱验证码`, text: `${this.config.APP_NAME}\n\n邮箱验证码：${challenge.secret}\n10 分钟内有效，仅能使用一次。请勿向他人提供验证码。\n如果不是你发起的请求，请忽略这封邮件。` });
    } catch {
      this.store.db.prepare('UPDATE auth_challenges SET consumed_at=? WHERE id=?').run(timestamp(), challenge.id);
      console.warn('Verification email delivery failed');
      // Identical public response prevents SMTP failures revealing whether an account exists.
    }
  }
  async requestReset(email: string) {
    if (!this.mail.available) throw new AppError(503, '邮件服务尚未配置，请联系管理员');
    const user = this.store.findUser(email); const challenge = this.issue(email, 'reset', user);
    if (!challenge || !user || user.status !== 'active') return;
    const link = `${this.config.publicOrigin}/#reset=${challenge.id}.${challenge.secret}`;
    try { await this.mail.send({ to: email, subject: `${this.config.APP_NAME} 重置密码`, text: `${this.config.APP_NAME}\n\n请在 30 分钟内打开以下链接设置新密码：\n${link}\n\n链接仅能使用一次。重置后所有设备均需重新登录。\n如果不是你发起的请求，请忽略这封邮件，你的密码不会改变。` }); }
    catch { this.store.db.prepare('UPDATE auth_challenges SET consumed_at=? WHERE id=?').run(timestamp(), challenge.id); console.warn('Password reset email delivery failed'); }
  }
  private consume<T>(email: string, purpose: Purpose, secret: string, action: (challenge: Challenge) => T, id?: string): T {
    const result = this.store.tx(() => {
      const challenge = (id ? this.store.db.prepare('SELECT * FROM auth_challenges WHERE id=? AND purpose=?').get(id, purpose)
        : this.store.db.prepare('SELECT * FROM auth_challenges WHERE email=? AND purpose=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(email, purpose)) as Challenge | undefined;
      if (!challenge || challenge.consumed_at || challenge.expires_at <= timestamp() || challenge.attempts >= 5) return { error: true as const };
      const actual = Buffer.from(hash(challenge.id + ':' + secret), 'hex'); const expected = Buffer.from(challenge.token_hash, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        this.store.db.prepare('UPDATE auth_challenges SET attempts=attempts+1 WHERE id=?').run(challenge.id);
        return { error: true as const };
      }
      if (challenge.user_id) {
        const user = this.store.findUser(challenge.email);
        if (!user || user.id !== challenge.user_id || user.status !== 'active' || user.auth_version !== challenge.auth_version) return { error: true as const };
      }
      const value = action(challenge);
      this.store.db.prepare('UPDATE auth_challenges SET consumed_at=? WHERE id=?').run(timestamp(), challenge.id);
      return { error: false as const, value };
    });
    if (result.error) throw new AppError(400, purpose === 'reset' ? '重置链接无效、已过期或已使用，请重新申请' : '验证码无效、已过期或尝试次数过多，请重新获取');
    return result.value;
  }
  register(input: { email: string; name: string; passwordHash: string; verificationCode?: string }) {
    const policy = this.policy();
    if (!policy.registration) throw new AppError(403, '暂未开放注册，请联系管理员');
    if (policy.emailVerificationRequired) {
      if (!this.mail.available) throw new AppError(503, '邮件服务尚未配置，暂时无法注册');
      return this.consume(input.email, 'register', input.verificationCode ?? '', () => this.store.insertUser(input.email, input.name, input.passwordHash, policy.signupCredits, 'user', true));
    }
    return this.store.createUser(input.email, input.name, input.passwordHash, policy.signupCredits);
  }
  verify(user: User, code: string) {
    return this.consume(user.email, 'verify', code, challenge => {
      if (challenge.user_id !== user.id) throw new AppError(400, '验证码不属于当前账户');
      this.store.db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(timestamp(), user.id);
      this.store.audit(user.id, 'user.email.verify', user.id, '邮箱验证完成'); return this.store.user(user.id);
    });
  }
  resetPassword(token: string, passwordHash: string) {
    const [id, secret] = token.split('.');
    if (!id || !secret) throw new AppError(400, '重置链接无效');
    return this.consume('', 'reset', secret, challenge => {
      if (!challenge.user_id) throw new AppError(400, '重置链接无效');
      this.store.db.prepare('UPDATE users SET password=?,auth_version=auth_version+1 WHERE id=?').run(passwordHash, challenge.user_id);
      this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(challenge.user_id);
      this.store.db.prepare('UPDATE auth_challenges SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(timestamp(), challenge.user_id);
      this.store.audit(challenge.user_id, 'user.password.reset', challenge.user_id, '已重置密码并撤销全部登录会话');
      return true;
    }, id);
  }
}
