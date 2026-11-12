import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';

const fixture = () => { const store = new Store(':memory:'); const user = store.createUser('creator@example.com', 'Creator', 'not-a-real-password-hash', 100); return { store, user }; };
function create(store: Store, userId: string, overrides = {}) {
  return store.createTask({ userId, prompt: 'A beautiful room', mode: 'generate', size: '1024x1024', quality: 'standard', count: 2, model: 'test', provider: 'mock', unitPrice: 12, key: randomUUID(), maxActive: 2, ...overrides });
}
test('reservation and duplicate submission debit exactly once; conflicting retries are rejected', () => {
  const { store, user } = fixture();
  try {
    const key = randomUUID(); const first = create(store, user.id, { key }); const second = create(store, user.id, { key });
    assert.equal(first.id, second.id); assert.equal(store.user(user.id).credits, 76); assert.equal(store.user(user.id).frozen, 24);
    assert.throws(() => create(store, user.id, { key, prompt: 'different request' }), /重复提交标识/);
    assert.equal(store.tasks(user.id).length, 1); assert.equal(store.ledger(user.id).length, 2);
  } finally { store.close(); }
});
test('insufficient credit and active task limits roll back all accounting changes', () => {
  const { store, user } = fixture();
  try {
    assert.throws(() => create(store, user.id, { count: 4, unitPrice: 100 }), /积分不足/);
    assert.equal(store.user(user.id).credits, 100); assert.equal(store.tasks(user.id).length, 0);
    create(store, user.id); create(store, user.id);
    assert.throws(() => create(store, user.id), /进行中的任务/);
    assert.equal(store.user(user.id).credits, 52); assert.equal(store.user(user.id).frozen, 48);
  } finally { store.close(); }
});
test('partial delivery refunds only undelivered images; repeated settlement is harmless', () => {
  const { store, user } = fixture();
  try {
    const task = create(store, user.id); store.claimTask();
    const asset = store.addAsset(user.id, 'test-output.png', 1024, 1024, 'output');
    assert.equal(store.settleTask(task.id, [asset]), true);
    assert.equal(store.settleTask(task.id, [asset]), false);
    assert.equal(store.taskRow(task.id).status, 'partial'); assert.equal(store.user(user.id).credits, 88); assert.equal(store.user(user.id).frozen, 0);
    const ledger = store.ledger(user.id); assert.equal(ledger.reduce((sum, r) => sum + r.delta, 0), 88); assert.equal(ledger.reduce((sum, r) => sum + r.frozenDelta, 0), 0);
  } finally { store.close(); }
});
test('interruptions keep credits frozen and never automatically resubmit the upstream call', () => {
  const { store, user } = fixture();
  try {
    const task = create(store, user.id); store.claimTask(); store.recoverInterrupted();
    assert.equal(store.taskRow(task.id).status, 'uncertain'); assert.equal(store.user(user.id).frozen, 24); assert.equal(store.claimTask(), undefined);
    store.settleTask(task.id, [], 'Reviewed failure'); assert.equal(store.user(user.id).credits, 100); assert.equal(store.user(user.id).frozen, 0);
  } finally { store.close(); }
});
test('cross-account assets and duplicate output IDs cannot be settled', () => {
  const { store, user } = fixture();
  try {
    const other = store.createUser('other@example.com', 'Other', 'hash'); const task = create(store, user.id); store.claimTask();
    const asset = store.addAsset(other.id, 'private.png', 100, 100, 'output');
    assert.throws(() => store.asset(asset.id, user.id), /无权访问/);
    assert.throws(() => store.settleTask(task.id, [asset]), /无权访问/);
    const own = store.addAsset(user.id, 'own.png', 100, 100, 'output'); assert.throws(() => store.settleTask(task.id, [own, own]), /count/);
    assert.equal(store.user(user.id).frozen, 24);
  } finally { store.close(); }
});
test('a voucher can be redeemed once only, even from another account', () => {
  const { store, user } = fixture();
  try {
    store.createVoucher('IMG-ONE-TIME', 50, new Date(Date.now() + 60000).toISOString());
    assert.equal(store.redeem(user.id, 'img-one-time').credits, 150);
    const other = store.createUser('other@example.com', 'Other', 'hash');
    assert.throws(() => store.redeem(other.id, 'IMG-ONE-TIME'), /已使用/); assert.equal(store.user(other.id).credits, 0);
  } finally { store.close(); }
});
