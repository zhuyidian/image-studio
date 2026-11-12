import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hash, Store } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { MediaStore } from '../server/media.js';
import { createApp } from '../server/app.js';
import type { CreatedVoucher, VoucherList } from '../shared/types.js';

const expiry = () => new Date(Date.now() + 30 * 86400000).toISOString();

test('voucher metadata, status counts and pagination never expose code hashes or plaintext', () => {
  const store = new Store(':memory:');
  try {
    const admin = store.createUser('admin@example.com', '管理员', 'hash', 0, 'admin');
    const user = store.createUser('user@example.com', '创作者', 'hash');
    const unused = store.createVoucher('IMG-UNUSED-A1B2C3', 500, expiry(), { createdBy: admin.id, note: ' 活动赠送 ' });
    const redeemed = store.createVoucher('IMG-REDEEMED-123456', 100, expiry(), { createdBy: admin.id });
    const revoked = store.createVoucher('IMG-REVOKED-654321', 200, expiry(), { createdBy: admin.id });
    const expired = store.createVoucher('IMG-EXPIRED-ABCDEF', 300, expiry());
    store.redeem(user.id, 'img-redeemed-123456');
    store.revokeVoucher(revoked.id, admin.id, '误发，作废后重新发放');
    store.db.prepare('UPDATE vouchers SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', expired.id);
    const list = store.vouchers();
    assert.deepEqual(list.counts, { all: 4, unused: 1, redeemed: 1, expired: 1, revoked: 1 });
    assert.equal(list.vouchers.find(v => v.id === unused.id)?.suffix, 'A1B2C3');
    assert.equal(list.vouchers.find(v => v.id === unused.id)?.note, '活动赠送');
    assert.equal(list.vouchers.find(v => v.id === unused.id)?.createdBy?.email, admin.email);
    assert.equal(list.vouchers.find(v => v.id === redeemed.id)?.redeemedBy?.id, user.id);
    assert.equal(list.vouchers.find(v => v.id === revoked.id)?.revokedBy?.id, admin.id);
    for (const status of ['unused', 'redeemed', 'expired', 'revoked'] as const) {
      const filtered = store.vouchers(status); assert.equal(filtered.total, 1); assert.equal(filtered.vouchers[0].status, status);
    }
    const serialized = JSON.stringify(list);
    for (const secret of ['code_hash', 'IMG-UNUSED-A1B2C3', hash('IMG-UNUSED-A1B2C3')]) assert.equal(serialized.includes(secret), false);
    const stored = JSON.stringify(store.db.prepare('SELECT * FROM vouchers').all());
    assert.equal(stored.includes('IMG-UNUSED-A1B2C3'), false);
    for (let i = 0; i < 23; i++) store.createVoucher(`IMG-PAGE-${i.toString().padStart(8, '0')}`, 10, expiry());
    assert.equal(store.vouchers().vouchers.length, 20);
    assert.equal(store.vouchers('all', 2).vouchers.length, 7);
    assert.equal(store.vouchers('all', 999).page, 2);
    assert.equal(store.vouchers('unused', 2).total, 24);
  } finally { store.close(); }
});

test('voucher issuance and revocation roll back completely if their administrator metadata cannot be saved', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.createVoucher('IMG-ROLLBACK-ISSUANCE', 500, expiry(), { createdBy: 'missing-admin' }));
    assert.equal(store.vouchers().total, 0);
    const voucher = store.createVoucher('IMG-ROLLBACK-REVOCATION', 500, expiry());
    assert.throws(() => store.revokeVoucher(voucher.id, 'missing-admin', 'metadata cannot be saved'));
    assert.equal(store.voucher(voucher.id).status, 'unused');
    const user = store.createUser('creator@example.com', '创作者', 'hash');
    assert.equal(store.redeem(user.id, 'IMG-ROLLBACK-REVOCATION').credits, 500);
  } finally { store.close(); }
});

test('redeem and revoke are mutually exclusive and every account change has one ledger entry', () => {
  const store = new Store(':memory:');
  try {
    const admin = store.createUser('admin@example.com', '管理员', 'hash', 0, 'admin');
    const user = store.createUser('user@example.com', '创作者', 'hash');
    const blocked = store.createVoucher('IMG-REVOKE-FIRST', 500, expiry(), { createdBy: admin.id });
    store.revokeVoucher(blocked.id, admin.id, '撤销发放');
    assert.throws(() => store.revokeVoucher(blocked.id, admin.id, '再次撤销'), /仅未兑换/);
    assert.throws(() => store.redeem(user.id, 'IMG-REVOKE-FIRST'), /已作废/);
    assert.equal(store.user(user.id).credits, 0); assert.equal(store.ledger(user.id).length, 0);
    const delivered = store.createVoucher('IMG-REDEEM-FIRST', 500, expiry(), { createdBy: admin.id });
    store.redeem(user.id, ' IMG-REDEEM-FIRST ');
    assert.throws(() => store.revokeVoucher(delivered.id, admin.id, '兑换后撤销'), /仅未兑换/);
    assert.throws(() => store.redeem(user.id, 'IMG-REDEEM-FIRST'), /已使用/);
    store.db.prepare('UPDATE vouchers SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', delivered.id);
    assert.equal(store.voucher(delivered.id).status, 'redeemed'); assert.equal(store.user(user.id).credits, 500);
    assert.equal(store.ledger(user.id).filter(l => l.kind === 'redeem').length, 1);
    const expired = store.createVoucher('IMG-EXPIRED-CODE', 500, expiry());
    store.db.prepare('UPDATE vouchers SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', expired.id);
    assert.throws(() => store.redeem(user.id, 'IMG-EXPIRED-CODE'), /已过期/);
    assert.throws(() => store.revokeVoucher(expired.id, admin.id, '过期后撤销'), /仅未兑换/);
    const audit = store.db.prepare("SELECT action,target_id FROM audit WHERE action LIKE 'voucher.%'").all();
    assert.equal(audit.filter(a => a.action === 'voucher.revoke').length, 1);
    assert.equal(audit.filter(a => a.action === 'voucher.redeem').length, 1);
    assert.equal(audit.find(a => a.action === 'voucher.redeem')?.target_id, delivered.id);
  } finally { store.close(); }
});

test('legacy database migration preserves codes, balances and redemption records across repeated opens', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yidian-voucher-migration-'));
  const file = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',credits INTEGER NOT NULL DEFAULT 0,frozen INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE vouchers (code_hash TEXT PRIMARY KEY,credits INTEGER NOT NULL,expires_at TEXT NOT NULL,redeemed_by TEXT REFERENCES users(id),redeemed_at TEXT,created_at TEXT NOT NULL);`);
  const timestamp = new Date().toISOString(); const expiresAt = expiry();
  legacy.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run('legacy-user', 'legacy@example.com', '旧用户', 'hash', 'user', 250, 0, timestamp);
  legacy.prepare('INSERT INTO vouchers VALUES (?,?,?,?,?,?)').run(hash('IMG-LEGACY-AVAILABLE'), 500, expiresAt, null, null, timestamp);
  legacy.prepare('INSERT INTO vouchers VALUES (?,?,?,?,?,?)').run(hash('IMG-LEGACY-REDEEMED'), 250, expiresAt, 'legacy-user', timestamp, timestamp);
  legacy.close();
  let store: Store | undefined;
  try {
    store = new Store(file);
    const before = store.vouchers().vouchers;
    assert.equal(before.length, 2); assert.equal(before[0].createdBy, null); assert.equal(before[0].suffix, null);
    assert.equal(before.find(v => v.status === 'redeemed')?.redeemedBy?.id, 'legacy-user');
    const ids = before.map(v => v.id).sort();
    store.close(); store = new Store(file);
    assert.deepEqual(store.vouchers().vouchers.map(v => v.id).sort(), ids);
    assert.equal(store.user('legacy-user').credits, 250);
    assert.equal(store.redeem('legacy-user', 'IMG-LEGACY-AVAILABLE').credits, 750);
    assert.throws(() => store!.redeem('legacy-user', 'IMG-LEGACY-REDEEMED'), /已使用/);
    assert.equal(store.vouchers('redeemed').total, 2);
  } finally {
    store?.close();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'yidian-voucher-migration-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('admin voucher HTTP API validates permissions, custom expiry, listing and revocation', async () => {
  const store = new Store(':memory:');
  const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:5173', PUBLIC_ORIGIN: 'https://image.yidianhub.com' });
  const admin = store.createUser('admin@example.com', '管理员', 'hash', 0, 'admin');
  const user = store.createUser('user@example.com', '创作者', 'hash');
  store.createSession(admin.id, 'admin-test-session'); store.createSession(user.id, 'user-test-session');
  const server = createApp(config, store, new MediaStore(store, path.join(tmpdir(), 'unused-voucher-media'))).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = (route: string, method = 'GET', body?: unknown, cookie = 'admin-test-session', origin = config.origin) => fetch(base + route, {
    method, headers: { Origin: origin, Cookie: `studio_session=${cookie}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await request('/admin/vouchers', 'GET', undefined, '')).status, 401);
    assert.equal((await request('/admin/vouchers', 'GET', undefined, 'user-test-session')).status, 403);
    assert.equal((await request('/admin/vouchers', 'POST', { credits: 500, days: 30 }, 'user-test-session')).status, 403);
    assert.equal((await request('/admin/vouchers', 'POST', { credits: 500, days: 30 }, 'admin-test-session', 'https://other.example.com')).status, 403);
    for (const invalid of [{ credits: 0, days: 30 }, { credits: 100001, days: 30 }, { credits: 500, days: 0 }, { credits: 500, days: 366 }, { credits: 2.5, days: 30 }, { credits: 500, days: 7.5 }, { credits: 500, days: 30, note: 'x'.repeat(301) }]) {
      assert.equal((await request('/admin/vouchers', 'POST', invalid)).status, 400);
    }
    const started = Date.now();
    const response = await request('/admin/vouchers', 'POST', { credits: 500, days: 17, note: ' 用户补偿 ' });
    assert.equal(response.status, 201); const created: CreatedVoucher = await response.json();
    assert.equal(created.voucher.credits, 500); assert.equal(created.voucher.note, '用户补偿'); assert.equal(created.voucher.createdBy?.id, admin.id);
    assert.match(created.code, /^IMG-[A-F0-9]{24}$/); assert.equal(created.redemptionUrl, 'https://image.yidianhub.com/?page=wallet');
    assert.ok(Math.abs(Date.parse(created.voucher.expiresAt) - started - 17 * 86400000) < 2000);
    const listed: VoucherList = await request('/admin/vouchers?status=unused&page=1').then(r => r.json());
    assert.equal(listed.total, 1); assert.equal(JSON.stringify(listed).includes(created.code), false); assert.equal(JSON.stringify(listed).includes('code_hash'), false);
    assert.equal((await request('/admin/vouchers?status=invalid')).status, 400);
    assert.equal((await request('/admin/vouchers?page=-1')).status, 400);
    assert.equal((await request(`/admin/vouchers/${created.voucher.id}/revoke`, 'POST', { reason: '误发' }, 'user-test-session')).status, 403);
    assert.equal((await request(`/admin/vouchers/${created.voucher.id}/revoke`, 'POST', { reason: '' })).status, 400);
    const revoke = await request(`/admin/vouchers/${created.voucher.id}/revoke`, 'POST', { reason: '兑换码遗失，重新发放' });
    assert.equal(revoke.status, 200); assert.equal((await revoke.json()).voucher.status, 'revoked');
    assert.equal((await request('/wallet/redeem', 'POST', { code: created.code }, 'user-test-session')).status, 400);
    assert.equal(store.user(user.id).credits, 0);
    const second: CreatedVoucher = await request('/admin/vouchers', 'POST', { credits: 800, days: 7 }).then(r => r.json());
    const redeemed = await request('/wallet/redeem', 'POST', { code: second.code }, 'user-test-session'); assert.equal(redeemed.status, 200); assert.equal((await redeemed.json()).user.credits, 800);
    assert.equal((await request(`/admin/vouchers/${second.voucher.id}/revoke`, 'POST', { reason: '事后撤回' })).status, 409);
    const redeemedList: VoucherList = await request('/admin/vouchers?status=redeemed').then(r => r.json());
    assert.equal(redeemedList.total, 1); assert.equal(redeemedList.vouchers[0].redeemedBy?.id, user.id);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
