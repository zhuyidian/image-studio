import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';

export interface AuthMail { to: string; subject: string; text: string }
export interface MailDelivery { available: boolean; send(message: AuthMail): Promise<void> }
export function createMailDelivery(config: Config): MailDelivery {
  if (config.mailTransport === 'disabled') return { available: false, async send() { throw new Error('Mail disabled'); } };
  if (config.mailTransport === 'file') return { available: true, async send(message) {
    const directory = path.join(config.dataDir, 'mail'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`), JSON.stringify({ ...message, createdAt: new Date().toISOString(), localOnly: true }, null, 2), { flag: 'wx', mode: 0o600 });
  } };
  const transport = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE === 'true', requireTLS: config.SMTP_SECURE !== 'true',
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}), connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true,
  });
  return { available: true, async send(message) {
    await transport.sendMail({ from: { name: config.APP_NAME, address: config.SMTP_FROM! }, to: { name: '', address: message.to }, subject: message.subject, text: message.text, disableFileAccess: true, disableUrlAccess: true });
  } };
}
