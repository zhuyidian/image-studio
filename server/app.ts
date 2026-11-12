import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { User } from '../shared/types.js';
import { publicConfig, type Config } from './config.js';
import { Store, AppError, hash } from './store.js';
import { ImageCatalog, imageModelSchema } from './catalog.js';
import { MediaStore } from './media.js';
import { hashPassword, verifyPassword, sessionToken } from './auth.js';
import { checkoutUrl, processNotification } from './payments.js';

declare global { namespace Express { interface Request { studioUser?: User } } }
const cookieName = 'studio_session';
const loginSchema = z.object({ email: z.email().max(254).transform(v => v.trim().toLowerCase()), password: z.string().min(10).max(128) });
const registerSchema = loginSchema.extend({ name: z.string().trim().min(1).max(32) });
const taskSchema = z.object({ prompt: z.string().trim().min(2).max(4000), mode: z.enum(['generate', 'edit', 'inpaint']),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536']), quality: z.enum(['standard', 'high']), count: z.number().int().min(1).max(4),
  referenceId: z.uuid().optional(), maskId: z.uuid().optional(), modelId: z.uuid(),
  expectedUnitPrice: z.number().int().positive().max(100000), modelRevision: z.number().int().positive(),
  adminTest: z.boolean().optional(),
}).strict();

export function createApp(config: Config, store: Store, media: MediaStore) {
  const catalog = new ImageCatalog(store, config);
  const siteConfig = () => publicConfig(config, catalog.publicModels());
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY_HOPS) app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet({ contentSecurityPolicy: config.production ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } : false, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'no-referrer' } }));
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 400, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '请求过于频繁，请稍后再试' } }));
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path !== '/payments/notify' && req.get('Origin') !== config.origin) return next(new AppError(403, '请求来源无效，请刷新页面'));
    req.studioUser = store.session(req.cookies[cookieName]); next();
  });
  const requireUser = (req: Request, _res: Response, next: NextFunction) => req.studioUser ? next() : next(new AppError(401, '请先登录', 'UNAUTHENTICATED'));
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => req.studioUser?.role === 'admin' ? next() : next(new AppError(403, '需要管理员权限'));
  const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '尝试次数较多，请稍后再试' } });
  function signIn(res: Response, user: User) {
    const token = sessionToken(); store.createSession(user.id, token);
    res.cookie(cookieName, token, { httpOnly: true, secure: config.production, sameSite: 'strict', maxAge: 7 * 86400000, path: '/' });
    return res.json({ user });
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ ...siteConfig(), ...(req.studioUser?.role === 'admin' ? { adminTestModels: catalog.publicModels(true) } : {}) }));
  app.get('/api/auth/me', (req, res) => res.json({ user: req.studioUser ?? null }));
  app.post('/api/auth/register', authLimit, async (req, res) => {
    if (!config.registration) throw new AppError(403, '暂未开放注册，请联系管理员');
    const input = registerSchema.parse(req.body);
    const password = await hashPassword(input.password);
    const user = store.createUser(input.email, input.name, password, config.signupCredits);
    signIn(res.status(201), user);
  });
  app.post('/api/auth/login', authLimit, async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = store.findUser(input.email);
    const fallback = 'scrypt:4b1b08b8100b66f7cb8f8cc4e8780c81:' + '00'.repeat(64);
    if (!await verifyPassword(input.password, user?.password ?? fallback) || !user) throw new AppError(401, '邮箱或密码不正确');
    signIn(res, store.user(user.id));
  });
  app.post('/api/auth/demo', authLimit, async (_req, res) => {
    if (config.production || config.IMAGE_PROVIDER !== 'mock') throw new AppError(404, '此功能不可用');
    const demo = store.findUser('demo@image-studio.local') ?? store.createUser('demo@image-studio.local', '体验创作者', await hashPassword(randomBytes(32).toString('hex')), 1000);
    signIn(res, store.user(demo.id));
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.cookies[cookieName]) store.revokeSession(req.cookies[cookieName]);
    res.clearCookie(cookieName, { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/' }).json({ ok: true });
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 1 } });
  app.post('/api/assets', requireUser, upload.single('file'), async (req, res) => {
    if (!req.file) throw new AppError(400, '请选择图片');
    const kind = z.enum(['reference', 'mask']).parse(req.body.kind ?? 'reference');
    const asset = await media.save(req.studioUser!.id, req.file.buffer, kind);
    res.status(201).json({ asset });
  });
  app.get('/api/assets/:id', requireUser, async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const asset = store.asset(id, req.studioUser!.id);
    const bytes = await media.read(id, req.studioUser!.id);
    res.type('png').set('X-Content-Type-Options', 'nosniff');
    if (req.query.download === '1') res.attachment(`image-${asset.id}.png`);
    res.send(bytes);
  });
  app.get('/api/tasks', requireUser, (req, res) => res.json({ tasks: store.tasks(req.studioUser!.id) }));
  app.get('/api/tasks/:id', requireUser, (req, res) => res.json({ task: store.taskView(store.taskRow(String(req.params.id), req.studioUser!.id)) }));
  app.post('/api/tasks', requireUser, (req, res) => {
    const input = taskSchema.parse(req.body);
    if (input.adminTest && req.studioUser!.role !== 'admin') throw new AppError(403, '仅管理员可测试未开放模型');
    const key = z.uuid().parse(req.get('Idempotency-Key'));
    const requestFingerprint = hash(JSON.stringify(input));
    const existing = store.existingTask(req.studioUser!.id, key, requestFingerprint);
    if (existing) { res.status(201).json({ task: existing, user: store.user(req.studioUser!.id) }); return; }
    if (input.mode === 'generate' && (input.referenceId || input.maskId)) throw new AppError(400, '文生图任务不能携带参考图或蒙版');
    if (input.mode !== 'generate') {
      if (!input.referenceId) throw new AppError(400, '请先上传参考图片');
      const reference = store.asset(input.referenceId, req.studioUser!.id);
      if (reference.kind === 'mask') throw new AppError(400, '蒙版不能作为参考图');
      if (input.mode === 'inpaint') {
        if (!input.maskId) throw new AppError(400, '请先涂抹需要修改的区域');
        const mask = store.asset(input.maskId, req.studioUser!.id);
        if (mask.kind !== 'mask' || mask.width !== reference.width || mask.height !== reference.height) throw new AppError(400, '蒙版与参考图尺寸不一致');
      } else if (input.maskId) throw new AppError(400, '参考图编辑不接受蒙版，请选择局部重绘');
    }
    const quote = catalog.quote(input, input.adminTest === true);
    const task = store.createTask({ ...input, ...quote, userId: req.studioUser!.id, key, requestFingerprint,
      provider: config.IMAGE_PROVIDER, maxActive: config.MAX_ACTIVE_TASKS_PER_USER });
    res.status(201).json({ task, user: store.user(req.studioUser!.id) });
  });
  app.get('/api/wallet', requireUser, (req, res) => res.json({ user: store.user(req.studioUser!.id), ledger: store.ledger(req.studioUser!.id) }));
  app.post('/api/wallet/redeem', requireUser, authLimit, (req, res) => {
    const { code } = z.object({ code: z.string().trim().min(8).max(100) }).parse(req.body);
    res.json({ user: store.redeem(req.studioUser!.id, code) });
  });
  app.post('/api/payments/orders', requireUser, authLimit, (req, res) => {
    if (config.PAYMENT_PROVIDER === 'disabled') throw new AppError(503, '在线支付尚未开启，可以使用积分兑换码');
    const input = z.object({ packageId: z.string(), method: z.enum(['alipay', 'wxpay']) }).parse(req.body);
    const pack = publicConfig(config).packages.find(p => p.id === input.packageId);
    if (!pack) throw new AppError(400, '积分包不存在');
    const order = store.createOrder(req.studioUser!.id, pack.cents, pack.credits, input.method);
    res.status(201).json({ order, checkoutUrl: checkoutUrl(config, order) });
  });
  app.get('/api/payments/orders/:id', requireUser, (req, res) => res.json({ order: store.order(String(req.params.id), req.studioUser!.id) }));
  app.all('/api/payments/notify', (req, res) => {
    if (!['GET', 'POST'].includes(req.method)) throw new AppError(405, 'Method not allowed');
    const raw = req.method === 'GET' ? req.query : req.body;
    const params = z.record(z.string(), z.string().max(2000)).parse(raw);
    processNotification(config, store, params);
    res.type('text').send('success');
  });
  app.get('/api/admin', requireUser, requireAdmin, (_req, res) => res.json(store.adminOverview()));
  app.get('/api/admin/models', requireUser, requireAdmin, (_req, res) => res.json({ models: catalog.list(), provider: config.IMAGE_PROVIDER }));
  app.post('/api/admin/models', requireUser, requireAdmin, (req, res) => res.status(201).json({ model: catalog.save(req.body, req.studioUser!.id) }));
  app.put('/api/admin/models/:id', requireUser, requireAdmin, (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { revision, ...input } = imageModelSchema.safeExtend({ revision: z.number().int().positive() }).parse(req.body);
    res.json({ model: catalog.save(input, req.studioUser!.id, id, revision) });
  });
  const adminPageSchema = z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1) });
  const adminUserId = (req: Request) => z.uuid().parse(req.params.id);
  app.get('/api/admin/users', requireUser, requireAdmin, (req, res) => {
    const query = adminPageSchema.extend({ q: z.string().trim().max(254).default(''), role: z.enum(['all', 'user', 'admin']).default('all') }).parse(req.query);
    res.json(store.adminUsers(query.q, query.role, query.page));
  });
  app.get('/api/admin/users/:id', requireUser, requireAdmin, (req, res) => res.json(store.adminUserDetail(adminUserId(req))));
  app.get('/api/admin/users/:id/ledger', requireUser, requireAdmin, (req, res) => {
    const { page } = adminPageSchema.parse(req.query);
    res.json(store.adminUserLedger(adminUserId(req), page));
  });
  app.get('/api/admin/users/:id/vouchers', requireUser, requireAdmin, (req, res) => {
    const { page } = adminPageSchema.parse(req.query);
    res.json(store.adminUserVouchers(adminUserId(req), page));
  });
  app.get('/api/admin/users/:id/tasks', requireUser, requireAdmin, (req, res) => {
    const { page } = adminPageSchema.parse(req.query);
    res.json(store.adminTasks('all', '', page, adminUserId(req)));
  });
  app.get('/api/admin/tasks', requireUser, requireAdmin, (req, res) => {
    const query = adminPageSchema.extend({ q: z.string().trim().max(254).default(''), status: z.enum(['all', 'queued', 'running', 'succeeded', 'partial', 'failed', 'uncertain']).default('all') }).parse(req.query);
    res.json(store.adminTasks(query.status, query.q, query.page));
  });
  app.get('/api/admin/vouchers', requireUser, requireAdmin, (req, res) => {
    const query = z.object({ status: z.enum(['all', 'unused', 'redeemed', 'expired', 'revoked']).default('all'), page: z.coerce.number().int().min(1).max(1000000).default(1) }).parse(req.query);
    res.json(store.vouchers(query.status, query.page));
  });
  app.post('/api/admin/vouchers', requireUser, requireAdmin, (req, res) => {
    const input = z.object({ credits: z.number().int().positive().max(100000), days: z.number().int().min(1).max(365).default(30), note: z.string().trim().max(300).default('') }).parse(req.body);
    const code = `IMG-${randomBytes(12).toString('hex').toUpperCase()}`;
    const voucher = store.createVoucher(code, input.credits, new Date(Date.now() + input.days * 86400000).toISOString(), { createdBy: req.studioUser!.id, note: input.note });
    res.status(201).json({ code, voucher, redemptionUrl: `${config.publicOrigin}/?page=wallet` });
  });
  app.post('/api/admin/vouchers/:id/revoke', requireUser, requireAdmin, (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(2).max(300) }).parse(req.body);
    res.json({ voucher: store.revokeVoucher(id, req.studioUser!.id, reason) });
  });
  app.post('/api/admin/tasks/:id/release', requireUser, requireAdmin, (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(10).max(300) }).parse(req.body);
    const task = store.taskRow(String(req.params.id));
    if (task.status !== 'uncertain') throw new AppError(409, '只可处理结果待确认的任务');
    store.settleTask(task.id, [], '经人工核对未能交付，冻结积分已退回', undefined, undefined, { actorId: req.studioUser!.id, note: reason });
    res.json({ ok: true });
  });
  if (config.production) {
    app.use(express.static(path.resolve('dist/web'), { index: false, maxAge: '1h' }));
    app.get('/{*path}', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.set('Cache-Control', 'no-cache').sendFile(path.resolve('dist/web/index.html')); });
  }
  app.use((_req, _res, next) => next(new AppError(404, '接口不存在')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: '提交内容格式不正确，请检查输入', code: 'VALIDATION_ERROR' });
    if (error instanceof multer.MulterError) return res.status(413).json({ error: '上传文件过大或文件数量不正确' });
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof SyntaxError || (error && typeof error === 'object' && 'status' in error && error.status === 413)) return res.status(400).json({ error: '请求内容无效或过大' });
    console.error('Unhandled application error:', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ error: '服务暂时不可用，请稍后再试', code: 'INTERNAL_ERROR' });
  });
  return app;
}
