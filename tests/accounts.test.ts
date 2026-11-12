import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, hash } from '../server/store.js';
import { Accounts } from '../server/accounts.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MediaStore } from '../server/media.js';
import { hashPassword, verifyPassword } from '../server/auth.js';
import { createMailDelivery, type AuthMail } from '../server/mail.js';
import type { User } from '../shared/types.js';

const capture = () => { const messages: AuthMail[] = []; return { messages, available: true, async send(message: AuthMail) { messages.push(message); } }; };
const lastCode = (mail: ReturnType<typeof capture>) => mail.messages.at(-1)!.text.match(/验证码：(\d{6})/)![1];
const lastToken = (mail: ReturnType<typeof capture>) => mail.messages.at(-1)!.text.match(/#reset=([a-f0-9-]+\.[A-Za-z0-9_-]+)/)![1];
const configFor = (extra: NodeJS.ProcessEnv = {}) => loadConfig({ NODE_ENV: 'test', EMAIL_VERIFICATION_REQUIRED: 'true', MAIL_TRANSPORT: 'disabled', ...extra });
function queuedTask(store: Store, userId: string) { return store.createTask({ userId, prompt: 'a test image', mode: 'generate', size: '1024x1024', quality: 'standard', count: 1, model: 'mock', provider: 'mock', unitPrice: 12, key: randomUUID(), maxActive: 10 }); }

test('registration requires an email-bound one-time code; expiry, attempt limits, throttles and gift snapshot apply', async () => {
  const store = new Store(':memory:'); const mail = capture(); const accounts = new Accounts(store, configFor(), mail);
  try {
    const input = { email: 'new@example.com', name: '创作者', passwordHash: await hashPassword('CreatorPassword123') };
    assert.throws(() => accounts.register(input), /验证码/); assert.equal(store.findUser(input.email), undefined);
    await accounts.requestCode(input.email, 'register'); const code = lastCode(mail);
    await accounts.requestCode(input.email, 'register'); assert.equal(mail.messages.length, 1);
    assert.throws(() => accounts.register({ ...input, email: 'other@example.com', verificationCode: code }), /验证码/);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) assert.throws(() => accounts.register({ ...input, verificationCode: wrong }), /验证码/);
    assert.throws(() => accounts.register({ ...input, verificationCode: code }), /验证码/);
    store.db.prepare('UPDATE auth_challenges SET created_at=?').run(new Date(Date.now() - 61000).toISOString());
    await accounts.requestCode(input.email, 'register'); const freshCode = lastCode(mail);
    const administrator = store.createUser('admin@example.com', 'Admin', 'hash', 0, 'admin', true);
    accounts.updatePolicy({ ...accounts.policy(), signupCredits: 72 }, administrator.id);
    const user = accounts.register({ ...input, verificationCode: freshCode }); assert.equal(user.emailVerified, true); assert.equal(user.credits, 72);
    assert.equal(store.ledger(user.id).filter(row => row.kind === 'welcome').length, 1);
    assert.throws(() => accounts.register({ ...input, verificationCode: freshCode }), /验证码|已注册/);
    await accounts.requestCode('expired@example.com', 'register'); const expired = lastCode(mail);
    store.db.prepare('UPDATE auth_challenges SET expires_at=? WHERE email=?').run('2000-01-01T00:00:00.000Z', 'expired@example.com');
    assert.throws(() => accounts.register({ ...input, email: 'expired@example.com', verificationCode: expired }), /验证码/);
    const rows = JSON.stringify(store.db.prepare('SELECT token_hash FROM auth_challenges').all());
    assert.equal(rows.includes(freshCode), false);
    const policy = accounts.policy(); accounts.updatePolicy({ ...policy, registration: false, signupCredits: 0 }, administrator.id);
    assert.equal(store.user(user.id).credits, 72); assert.throws(() => accounts.updatePolicy(policy, administrator.id), /已更新/);
    assert.throws(() => accounts.register({ ...input, email: 'closed@example.com', verificationCode: freshCode }), /未开放/);
  } finally { store.close(); }
});

test('password reset invalidates all sessions, old passwords and links; disabled/re-enabled accounts cannot reuse old links', async () => {
  const store = new Store(':memory:'); const mail = capture(); const accounts = new Accounts(store, configFor(), mail);
  try {
    const oldPassword = await hashPassword('OldPassword1234'); const newPassword = await hashPassword('NewPassword5678');
    const user = store.createUser('creator@example.com', '创作者', oldPassword, 50, 'user', true);
    const admin = store.createUser('admin@example.com', 'Admin', 'hash', 0, 'admin', true);
    store.createSession(user.id, 'device-one'); store.createSession(user.id, 'device-two');
    await accounts.requestReset(user.email); const token = lastToken(mail);
    assert.match(mail.messages.at(-1)!.text, /http:\/\/127\.0\.0\.1:5173\/#reset=/);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM auth_challenges').all()).includes(token.split('.')[1]), false);
    assert.throws(() => accounts.resetPassword(token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A'), newPassword), /无效/);
    assert.equal(accounts.resetPassword(token, newPassword), true);
    assert.equal(store.session('device-one'), undefined); assert.equal(store.session('device-two'), undefined);
    assert.equal(await verifyPassword('OldPassword1234', store.findUser(user.email)!.password), false);
    assert.equal(await verifyPassword('NewPassword5678', store.findUser(user.email)!.password), true);
    assert.throws(() => accounts.resetPassword(token, oldPassword), /无效/); assert.equal(store.user(user.id).credits, 50);
    store.db.prepare('UPDATE auth_challenges SET created_at=?').run(new Date(Date.now() - 61000).toISOString());
    await accounts.requestReset(user.email); const beforeDisable = lastToken(mail);
    store.setUserStatus(user.id, 'disabled', admin.id, '测试禁用'); store.setUserStatus(user.id, 'active', admin.id, '测试恢复');
    assert.throws(() => accounts.resetPassword(beforeDisable, oldPassword), /无效/);
    await accounts.requestReset('unknown@example.com'); assert.equal(mail.messages.length, 2);
  } finally { store.close(); }
});

test('disabled users lose sessions and queued tasks are refunded once; active upstream tasks still settle', () => {
  const store = new Store(':memory:');
  try {
    const admin = store.createUser('admin@example.com', 'Admin', 'hash', 0, 'admin');
    const user = store.createUser('creator@example.com', 'Creator', 'hash', 100);
    store.createSession(user.id, 'old-session');
    const running = queuedTask(store, user.id); store.claimTask(); const queued = queuedTask(store, user.id);
    const beforeVersion = store.findUser(user.email)!.auth_version;
    const disabled = store.setUserStatus(user.id, 'disabled', admin.id, '异常调用，暂停使用');
    assert.equal(disabled.status, 'disabled'); assert.equal(store.session('old-session'), undefined);
    assert.equal(store.taskRow(queued.id).status, 'failed'); assert.equal(store.taskRow(queued.id).charged, 0);
    assert.equal(store.taskRow(running.id).status, 'running'); assert.equal(disabled.credits, 88); assert.equal(disabled.frozen, 12);
    assert.equal(store.claimTask(), undefined); assert.throws(() => queuedTask(store, user.id), /已被禁用/);
    assert.throws(() => store.createSession(user.id, 'forbidden-session'), /已被禁用/);
    store.setUserStatus(user.id, 'disabled', admin.id, '再次禁用'); assert.equal(store.user(user.id).credits, 88);
    const image = store.addAsset(user.id, 'already-running.png', 10, 10, 'output'); store.settleTask(running.id, [image]);
    assert.equal(store.user(user.id).credits, 88); assert.equal(store.user(user.id).frozen, 0);
    store.setUserStatus(user.id, 'active', admin.id, '问题已处理'); assert.equal(store.session('old-session'), undefined);
    assert.throws(() => store.createSession(user.id, 'stale-login', beforeVersion), /登录信息已变化/);
    store.createSession(user.id, 'new-session'); assert.equal(store.session('new-session')?.id, user.id);
    assert.throws(() => store.setUserStatus(admin.id, 'disabled', admin.id, '禁用自己'), /不能禁用/);
    assert.equal(store.adminUsers('', 'all', 1, 'disabled').total, 0);
    const ledger = store.ledger(user.id); assert.equal(ledger.reduce((sum, row) => sum + row.delta, 0), 88); assert.equal(ledger.reduce((sum, row) => sum + row.frozenDelta, 0), 0);
  } finally { store.close(); }
});

test('account HTTP flow verifies registration, resets password, updates settings and blocks disabled sessions', async () => {
  const store = new Store(':memory:'); const mail = capture(); const config = configFor();
  const administrator = store.createUser('admin@example.com', 'Admin', await hashPassword('Administrator1234'), 0, 'admin', true);
  store.createSession(administrator.id, 'admin-session');
  const server = createApp(config, store, new MediaStore(store, path.join(tmpdir(), 'unused-account-media')), mail).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`; let cookie = '';
  const request = (route: string, method = 'GET', body?: unknown, customCookie = cookie, origin = config.origin) => fetch(base + route, { method,
    headers: { Origin: origin, ...(customCookie ? { Cookie: customCookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const site = await request('/config').then(r => r.json()); assert.equal(site.emailVerificationRequired, true); assert.equal(site.passwordResetAvailable, true);
    const input = { name: '新创作者', email: 'creator@example.com', password: 'CreatorPassword1234' };
    assert.equal((await request('/auth/register', 'POST', input)).status, 400);
    assert.equal((await request('/auth/register-code', 'POST', { email: input.email })).status, 200);
    const code = lastCode(mail);
    const register = await request('/auth/register', 'POST', { ...input, verificationCode: code }); assert.equal(register.status, 201);
    cookie = register.headers.get('set-cookie')!.split(';')[0]; const user: User = (await register.json()).user; assert.equal(user.emailVerified, true); assert.equal(user.credits, 36);
    assert.equal((await request('/admin/account-settings')).status, 403);
    const generic = await request('/auth/password-reset/request', 'POST', { email: 'unknown@example.com' }).then(r => r.json());
    const resetResponse = await request('/auth/password-reset/request', 'POST', { email: input.email }).then(r => r.json()); assert.equal(generic.message, resetResponse.message);
    const token = lastToken(mail);
    assert.equal((await request('/auth/password-reset/confirm', 'POST', { token, password: 'NewCreatorPassword1234' })).status, 200);
    assert.equal((await request('/auth/me').then(r => r.json())).user, null);
    assert.equal((await request('/auth/login', 'POST', { email: input.email, password: input.password })).status, 401);
    const login = await request('/auth/login', 'POST', { email: input.email, password: 'NewCreatorPassword1234' }); assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/auth/password-reset/confirm', 'POST', { token, password: 'AnotherPassword1234' })).status, 400);
    const adminCookie = 'studio_session=admin-session';
    const settings = await request('/admin/account-settings', 'GET', undefined, adminCookie).then(r => r.json());
    assert.equal((await request('/admin/account-settings', 'PUT', { ...settings.policy, signupCredits: 0 }, adminCookie, 'https://evil.example.com')).status, 403);
    const updated = await request('/admin/account-settings', 'PUT', { ...settings.policy, signupCredits: 0 }, adminCookie); assert.equal(updated.status, 200);
    assert.equal((await request('/config').then(r => r.json())).signupCredits, 0);
    assert.equal((await request('/admin/account-settings', 'PUT', settings.policy, adminCookie)).status, 409);
    assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled', reason: '测试禁用' })).status, 403);
    assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled', reason: '测试禁用' }, adminCookie)).status, 200);
    assert.equal((await request('/wallet')).status, 401); assert.equal((await request('/auth/me').then(r => r.json())).user, null);
    assert.equal((await request('/auth/login', 'POST', { email: input.email, password: 'NewCreatorPassword1234' })).status, 403);
    assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'active', reason: '恢复使用' }, adminCookie)).status, 200);
    assert.equal((await request('/wallet')).status, 401);
    assert.equal((await request('/admin/users?status=garbage', 'GET', undefined, adminCookie)).status, 400);
    assert.equal((await request(`/admin/users/${administrator.id}/status`, 'PUT', { status: 'disabled', reason: '自我禁用' }, adminCookie)).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('existing unverified accounts can log in and view history but must verify before spending credits', async () => {
  const store = new Store(':memory:'); const mail = capture(); const config = configFor();
  const user = store.createUser('legacy@example.com', '历史用户', await hashPassword('LegacyPassword1234'), 50);
  store.createSession(user.id, 'legacy-session');
  const server = createApp(config, store, new MediaStore(store, path.join(tmpdir(), 'unused-verification-media')), mail).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = (route: string, body?: unknown) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Cookie: 'studio_session=legacy-session', Origin: config.origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('/tasks')).status, 200);
    assert.equal((await request('/tasks', {})).status, 403);
    store.createVoucher('IMG-LEGACY-TEST', 100, new Date(Date.now() + 86400000).toISOString());
    assert.equal((await request('/wallet/redeem', { code: 'IMG-LEGACY-TEST' })).status, 403); assert.equal(store.user(user.id).credits, 50);
    assert.equal((await request('/auth/verify-email/request', {})).status, 200); const code = lastCode(mail);
    const verified = await request('/auth/verify-email/confirm', { code }); assert.equal(verified.status, 200); assert.equal((await verified.json()).user.emailVerified, true);
    assert.equal((await request('/wallet/redeem', { code: 'IMG-LEGACY-TEST' })).status, 200); assert.equal(store.user(user.id).credits, 150);
    assert.equal((await request('/auth/verify-email/confirm', { code })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('local mail delivery writes only private files; production refuses local file mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yidian-mail-test-'));
  try {
    const config = configFor({ MAIL_TRANSPORT: 'file', DATA_DIR: directory }); const mail = createMailDelivery(config);
    await mail.send({ to: 'local@example.com', subject: '本地验证', text: 'test only' });
    const files = await readdir(path.join(directory, 'mail')); assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(path.join(directory, 'mail', files[0]), 'utf8')); assert.equal(saved.localOnly, true); assert.equal(saved.to, 'local@example.com');
    assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://image.yidianhub.com', MAIL_TRANSPORT: 'file' }), /生产环境不能/);
    assert.throws(() => loadConfig({ MAIL_TRANSPORT: 'smtp' }), /SMTP/);
    const store = new Store(':memory:');
    try { const accounts = new Accounts(store, configFor(), { available: false, async send() { throw new Error('disabled'); } }); await assert.rejects(accounts.requestReset('user@example.com'), /尚未配置/); }
    finally { store.close(); }
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'yidian-mail-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('account migration preserves legacy balances and administrator access without verifying ordinary users', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yidian-account-migration-')); const file = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(file); const created = new Date().toISOString();
  legacy.exec("CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',credits INTEGER NOT NULL DEFAULT 0,frozen INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);");
  legacy.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run('legacy-admin', 'admin@example.com', 'Admin', 'hash', 'admin', 476, 0, created);
  legacy.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run('legacy-user', 'user@example.com', 'User', 'hash', 'user', 25, 0, created);
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('legacy-session'), 'legacy-admin', new Date(Date.now() + 86400000).toISOString()); legacy.close();
  let store: Store | undefined;
  try {
    store = new Store(file); assert.equal(store.user('legacy-admin').credits, 476); assert.equal(store.user('legacy-admin').emailVerified, true);
    assert.equal(store.user('legacy-user').emailVerified, false); assert.equal(store.session('legacy-session')?.id, 'legacy-admin');
    store.close(); store = new Store(file); assert.equal(store.user('legacy-admin').credits, 476); assert.equal(store.user('legacy-user').emailVerified, false);
  } finally { store?.close(); assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'yidian-account-migration-'))); await rm(directory, { recursive: true, force: true }); }
});

test('reset expiry, hourly mail limit and SMTP errors never expose reset tokens or account existence', async () => {
  const store = new Store(':memory:'); const mail = capture(); const config = configFor(); const accounts = new Accounts(store, config, mail);
  try {
    const user = store.createUser('creator@example.com', 'Creator', 'hash');
    await accounts.requestReset(user.email); const expired = lastToken(mail);
    store.db.prepare('UPDATE auth_challenges SET expires_at=?').run('2000-01-01T00:00:00.000Z');
    assert.throws(() => accounts.resetPassword(expired, 'new-hash'), /已过期/);
    for (let index = 0; index < 8; index++) {
      store.db.prepare('UPDATE auth_challenges SET created_at=? WHERE email=?').run(new Date(Date.now() - 61000).toISOString(), user.email);
      await accounts.requestReset(user.email);
    }
    assert.equal(mail.messages.length, 5);
    const previousPassword = store.findUser(user.email)!.password;
    const failed = new Accounts(store, config, { available: true, async send() { throw new Error('SMTP test failure: not returned publicly'); } });
    const other = store.createUser('other@example.com', 'Other', 'hash');
    await failed.requestReset(other.email); await failed.requestReset('unknown@example.com');
    assert.equal(store.findUser(user.email)!.password, previousPassword);
    const failedChallenge = store.db.prepare('SELECT consumed_at FROM auth_challenges WHERE email=?').get(other.email) as { consumed_at: string | null }; assert.ok(failedChallenge.consumed_at);
  } finally { store.close(); }
});
