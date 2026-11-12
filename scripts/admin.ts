import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import { Accounts } from '../server/accounts.js';
import { createMailDelivery } from '../server/mail.js';

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });
const store = new Store(path.join(config.dataDir, 'studio.sqlite'));
const [command, value] = process.argv.slice(2);
try {
  if (command === 'promote' && value) {
    const user = store.findUser(value.toLowerCase());
    if (!user) throw new Error('请先通过网站注册此账户');
    if (user.status !== 'active') throw new Error('请先恢复此账户再设置管理员');
    store.tx(() => {
      store.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
      store.audit(user.id, 'admin.promote.cli', user.id, 'Local CLI administrator promotion');
    });
    console.log('管理员权限已开通，刷新网站后生效。');
  } else if (command === 'registration' && ['true', 'false'].includes(value)) {
    const accounts = new Accounts(store, config, createMailDelivery(config));
    const policy = accounts.policy();
    store.tx(() => {
      store.db.prepare('UPDATE account_policy SET config_json=? WHERE id=1').run(JSON.stringify({ ...policy, registration: value === 'true', revision: policy.revision + 1 }));
      const actor = store.db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
      if (actor) store.audit(actor.id, 'account.registration.cli', 'account_policy', `服务器终端设置注册开关为 ${value}`);
    });
    console.log(`新用户注册已${value === 'true' ? '开启' : '关闭'}。邮箱验证要求和赠送积分不变。`);
  } else if (command === 'voucher') {
    const credits = Number(value || 200);
    if (!Number.isInteger(credits) || credits < 1 || credits > 100000) throw new Error('积分必须为 1–100000 的整数');
    const code = `IMG-${randomBytes(12).toString('hex').toUpperCase()}`;
    store.createVoucher(code, credits, new Date(Date.now() + 30 * 86400000).toISOString());
    console.log(`30天内有效的一次性兑换码（${credits}积分）：\n${code}`);
  } else console.log('用法：npm run admin -- promote user@example.com\n      npm run admin -- voucher 200\n      npm run admin -- registration true|false\n生产容器：node dist/scripts/admin.js <同样参数>');
} finally { store.close(); }
