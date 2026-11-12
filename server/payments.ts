import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { AppError, type OrderRow, type Store } from './store.js';

export function epaySign(params: Record<string, string>, key: string) {
  const message = Object.keys(params).filter(k => !['sign', 'sign_type'].includes(k) && params[k] !== '').sort().map(k => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(message + key, 'utf8').digest('hex');
}
export function checkoutUrl(config: Config, order: OrderRow) {
  const params: Record<string, string> = { pid: config.EPAY_MERCHANT_ID!, type: order.method, out_trade_no: order.id,
    notify_url: `${config.publicOrigin}/api/payments/notify`, return_url: `${config.publicOrigin}/?page=wallet&order=${order.id}`,
    name: `${config.APP_NAME} ${order.credits}积分`, money: (order.cents / 100).toFixed(2), sign_type: 'MD5' };
  params.sign = epaySign(params, config.EPAY_MERCHANT_KEY!);
  const url = new URL('submit.php', config.EPAY_BASE_URL!.replace(/\/?$/, '/'));
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}
export function processNotification(config: Config, store: Store, params: Record<string, string>) {
  if (config.PAYMENT_PROVIDER !== 'epay') throw new AppError(503, '支付尚未开启');
  if (params.pid !== config.EPAY_MERCHANT_ID || params.sign_type !== 'MD5' || !/^[a-f0-9]{32}$/i.test(params.sign || '')) throw new AppError(400, '支付通知无效');
  const expected = Buffer.from(epaySign(params, config.EPAY_MERCHANT_KEY!), 'hex');
  const actual = Buffer.from(params.sign, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AppError(400, '支付签名无效');
  if (params.trade_status !== 'TRADE_SUCCESS') throw new AppError(400, '支付尚未成功');
  if (!/^\d{1,8}\.\d{2}$/.test(params.money || '') || !/^[a-zA-Z0-9_-]{1,100}$/.test(params.trade_no || '')) throw new AppError(400, '支付金额或交易编号无效');
  const [whole, fraction] = params.money.split('.');
  store.payOrder(params.out_trade_no, Number(whole) * 100 + Number(fraction), params.trade_no, params.type);
}
