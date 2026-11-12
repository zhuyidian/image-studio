import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { Asset, LedgerEntry, Task, User, TaskMode, ImageSize, Quality, Voucher, VoucherList, VoucherStatus, AdminUser, AdminUserDetail, AdminTask, AdminOverview, PageResult, TaskStatus, ModelTaskSnapshot } from '../shared/types.js';

export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_ERROR') { super(message); }
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const voucherStatusSql = "CASE WHEN v.redeemed_by IS NOT NULL THEN 'redeemed' WHEN v.revoked_at IS NOT NULL THEN 'revoked' WHEN v.expires_at <= ? THEN 'expired' ELSE 'unused' END";
type UserRow = { id: string; email: string; name: string; role: 'user' | 'admin'; credits: number; frozen: number; password: string; created_at: string };
const userColumns = 'id,email,name,role,credits,frozen,created_at';
const pageInfo = (total: number, requestedPage: number) => {
  const pageSize = 20;
  const page = Math.min(Math.max(1, Math.trunc(requestedPage)), Math.max(1, Math.ceil(total / pageSize)));
  return { total, page, pageSize };
};
export type AssetRow = { id: string; user_id: string; filename: string; width: number; height: number; kind: Asset['kind'] };
export type TaskRow = {
  id: string; user_id: string; prompt: string; mode: TaskMode; status: Task['status']; size: ImageSize;
  quality: Quality; count: number; model: string; provider: string; reserved: number; unit_price: number; charged: number;
  reference_id: string | null; mask_id: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  error: string | null; idempotency_key: string; fingerprint: string;
  catalog_model_id: string | null; model_name: string | null; model_config_json: string | null;
  admin_test: number;
};
export type OrderRow = { id: string; user_id: string; cents: number; credits: number; status: string; method: string; provider_trade_no: string | null; created_at: string; expires_at: string };

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user', credits INTEGER NOT NULL DEFAULT 0 CHECK(credits >= 0),
        frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen >= 0), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS users_created ON users(created_at);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL UNIQUE,
        width INTEGER NOT NULL, height INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), prompt TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL, size TEXT NOT NULL, quality TEXT NOT NULL, count INTEGER NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL, reserved INTEGER NOT NULL, unit_price INTEGER NOT NULL,
        charged INTEGER NOT NULL DEFAULT 0, reference_id TEXT REFERENCES assets(id), mask_id TEXT REFERENCES assets(id),
        idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, error TEXT, upstream_request_id TEXT, usage_json TEXT,
        UNIQUE(user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id, created_at);
      CREATE TABLE IF NOT EXISTS task_assets (task_id TEXT NOT NULL REFERENCES tasks(id), asset_id TEXT NOT NULL REFERENCES assets(id), PRIMARY KEY(task_id, asset_id));
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
        delta INTEGER NOT NULL, frozen_delta INTEGER NOT NULL, note TEXT NOT NULL, task_id TEXT REFERENCES tasks(id),
        event_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_owner ON ledger(user_id, created_at);
      CREATE TABLE IF NOT EXISTS vouchers (
        code_hash TEXT PRIMARY KEY, credits INTEGER NOT NULL CHECK(credits > 0), expires_at TEXT NOT NULL,
        redeemed_by TEXT REFERENCES users(id), redeemed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), cents INTEGER NOT NULL CHECK(cents > 0),
        credits INTEGER NOT NULL CHECK(credits > 0), method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        provider_trade_no TEXT UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, paid_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
        target_id TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    // Add metadata without changing existing code hashes, expiry dates or redemption records.
    this.tx(() => {
      const columns = new Set((this.db.prepare('PRAGMA table_info(vouchers)').all() as { name: string }[]).map(c => c.name));
      const additions = [
        ['id', 'TEXT'], ['suffix', 'TEXT'], ['note', "TEXT NOT NULL DEFAULT ''"],
        ['created_by', 'TEXT REFERENCES users(id)'], ['revoked_at', 'TEXT'], ['revoked_by', 'TEXT REFERENCES users(id)'],
      ];
      for (const [name, definition] of additions) if (!columns.has(name)) this.db.exec(`ALTER TABLE vouchers ADD COLUMN ${name} ${definition}`);
      const missing = this.db.prepare('SELECT code_hash FROM vouchers WHERE id IS NULL').all() as { code_hash: string }[];
      for (const row of missing) this.db.prepare('UPDATE vouchers SET id=? WHERE code_hash=?').run(randomUUID(), row.code_hash);
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS vouchers_id ON vouchers(id); CREATE INDEX IF NOT EXISTS vouchers_created ON vouchers(created_at); CREATE INDEX IF NOT EXISTS vouchers_redeemed ON vouchers(redeemed_by,redeemed_at);');
      const taskColumns = new Set((this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name));
      for (const column of ['catalog_model_id', 'model_name', 'model_config_json']) if (!taskColumns.has(column)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      if (!taskColumns.has('admin_test')) this.db.exec('ALTER TABLE tasks ADD COLUMN admin_test INTEGER NOT NULL DEFAULT 0 CHECK(admin_test IN (0,1))');
    });
  }
  close() { this.db.close(); }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private entry(userId: string, kind: string, delta: number, frozenDelta: number, note: string, key: string, taskId: string | null = null) {
    this.db.prepare('INSERT INTO ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), userId, kind, delta, frozenDelta, note, taskId, key, now());
  }
  findUser(email: string) { return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined; }
  user(id: string): User {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!u) throw new AppError(401, '请先登录', 'UNAUTHENTICATED');
    return { id: u.id, email: u.email, name: u.name, role: u.role, credits: u.credits, frozen: u.frozen };
  }
  createUser(email: string, name: string, password: string, credits = 0, role = 'user'): User {
    return this.tx(() => {
      if (this.findUser(email)) throw new AppError(409, '此邮箱已注册');
      const id = randomUUID();
      this.db.prepare('INSERT INTO users (id,email,name,password,role,credits,created_at) VALUES (?,?,?,?,?,?,?)').run(id, email, name, password, role, credits, now());
      if (credits) this.entry(id, 'welcome', credits, 0, '新用户体验积分', `welcome:${id}`);
      return this.user(id);
    });
  }
  createSession(userId: string, token: string) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), userId, new Date(Date.now() + 7 * 86400000).toISOString());
  }
  session(token: string | undefined): User | undefined {
    if (!token) return;
    const s = this.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hash(token), now()) as { user_id: string } | undefined;
    return s ? this.user(s.user_id) : undefined;
  }
  revokeSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token)); }
  asset(id: string, userId: string): AssetRow {
    const a = this.db.prepare('SELECT * FROM assets WHERE id = ? AND user_id = ?').get(id, userId) as AssetRow | undefined;
    if (!a) throw new AppError(404, '图片不存在或无权访问');
    return a;
  }
  addAsset(userId: string, filename: string, width: number, height: number, kind: Asset['kind']) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(id, userId, filename, width, height, kind, now());
    return this.assetView({ id, user_id: userId, filename, width, height, kind });
  }
  assetView(a: AssetRow): Asset { return { id: a.id, url: `/api/assets/${a.id}`, width: a.width, height: a.height, kind: a.kind }; }
  taskRow(id: string, userId?: string): TaskRow {
    const row = userId
      ? this.db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId)
      : this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new AppError(404, '任务不存在或无权访问');
    return row as TaskRow;
  }
  taskView(t: TaskRow): Task {
    const outputs = this.db.prepare('SELECT a.* FROM assets a JOIN task_assets ta ON ta.asset_id=a.id WHERE ta.task_id=? ORDER BY a.created_at, a.id').all(t.id) as AssetRow[];
    return { id: t.id, prompt: t.prompt, mode: t.mode, status: t.status, size: t.size, quality: t.quality, count: t.count,
      model: t.model, provider: t.provider, reserved: t.reserved, charged: t.charged, createdAt: t.created_at,
      finishedAt: t.finished_at, error: t.error, referenceId: t.reference_id, maskId: t.mask_id, modelId: t.catalog_model_id, modelName: t.model_name ?? t.model, isTest: Boolean(t.admin_test), outputs: outputs.map(a => this.assetView(a)) };
  }
  tasks(userId: string) { return (this.db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId) as TaskRow[]).map(t => this.taskView(t)); }
  existingTask(userId: string, key: string, fingerprint: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND idempotency_key=?').get(userId, key) as TaskRow | undefined;
    if (!row) return;
    if (row.fingerprint !== fingerprint) throw new AppError(409, '重复提交标识已用于另一项任务');
    return this.taskView(row);
  }
  createTask(input: { userId: string; prompt: string; mode: TaskMode; size: ImageSize; quality: Quality; count: number; model: string; provider: string; unitPrice: number; referenceId?: string; maskId?: string; key: string; maxActive: number; snapshot?: ModelTaskSnapshot; requestFingerprint?: string; adminTest?: boolean }) {
    const fingerprint = input.requestFingerprint ?? hash(JSON.stringify([input.prompt, input.mode, input.size, input.quality, input.count, input.model, input.referenceId ?? null, input.maskId ?? null]));
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND idempotency_key=?').get(input.userId, input.key) as TaskRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError(409, '重复提交标识已用于另一项任务');
        return this.taskView(existing);
      }
      const active = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id=? AND status IN ('queued','running','uncertain')").get(input.userId) as { n: number };
      if (active.n >= input.maxActive) throw new AppError(429, '进行中的任务较多，请等待完成');
      const cost = input.unitPrice * input.count;
      const updated = this.db.prepare('UPDATE users SET credits=credits-?,frozen=frozen+? WHERE id=? AND credits>=?').run(cost, cost, input.userId, cost);
      if (!updated.changes) throw new AppError(402, '积分不足，请先补充积分', 'INSUFFICIENT_CREDITS');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO tasks (id,user_id,prompt,mode,status,size,quality,count,model,provider,reserved,unit_price,reference_id,mask_id,idempotency_key,fingerprint,created_at)
        VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.userId, input.prompt, input.mode, input.size, input.quality, input.count, input.model, input.provider, cost, input.unitPrice, input.referenceId ?? null, input.maskId ?? null, input.key, fingerprint, now());
      if (input.snapshot) this.db.prepare('UPDATE tasks SET catalog_model_id=?,model_name=?,model_config_json=? WHERE id=?').run(input.snapshot.catalogModelId, input.snapshot.name, JSON.stringify(input.snapshot), id);
      if (input.adminTest) {
        this.db.prepare('UPDATE tasks SET admin_test=1 WHERE id=?').run(id);
        this.audit(input.userId, 'model.test.submit', id, JSON.stringify({ modelId: input.snapshot?.catalogModelId, model: input.model, mode: input.mode, reservedCredits: cost }));
      }
      this.entry(input.userId, 'reserve', -cost, cost, '任务提交，冻结预计积分', `reserve:${id}`, id);
      return this.taskView(this.taskRow(id));
    });
  }
  claimTask(): TaskRow | undefined {
    return this.tx(() => {
      const t = this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1").get() as TaskRow | undefined;
      if (!t) return;
      this.db.prepare("UPDATE tasks SET status='running',started_at=? WHERE id=? AND status='queued'").run(now(), t.id);
      return this.taskRow(t.id);
    });
  }
  settleTask(id: string, assets: Asset[], error: string | null = null, requestId?: string, usage?: unknown, adminAudit?: { actorId: string; note: string }): boolean {
    return this.tx(() => {
      const t = this.taskRow(id);
      if (adminAudit && t.status !== 'uncertain') throw new AppError(409, '只可处理结果待确认的任务');
      if (!['running', 'uncertain'].includes(t.status)) return false;
      if (assets.length > t.count || new Set(assets.map(a => a.id)).size !== assets.length) throw new Error('Invalid settlement output count');
      for (const a of assets) {
        const owned = this.asset(a.id, t.user_id);
        if (owned.kind !== 'output') throw new Error('Invalid settlement output kind');
        this.db.prepare('INSERT INTO task_assets VALUES (?,?)').run(id, a.id);
      }
      const charged = t.unit_price * assets.length;
      const refund = t.reserved - charged;
      const status = assets.length === 0 ? 'failed' : assets.length === t.count ? 'succeeded' : 'partial';
      this.db.prepare('UPDATE users SET credits=credits+?,frozen=frozen-? WHERE id=?').run(refund, t.reserved, t.user_id);
      this.db.prepare('UPDATE tasks SET status=?,charged=?,finished_at=?,error=?,upstream_request_id=?,usage_json=? WHERE id=?').run(status, charged, now(), error, requestId ?? null, usage ? JSON.stringify(usage) : null, id);
      this.entry(t.user_id, 'settle', refund, -t.reserved, assets.length ? `成功生成 ${assets.length} 张，结算 ${charged} 积分` : '生成失败，释放全部冻结积分', `settle:${id}`, id);
      if (adminAudit) this.audit(adminAudit.actorId, 'task.release', id, adminAudit.note);
      return true;
    });
  }
  markUncertain(id: string) {
    this.db.prepare("UPDATE tasks SET status='uncertain',error=? WHERE id=? AND status='running'").run('生成结果尚未确认，积分暂时冻结。我们会核对结果，请勿重复提交。', id);
  }
  recoverInterrupted() {
    this.db.prepare("UPDATE tasks SET status='uncertain',error=? WHERE status='running'").run('服务重启，正在核对上游结果；积分暂时冻结。',);
  }
  ledger(userId: string): LedgerEntry[] {
    return (this.db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100').all(userId) as Record<string, unknown>[]).map(r => this.ledgerView(r));
  }
  private ledgerView(r: Record<string, unknown>): LedgerEntry {
    return { id: String(r.id), kind: String(r.kind), delta: Number(r.delta), frozenDelta: Number(r.frozen_delta), note: String(r.note), taskId: r.task_id ? String(r.task_id) : null, createdAt: String(r.created_at) };
  }
  private voucherView(row: Record<string, unknown>): Voucher {
    const person = (prefix: string) => row[`${prefix}_id`] ? { id: String(row[`${prefix}_id`]), name: String(row[`${prefix}_name`]), email: String(row[`${prefix}_email`]) } : null;
    return { id: String(row.id), suffix: row.suffix ? String(row.suffix) : null, credits: Number(row.credits), status: row.status as VoucherStatus,
      note: String(row.note), createdAt: String(row.created_at), expiresAt: String(row.expires_at), createdBy: person('creator'),
      redeemedAt: row.redeemed_at ? String(row.redeemed_at) : null, redeemedBy: person('redeemer'),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null, revokedBy: person('revoker') };
  }
  private voucherQuery() {
    return `SELECT v.id,v.suffix,v.credits,v.note,v.created_at,v.expires_at,v.redeemed_at,v.revoked_at,${voucherStatusSql} AS status,
      creator.id AS creator_id,creator.name AS creator_name,creator.email AS creator_email,
      redeemer.id AS redeemer_id,redeemer.name AS redeemer_name,redeemer.email AS redeemer_email,
      revoker.id AS revoker_id,revoker.name AS revoker_name,revoker.email AS revoker_email
      FROM vouchers v LEFT JOIN users creator ON creator.id=v.created_by
      LEFT JOIN users redeemer ON redeemer.id=v.redeemed_by LEFT JOIN users revoker ON revoker.id=v.revoked_by`;
  }
  voucher(id: string): Voucher {
    const row = this.db.prepare(`${this.voucherQuery()} WHERE v.id=?`).get(now(), id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, '兑换码记录不存在');
    return this.voucherView(row);
  }
  vouchers(status: VoucherStatus | 'all' = 'all', requestedPage = 1): VoucherList {
    const timestamp = now();
    const groups = this.db.prepare(`SELECT ${voucherStatusSql} AS status,COUNT(*) AS n FROM vouchers v GROUP BY status`).all(timestamp) as { status: VoucherStatus; n: number }[];
    const counts: VoucherList['counts'] = { all: 0, unused: 0, redeemed: 0, expired: 0, revoked: 0 };
    for (const group of groups) { counts[group.status] = group.n; counts.all += group.n; }
    const total = counts[status]; const pageSize = 20;
    const page = Math.min(Math.max(1, requestedPage), Math.max(1, Math.ceil(total / pageSize)));
    const where = status === 'all' ? '' : `WHERE (${voucherStatusSql})=?`;
    const parameters = status === 'all' ? [timestamp, pageSize, (page - 1) * pageSize] : [timestamp, timestamp, status, pageSize, (page - 1) * pageSize];
    const rows = this.db.prepare(`${this.voucherQuery()} ${where} ORDER BY v.created_at DESC,v.rowid DESC LIMIT ? OFFSET ?`).all(...parameters) as Record<string, unknown>[];
    return { vouchers: rows.map(row => this.voucherView(row)), total, page, pageSize, counts };
  }
  createVoucher(code: string, credits: number, expiresAt: string, metadata: { createdBy?: string; note?: string } = {}): Voucher {
    if (!Number.isSafeInteger(credits) || credits < 1 || credits > 100000) throw new AppError(400, '积分必须为 1–100000 的整数');
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new AppError(400, '兑换码截止时间必须晚于当前时间');
    if ((metadata.note?.length ?? 0) > 300) throw new AppError(400, '内部备注最多 300 个字');
    const normalized = code.trim().toUpperCase();
    return this.tx(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO vouchers (code_hash,credits,expires_at,created_at,id,suffix,note,created_by) VALUES (?,?,?,?,?,?,?,?)').run(hash(normalized), credits, expiry.toISOString(), now(), id, normalized.slice(-6), metadata.note?.trim() ?? '', metadata.createdBy ?? null);
      if (metadata.createdBy) this.audit(metadata.createdBy, 'voucher.create', id, JSON.stringify({ credits, expiresAt: expiry.toISOString(), note: metadata.note?.trim() ?? '' }));
      return this.voucher(id);
    });
  }
  revokeVoucher(id: string, actorId: string, reason: string): Voucher {
    return this.tx(() => {
      const timestamp = now();
      const existing = this.voucher(id);
      if (existing.status !== 'unused') throw new AppError(409, '仅未兑换且未过期的兑换码可以作废，请刷新记录');
      const updated = this.db.prepare('UPDATE vouchers SET revoked_at=?,revoked_by=? WHERE id=? AND redeemed_by IS NULL AND revoked_at IS NULL AND expires_at>?').run(timestamp, actorId, id, timestamp);
      if (!updated.changes) throw new AppError(409, '兑换码状态已变化，请刷新记录');
      this.audit(actorId, 'voucher.revoke', id, reason);
      return this.voucher(id);
    });
  }
  redeem(userId: string, code: string) {
    return this.tx(() => {
      const timestamp = now();
      const v = this.db.prepare('SELECT * FROM vouchers WHERE code_hash=?').get(hash(code.trim().toUpperCase())) as { id: string; code_hash: string; credits: number; redeemed_by: string | null; revoked_at: string | null; expires_at: string } | undefined;
      if (!v || v.redeemed_by || v.revoked_at || v.expires_at <= timestamp) throw new AppError(400, '兑换码无效、已使用、已过期或已作废');
      this.db.prepare('UPDATE vouchers SET redeemed_by=?,redeemed_at=? WHERE code_hash=?').run(userId, timestamp, v.code_hash);
      this.db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(v.credits, userId);
      this.entry(userId, 'redeem', v.credits, 0, '积分兑换码到账', `voucher:${v.code_hash}`);
      this.audit(userId, 'voucher.redeem', v.id, `${v.credits} 积分到账`);
      return this.user(userId);
    });
  }
  createOrder(userId: string, cents: number, credits: number, method: string): OrderRow {
    const id = `IS${Date.now()}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    this.db.prepare('INSERT INTO orders (id,user_id,cents,credits,method,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(id, userId, cents, credits, method, now(), new Date(Date.now() + 30 * 60000).toISOString());
    return this.order(id, userId);
  }
  order(id: string, userId: string): OrderRow {
    const o = this.db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(id, userId) as OrderRow | undefined;
    if (!o) throw new AppError(404, '订单不存在');
    return o;
  }
  payOrder(id: string, cents: number, tradeNo: string, method: string) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as OrderRow | undefined;
      if (!o || o.cents !== cents || o.method !== method) throw new AppError(400, '订单信息不一致');
      if (o.status === 'paid') {
        if (o.provider_trade_no !== tradeNo) throw new AppError(409, '交易编号不一致');
        return;
      }
      const collision = this.db.prepare('SELECT id FROM orders WHERE provider_trade_no=?').get(tradeNo);
      if (collision) throw new AppError(409, '交易编号已使用');
      // A signed late payment is still real money: credit exactly once, preserving the audit record.
      this.db.prepare("UPDATE orders SET status='paid',provider_trade_no=?,paid_at=? WHERE id=?").run(tradeNo, now(), id);
      this.db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(o.credits, o.user_id);
      this.entry(o.user_id, 'purchase', o.credits, 0, '积分购买到账', `payment:${o.id}`);
    });
  }
  private adminUserView(row: Omit<UserRow, 'password'>): AdminUser {
    return { id: row.id, email: row.email, name: row.name, role: row.role, credits: row.credits, frozen: row.frozen, createdAt: row.created_at };
  }
  private requireAdminUserRecord(userId: string): AdminUser {
    const row = this.db.prepare(`SELECT ${userColumns} FROM users WHERE id=?`).get(userId) as Omit<UserRow, 'password'> | undefined;
    if (!row) throw new AppError(404, '用户不存在');
    return this.adminUserView(row);
  }
  adminOverview(): AdminOverview {
    const users = this.db.prepare("SELECT COUNT(*) AS totalUsers,COALESCE(SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END),0) AS totalAdmins,COALESCE(SUM(credits),0) AS totalAvailableCredits,COALESCE(SUM(frozen),0) AS totalFrozenCredits FROM users").get() as Pick<AdminOverview, 'totalUsers' | 'totalAdmins' | 'totalAvailableCredits' | 'totalFrozenCredits'>;
    const tasks = this.db.prepare("SELECT COUNT(*) AS totalTasks,COALESCE(SUM(CASE WHEN status='uncertain' THEN 1 ELSE 0 END),0) AS uncertainTasks FROM tasks").get() as Pick<AdminOverview, 'totalTasks' | 'uncertainTasks'>;
    const orders = this.db.prepare("SELECT COUNT(*) AS totalOrders,COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS paidOrders FROM orders").get() as Pick<AdminOverview, 'totalOrders' | 'paidOrders'>;
    const recentUsers = (this.db.prepare(`SELECT ${userColumns} FROM users ORDER BY created_at DESC,rowid DESC LIMIT 5`).all() as Omit<UserRow, 'password'>[]).map(r => this.adminUserView(r));
    return { ...users, ...tasks, ...orders, recentUsers };
  }
  adminUsers(query = '', role: User['role'] | 'all' = 'all', requestedPage = 1): PageResult<AdminUser> {
    const clauses: string[] = []; const params: string[] = [];
    if (query.trim()) {
      clauses.push('(instr(lower(name),lower(?))>0 OR instr(lower(email),lower(?))>0 OR instr(lower(id),lower(?))>0)');
      params.push(query.trim(), query.trim(), query.trim());
    }
    if (role !== 'all') { clauses.push('role=?'); params.push(role); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...params) as { n: number };
    const pagination = pageInfo(n, requestedPage);
    const rows = this.db.prepare(`SELECT ${userColumns} FROM users ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as Omit<UserRow, 'password'>[];
    return { ...pagination, items: rows.map(r => this.adminUserView(r)) };
  }
  adminUserDetail(userId: string): AdminUserDetail {
    const user = this.requireAdminUserRecord(userId);
    const tasks = this.db.prepare('SELECT COUNT(*) AS totalTasks,COALESCE(SUM(charged),0) AS chargedCredits FROM tasks WHERE user_id=?').get(userId) as { totalTasks: number; chargedCredits: number };
    const { n: redeemedVouchers } = this.db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE redeemed_by=?').get(userId) as { n: number };
    const { n: ledgerEntries } = this.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id=?').get(userId) as { n: number };
    return { user, stats: { ...tasks, redeemedVouchers, ledgerEntries } };
  }
  adminUserLedger(userId: string, requestedPage = 1): PageResult<LedgerEntry> {
    this.requireAdminUserRecord(userId);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id=?').get(userId) as { n: number };
    const pagination = pageInfo(n, requestedPage);
    const rows = this.db.prepare('SELECT id,kind,delta,frozen_delta,note,task_id,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(userId, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as Record<string, unknown>[];
    return { ...pagination, items: rows.map(r => this.ledgerView(r)) };
  }
  adminUserVouchers(userId: string, requestedPage = 1): PageResult<Voucher> {
    this.requireAdminUserRecord(userId);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE redeemed_by=?').get(userId) as { n: number };
    const pagination = pageInfo(n, requestedPage);
    const rows = this.db.prepare(`${this.voucherQuery()} WHERE v.redeemed_by=? ORDER BY v.redeemed_at DESC,v.rowid DESC LIMIT ? OFFSET ?`).all(now(), userId, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as Record<string, unknown>[];
    return { ...pagination, items: rows.map(r => this.voucherView(r)) };
  }
  adminTasks(status: TaskStatus | 'all' = 'all', query = '', requestedPage = 1, userId?: string): PageResult<AdminTask> {
    if (userId) this.requireAdminUserRecord(userId);
    const clauses: string[] = []; const params: string[] = [];
    if (userId) { clauses.push('t.user_id=?'); params.push(userId); }
    if (status !== 'all') { clauses.push('t.status=?'); params.push(status); }
    if (query.trim()) {
      clauses.push('(instr(lower(t.id),lower(?))>0 OR instr(lower(t.prompt),lower(?))>0 OR instr(lower(u.email),lower(?))>0 OR instr(lower(u.name),lower(?))>0)');
      params.push(query.trim(), query.trim(), query.trim(), query.trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN users u ON u.id=t.user_id ${where}`).get(...params) as { n: number };
    const pagination = pageInfo(n, requestedPage);
    const rows = this.db.prepare(`SELECT t.id,t.user_id,t.prompt,t.mode,t.status,t.model,t.provider,t.size,t.quality,t.count,t.reserved,t.charged,t.created_at,t.finished_at,t.error,t.catalog_model_id,t.model_name,t.admin_test,u.name AS user_name,u.email AS user_email
      FROM tasks t JOIN users u ON u.id=t.user_id ${where} ORDER BY t.created_at DESC,t.rowid DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as (TaskRow & { user_name: string; user_email: string })[];
    return { ...pagination, items: rows.map(r => ({ id: r.id, user: { id: r.user_id, name: r.user_name, email: r.user_email }, prompt: r.prompt,
      mode: r.mode, status: r.status, model: r.model, provider: r.provider, size: r.size, quality: r.quality, count: r.count, reserved: r.reserved,
      charged: r.charged, createdAt: r.created_at, finishedAt: r.finished_at, error: r.error, modelId: r.catalog_model_id, modelName: r.model_name ?? r.model, isTest: Boolean(r.admin_test) })) };
  }
  audit(actorId: string, action: string, targetId: string, note: string) {
    this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?)').run(randomUUID(), actorId, action, targetId, note, now());
  }
}
