import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { epaySign, processNotification, checkoutUrl } from '../server/payments.js';

const config = loadConfig({ NODE_ENV: 'test', IMAGE_PROVIDER: 'newapi', NEW_API_BASE_URL: 'https://newapi.example.com/v1', NEW_API_KEY: 'test-key', PAYMENT_PROVIDER: 'epay', EPAY_BASE_URL: 'https://payments.example.com/', EPAY_MERCHANT_ID: '123', EPAY_MERCHANT_KEY: 'test-merchant-key', PUBLIC_ORIGIN: 'https://image.yidianhub.com' });
function notification(id: string, overrides: Record<string, string> = {}) {
  const params: Record<string, string> = { pid: '123', out_trade_no: id, trade_no: 'GATEWAY123', money: '19.90', type: 'wxpay', trade_status: 'TRADE_SUCCESS', sign_type: 'MD5', ...overrides };
  params.sign = epaySign(params, config.EPAY_MERCHANT_KEY!); return params;
}
test('verified payments credit once; wrong amount, method, signature and reused transaction are rejected', () => {
  const store = new Store(':memory:'); const user = store.createUser('payer@example.com', 'Payer', 'hash');
  try {
    const order = store.createOrder(user.id, 1990, 200, 'wxpay');
    assert.throws(() => processNotification(config, store, { ...notification(order.id), money: '0.01' }), /签名/);
    assert.throws(() => processNotification(config, store, notification(order.id, { money: '0.01' })), /不一致/);
    assert.throws(() => processNotification(config, store, notification(order.id, { type: 'alipay' })), /不一致/);
    processNotification(config, store, notification(order.id)); processNotification(config, store, notification(order.id));
    assert.equal(store.user(user.id).credits, 200); assert.equal(store.ledger(user.id).length, 1);
    const second = store.createOrder(user.id, 1990, 200, 'wxpay');
    assert.throws(() => processNotification(config, store, notification(second.id)), /已使用/); assert.equal(store.user(user.id).credits, 200);
    const url = new URL(checkoutUrl(config, order)); assert.equal(url.origin, 'https://payments.example.com'); assert.equal(url.searchParams.get('money'), '19.90');
    assert.equal(url.searchParams.get('notify_url'), 'https://image.yidianhub.com/api/payments/notify');
  } finally { store.close(); }
});
test('signed late payments still credit real money once; browser return alone cannot pay an order', () => {
  const store = new Store(':memory:'); const user = store.createUser('payer@example.com', 'Payer', 'hash');
  try {
    const order = store.createOrder(user.id, 1990, 200, 'wxpay');
    store.db.prepare('UPDATE orders SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', order.id);
    checkoutUrl(config, order); assert.equal(store.user(user.id).credits, 0);
    processNotification(config, store, notification(order.id)); assert.equal(store.user(user.id).credits, 200);
  } finally { store.close(); }
});
