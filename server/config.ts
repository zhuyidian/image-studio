import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import type { PublicConfig, PublicImageModel } from '../shared/types.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
  APP_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  PUBLIC_ORIGIN: z.url().optional(), APP_NAME: z.string().min(1).max(40).default('Yidian-Image'),
  DATA_DIR: z.string().default('./data'), IMAGE_PROVIDER: z.enum(['mock', 'newapi']).default('mock'),
  NEW_API_BASE_URL: z.url().optional(), NEW_API_KEY: z.string().optional(),
  NEW_API_IMAGE_MODEL: z.string().min(1).default('gpt-image-2'),
  NEW_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(180000),
  STANDARD_IMAGE_CREDITS: z.coerce.number().int().positive().max(100000).default(12),
  HIGH_IMAGE_CREDITS: z.coerce.number().int().positive().max(100000).default(24),
  ALLOW_REGISTRATION: z.enum(['true', 'false']).optional(),
  SIGNUP_CREDITS: z.coerce.number().int().nonnegative().max(100000).optional(),
  EMAIL_VERIFICATION_REQUIRED: z.enum(['true', 'false']).optional(),
  MAIL_TRANSPORT: z.enum(['disabled', 'file', 'smtp']).optional(),
  SMTP_HOST: z.string().trim().min(1).optional(), SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'), SMTP_USER: z.string().optional(), SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.email().optional(),
  MAX_ACTIVE_TASKS_PER_USER: z.coerce.number().int().min(1).max(20).default(2),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  PAYMENT_PROVIDER: z.enum(['disabled', 'epay']).default('disabled'),
  EPAY_BASE_URL: z.url().optional().or(z.literal('')),
  EPAY_MERCHANT_ID: z.string().optional(), EPAY_MERCHANT_KEY: z.string().optional(),
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const e = envSchema.parse(environment);
  const production = e.NODE_ENV === 'production';
  const origin = new URL(e.APP_ORIGIN).origin;
  const mailTransport = e.MAIL_TRANSPORT ?? (e.NODE_ENV === 'development' ? 'file' : 'disabled');
  if (production && mailTransport === 'file') throw new Error('生产环境不能使用本地邮件文件模式');
  if (mailTransport === 'smtp' && (!e.SMTP_HOST || !e.SMTP_FROM)) throw new Error('SMTP 地址和发信邮箱未配置');
  if (production && !origin.startsWith('https://')) throw new Error('生产 APP_ORIGIN 必须使用 HTTPS');
  if (e.IMAGE_PROVIDER === 'newapi' && (!e.NEW_API_BASE_URL || !e.NEW_API_KEY)) throw new Error('New API 地址与密钥未配置');
  if (e.IMAGE_PROVIDER === 'newapi' && new URL(e.NEW_API_BASE_URL!).protocol !== 'https:' && production) throw new Error('生产 New API 连接必须使用 HTTPS');
  if (e.PAYMENT_PROVIDER === 'epay') {
    if (e.IMAGE_PROVIDER === 'mock') throw new Error('模拟图片模式禁止开启真实收款');
    if (!e.EPAY_BASE_URL || !e.EPAY_MERCHANT_ID || !e.EPAY_MERCHANT_KEY || !e.PUBLIC_ORIGIN) throw new Error('支付商户配置不完整');
    if (![e.EPAY_BASE_URL, e.PUBLIC_ORIGIN].every(url => new URL(url).protocol === 'https:')) throw new Error('支付网关与回调必须使用 HTTPS');
  }
  return { ...e, production, origin, publicOrigin: new URL(e.PUBLIC_ORIGIN || origin).origin,
    dataDir: path.resolve(e.DATA_DIR), registration: e.ALLOW_REGISTRATION === 'true' || (!production && e.ALLOW_REGISTRATION !== 'false'),
    signupCredits: e.SIGNUP_CREDITS ?? (production ? 0 : 36),
    mailTransport, emailVerificationRequired: e.EMAIL_VERIFICATION_REQUIRED ? e.EMAIL_VERIFICATION_REQUIRED === 'true' : e.NODE_ENV !== 'test',
  };
}
export type Config = ReturnType<typeof loadConfig>;
export function publicConfig(c: Config, models: PublicImageModel[] = []): PublicConfig {
  const defaultModel = models.find(m => m.isDefault) ?? models[0];
  return { name: c.APP_NAME, provider: c.IMAGE_PROVIDER, registration: c.registration, signupCredits: c.signupCredits,
    emailVerificationRequired: c.emailVerificationRequired, mailDeliveryAvailable: c.mailTransport !== 'disabled', passwordResetAvailable: c.mailTransport !== 'disabled',
    model: defaultModel?.name ?? '暂无可用模型', models, pricing: defaultModel?.prices.generate ?? { standard: c.STANDARD_IMAGE_CREDITS, high: c.HIGH_IMAGE_CREDITS },
    paymentEnabled: c.PAYMENT_PROVIDER !== 'disabled', demoAvailable: !c.production && c.IMAGE_PROVIDER === 'mock', packages: [
      { id: 'starter', name: '灵感补给', cents: 1990, credits: 200, subtitle: '偶尔创作，轻松开始' },
      { id: 'creator', name: '创作者', cents: 5990, credits: 680, subtitle: '为持续创作多留一些空间' },
      { id: 'pro', name: '专业创作', cents: 12990, credits: 1600, subtitle: '适合高频创作与批量出图' },
    ] };
}
