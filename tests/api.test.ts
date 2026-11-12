import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { MediaStore, isPublicAddress } from '../server/media.js';
import { Worker } from '../server/worker.js';

test('real HTTP flow: account -> upload -> queue -> settle -> private image; CSRF and role isolation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yidian-studio-api-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, APP_ORIGIN: 'http://127.0.0.1:5173' });
  const store = new Store(path.join(directory, 'test.sqlite')); const media = new MediaStore(store, directory);
  const server = createApp(config, store, media).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}/api`;
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#8a9c7a' } }).png().toBuffer();
  const worker = new Worker(store, media, { generate: async () => ({ images: [png] }) }, 1);
  const call = (url: string, method = 'GET', body?: unknown, cookie?: string, extra: Record<string, string> = {}) => fetch(base + url, { method, headers: { Origin: config.origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const info = await call('/config').then(r => r.json()); assert.equal(info.name, 'Yidian-Image'); assert.equal(info.NEW_API_KEY, undefined);
    const register = await call('/auth/register', 'POST', { name: '创作者', email: 'creator@example.com', password: 'StrongPassword123' });
    assert.equal(register.status, 201); const cookie = register.headers.get('set-cookie')!.split(';')[0]; assert.match(register.headers.get('set-cookie')!, /HttpOnly/i);
    const user = (await register.json()).user; assert.equal(user.credits, 36);
    assert.equal((await call('/auth/login', 'POST', { email: user.email, password: 'WrongPassword123' })).status, 401);
    assert.equal((await call('/wallet/redeem', 'POST', { code: 'IMG-INVALID-CODE' }, cookie, { Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await call('/admin', 'GET', undefined, cookie)).status, 403);
    const form = new FormData(); form.set('kind', 'reference'); form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'test.png');
    const uploaded = await fetch(base + '/assets', { method: 'POST', headers: { Origin: config.origin, Cookie: cookie }, body: form });
    assert.equal(uploaded.status, 201); const asset = (await uploaded.json()).asset;
    const body = { prompt: 'Change the wall color', mode: 'edit', size: '1024x1024', quality: 'standard', count: 1, referenceId: asset.id, modelId: info.models[0].id, modelRevision: info.models[0].revision, expectedUnitPrice: info.models[0].prices.edit.standard };
    const opaqueMask = new FormData(); opaqueMask.set('kind', 'mask'); opaqueMask.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'opaque.png');
    assert.equal((await fetch(base + '/assets', { method: 'POST', headers: { Origin: config.origin, Cookie: cookie }, body: opaqueMask })).status, 400);
    const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
    const validMask = new FormData(); validMask.set('kind', 'mask'); validMask.set('file', new Blob([new Uint8Array(transparent)], { type: 'image/png' }), 'mask.png');
    const maskResponse = await fetch(base + '/assets', { method: 'POST', headers: { Origin: config.origin, Cookie: cookie }, body: validMask });
    assert.equal(maskResponse.status, 201); const maskAsset = (await maskResponse.json()).asset;
    assert.equal((await call('/tasks', 'POST', { ...body, mode: 'inpaint' }, cookie, { 'Idempotency-Key': randomUUID() })).status, 400);
    const key = randomUUID(); const submitted = await call('/tasks', 'POST', body, cookie, { 'Idempotency-Key': key });
    assert.equal(submitted.status, 201); const taskId = (await submitted.json()).task.id;
    const duplicate = await call('/tasks', 'POST', body, cookie, { 'Idempotency-Key': key }); assert.equal((await duplicate.json()).task.id, taskId);
    worker.start();
    for (let i = 0; i < 50 && store.taskRow(taskId).status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const final = await call(`/tasks/${taskId}`, 'GET', undefined, cookie).then(r => r.json());
    assert.equal(final.task.status, 'succeeded'); assert.equal(final.task.charged, 12); assert.equal(store.user(user.id).credits, 24); assert.equal(store.user(user.id).frozen, 0);
    const image = await call(final.task.outputs[0].url.replace('/api', ''), 'GET', undefined, cookie); assert.equal(image.status, 200); assert.match(image.headers.get('content-type')!, /image\/png/);
    assert.equal((await call(final.task.outputs[0].url.replace('/api', ''))).status, 401);
    const other = await call('/auth/register', 'POST', { name: 'Other', email: 'other@example.com', password: 'StrongPassword123' }); const otherCookie = other.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call(`/tasks/${taskId}`, 'GET', undefined, otherCookie)).status, 404);
    assert.equal((await call(`/assets/${asset.id}`, 'GET', undefined, otherCookie)).status, 404);
    assert.equal((await call('/tasks', 'POST', body, otherCookie, { 'Idempotency-Key': randomUUID() })).status, 404);
    assert.equal((await call('/payments/orders', 'POST', { packageId: 'starter', method: 'wxpay' }, cookie)).status, 503);
    const inpaintResponse = await call('/tasks', 'POST', { ...body, mode: 'inpaint', maskId: maskAsset.id }, cookie, { 'Idempotency-Key': randomUUID() });
    assert.equal(inpaintResponse.status, 201);
    await call('/auth/logout', 'POST', {}, cookie); assert.equal((await call('/auth/me', 'GET', undefined, cookie).then(r => r.json())).user, null);
  } finally {
    await worker.stop(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'yidian-studio-api-')));
    await rm(directory, { recursive: true, force: true });
  }
});
test('media downloads reject private and mapped addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
