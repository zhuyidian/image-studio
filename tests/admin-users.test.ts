import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MediaStore } from '../server/media.js';

function createTask(store: Store, userId: string, prompt: string, unitPrice = 2) {
  return store.createTask({ userId, prompt, mode: 'generate', size: '1024x1024', quality: 'standard', count: 1, model: 'test-image-model', provider: 'mock', unitPrice, key: randomUUID(), maxActive: 10 });
}
test('all users remain accessible beyond 100 accounts; search is literal and roles/counts are accurate', () => {
  const store = new Store(':memory:');
  try {
    const admin = store.createUser('admin@example.com', '管理员', 'SECRET-PASSWORD-HASH', 10, 'admin');
    for (let index = 0; index < 125; index++) store.createUser(`creator-${index}@example.com`, `创作者 ${index}`, 'SECRET-PASSWORD-HASH');
    const special = store.createUser('literal@example.com', '活动%_创作者', 'SECRET-PASSWORD-HASH');
    const unicode = store.createUser('MiXeD@Example.com', '设计师小林', 'SECRET-PASSWORD-HASH');
    const overview = store.adminOverview(); assert.equal(overview.totalUsers, 128); assert.equal(overview.totalAdmins, 1);
    assert.equal(overview.totalAvailableCredits, 10); assert.equal(overview.totalFrozenCredits, 0);
    assert.equal(overview.recentUsers.length, 5); assert.equal(overview.recentUsers[0].id, unicode.id);
    const allIds: string[] = [];
    for (let page = 1; page <= 7; page++) {
      const users = store.adminUsers('', 'all', page); assert.equal(users.total, 128); assert.equal(users.pageSize, 20);
      allIds.push(...users.items.map(u => u.id));
    }
    assert.equal(allIds.length, 128); assert.equal(new Set(allIds).size, 128); assert.ok(allIds.includes(admin.id));
    assert.equal(store.adminUsers('', 'all', 999).page, 7);
    assert.equal(store.adminUsers('', 'admin').items[0].id, admin.id); assert.equal(store.adminUsers('', 'user').total, 127);
    assert.equal(store.adminUsers('mixed@example.COM').items[0].id, unicode.id);
    assert.equal(store.adminUsers('小林').items[0].id, unicode.id);
    assert.equal(store.adminUsers(unicode.id).items[0].id, unicode.id);
    assert.equal(store.adminUsers('%_').total, 1); assert.equal(store.adminUsers('%_').items[0].id, special.id);
    assert.equal(store.adminUsers("' OR 1=1 --").total, 0);
    assert.equal(store.adminUsers('小林', 'admin').total, 0);
    const json = JSON.stringify([store.adminUsers(), store.adminUserDetail(admin.id), overview]);
    assert.equal(json.includes('SECRET-PASSWORD-HASH'), false); assert.equal(json.includes('password'), false);
    assert.ok(store.adminUsers().items[0].createdAt);
  } finally { store.close(); }
});

test('user histories are paginated and isolated; old uncertain tasks are counted and remain searchable', () => {
  const store = new Store(':memory:');
  try {
    const admin = store.createUser('admin@example.com', '管理员', 'hash', 0, 'admin');
    const owner = store.createUser('owner@example.com', '创作者小林', 'hash', 10000);
    const other = store.createUser('other@example.com', '另一用户', 'hash', 50);
    const pending = createTask(store, owner.id, 'older uncertain task', 12);
    store.claimTask(); store.markUncertain(pending.id);
    const output = store.addAsset(owner.id, 'fake-output.png', 10, 10, 'output');
    for (let index = 0; index < 110; index++) {
      const task = createTask(store, owner.id, `history task ${index}`); store.claimTask(); store.settleTask(task.id, [output]);
    }
    const otherTask = createTask(store, other.id, 'unrelated task', 5);
    for (let index = 0; index < 21; index++) {
      const code = `IMG-OWNER-${index.toString().padStart(8, '0')}`;
      store.createVoucher(code, 5, new Date(Date.now() + 86400000).toISOString(), { createdBy: admin.id }); store.redeem(owner.id, code);
    }
    store.createVoucher('IMG-OTHER-VOUCHER', 9, new Date(Date.now() + 86400000).toISOString()); store.redeem(other.id, 'IMG-OTHER-VOUCHER');
    store.createVoucher('IMG-NOT-REDEEMED', 999, new Date(Date.now() + 86400000).toISOString(), { createdBy: admin.id });
    for (let index = 0; index < 107; index++) store.createOrder(owner.id, 1990, 200, 'wxpay');
    const paid = store.createOrder(owner.id, 1990, 200, 'wxpay'); store.payOrder(paid.id, 1990, 'trade-001', 'wxpay');
    const overview = store.adminOverview();
    assert.equal(overview.totalUsers, 3); assert.equal(overview.totalTasks, 112); assert.equal(overview.uncertainTasks, 1);
    assert.equal(overview.totalOrders, 108); assert.equal(overview.paidOrders, 1); assert.equal(overview.totalFrozenCredits, 17);
    const detail = store.adminUserDetail(owner.id);
    assert.equal(detail.stats.totalTasks, 111); assert.equal(detail.stats.chargedCredits, 220); assert.equal(detail.stats.redeemedVouchers, 21);
    assert.equal(detail.user.credits, 10000 - 12 - 220 + 105 + 200); assert.equal(detail.user.frozen, 12);
    assert.ok(detail.stats.ledgerEntries > 100);
    const entries = store.adminUserLedger(owner.id, 6); assert.equal(entries.items.length, 20); assert.equal(entries.total, detail.stats.ledgerEntries);
    assert.ok(entries.items.every(e => e.note !== 'unrelated'));
    const vouchers = store.adminUserVouchers(owner.id, 2); assert.equal(vouchers.total, 21); assert.equal(vouchers.items.length, 1);
    assert.ok(vouchers.items.every(v => v.redeemedBy?.id === owner.id));
    const tasks = store.adminTasks('all', '', 6, owner.id); assert.equal(tasks.total, 111); assert.equal(tasks.items.length, 11);
    assert.ok(tasks.items.every(t => t.user.id === owner.id)); assert.ok(tasks.items.some(t => t.id === pending.id));
    const uncertain = store.adminTasks('uncertain'); assert.equal(uncertain.total, 1); assert.equal(uncertain.items[0].id, pending.id);
    assert.equal(store.adminTasks('queued').items[0].id, otherTask.id);
    assert.equal(store.adminTasks('all', 'OWNER@EXAMPLE.COM').total, 111);
    assert.equal(store.adminTasks('all', '小林').total, 111);
    assert.equal(store.adminTasks('all', pending.id).items[0].id, pending.id);
    assert.equal(store.adminTasks('all', 'history task 109').total, 1);
    assert.equal(store.adminTasks('all', '%_').total, 0);
    const safeJson = JSON.stringify([detail, store.adminUserVouchers(owner.id), store.adminUserLedger(owner.id), store.adminTasks()]);
    for (const secret of ['code_hash', 'event_key', 'idempotency_key', 'usage_json', 'password']) assert.equal(safeJson.includes(secret), false);
    assert.equal('outputs' in store.adminTasks().items[0], false);
    const balance = store.user(other.id).credits; store.adminUserDetail(other.id); store.adminUserLedger(other.id); assert.equal(store.user(other.id).credits, balance);
    for (const read of [() => store.adminUserDetail(randomUUID()), () => store.adminUserLedger(randomUUID()), () => store.adminUserVouchers(randomUUID()), () => store.adminTasks('all', '', 1, randomUUID())]) assert.throws(read, /用户不存在/);
  } finally { store.close(); }
});

test('admin user and task HTTP endpoints enforce access, pagination and validation', async () => {
  const store = new Store(':memory:');
  const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:5173' });
  const admin = store.createUser('admin@example.com', '管理员', 'SECRET-HASH', 0, 'admin');
  const user = store.createUser('creator@example.com', '创作者', 'SECRET-HASH', 100);
  for (let index = 0; index < 103; index++) store.createUser(`http-${index}@example.com`, `HTTP ${index}`, 'SECRET-HASH');
  store.createSession(admin.id, 'admin-test-session'); store.createSession(user.id, 'regular-test-session');
  const task = createTask(store, user.id, 'HTTP testing'); store.claimTask(); store.markUncertain(task.id);
  const server = createApp(config, store, new MediaStore(store, path.join(tmpdir(), 'unused-admin-media'))).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = (route: string, token = 'admin-test-session', method = 'GET', body?: unknown) => fetch(base + route, { method,
    headers: { Cookie: `studio_session=${token}`, Origin: config.origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const protectedRoutes = ['/admin', '/admin/users', `/admin/users/${user.id}`, `/admin/users/${user.id}/ledger`, `/admin/users/${user.id}/vouchers`, `/admin/users/${user.id}/tasks`, '/admin/tasks'];
    for (const route of protectedRoutes) {
      assert.equal((await request(route, '')).status, 401, route);
      assert.equal((await request(route, 'regular-test-session')).status, 403, route);
      const response = await request(route); assert.equal(response.status, 200, route);
      const json = JSON.stringify(await response.json()); assert.equal(json.includes('SECRET-HASH'), false); assert.equal(json.includes('password'), false);
    }
    assert.equal((await request('/admin').then(r => r.json())).totalUsers, 105);
    const lastPage = await request('/admin/users?page=6').then(r => r.json()); assert.equal(lastPage.items.length, 5); assert.equal(lastPage.total, 105); assert.ok(lastPage.items.some((u: { id: string }) => u.id === admin.id));
    const filtered = await request(`/admin/users?q=${encodeURIComponent('creator@example.com')}&role=user`).then(r => r.json()); assert.equal(filtered.total, 1); assert.equal(filtered.items[0].id, user.id);
    assert.equal((await request('/admin/users?role=admin').then(r => r.json())).total, 1);
    for (const route of ['/admin/users?page=0', '/admin/users?page=1.5', '/admin/users?role=owner', `/admin/users?q=${'x'.repeat(255)}`, '/admin/users/not-a-uuid', `/admin/users/${user.id}/ledger?page=-1`, `/admin/users/${user.id}/vouchers?page=0`, `/admin/users/${user.id}/tasks?page=-2`, '/admin/tasks?status=unknown', '/admin/tasks?page=0']) assert.equal((await request(route)).status, 400, route);
    const missing = randomUUID();
    for (const suffix of ['', '/ledger', '/vouchers', '/tasks']) assert.equal((await request(`/admin/users/${missing}${suffix}`)).status, 404);
    const uncertain = await request('/admin/tasks?status=uncertain').then(r => r.json()); assert.equal(uncertain.total, 1); assert.equal(uncertain.items[0].user.id, user.id);
    const unauthorized = await request(`/admin/tasks/${task.id}/release`, 'regular-test-session', 'POST', { reason: '已核对没有交付产物，仅用于测试' }); assert.equal(unauthorized.status, 403);
    const release = await request(`/admin/tasks/${task.id}/release`, 'admin-test-session', 'POST', { reason: '已核对没有交付产物，仅用于测试' }); assert.equal(release.status, 200);
    assert.equal((await request('/admin').then(r => r.json())).uncertainTasks, 0);
    const after = await request(`/admin/users/${user.id}`).then(r => r.json()); assert.equal(after.user.credits, 100); assert.equal(after.user.frozen, 0);
    assert.equal((await request(`/admin/tasks/${task.id}/release`, 'admin-test-session', 'POST', { reason: '再次核对没有交付产物，仅用于测试' })).status, 409);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
