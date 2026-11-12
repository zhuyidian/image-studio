import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { ImageCatalog } from '../server/catalog.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { MediaStore } from '../server/media.js';
import { Worker } from '../server/worker.js';
import { ProviderFailure } from '../server/provider.js';
import type { PublicConfig, Task } from '../shared/types.js';

test('ordinary pilot user can register, redeem, use all verified modes and download; unsupported parameters and failures preserve accounting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yidian-pilot-acceptance-'));
  const store = new Store(path.join(directory, 'studio.sqlite'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, IMAGE_PROVIDER: 'newapi', NEW_API_BASE_URL: 'https://not-contacted.example.com/v1', NEW_API_KEY: 'not-used-in-mocked-acceptance', SIGNUP_CREDITS: '0' });
  const media = new MediaStore(store, directory);
  const admin = store.createUser('pilot-admin@example.com', '管理员', 'hash', 0, 'admin');
  const catalog = new ImageCatalog(store, config); const seeded = catalog.list()[0];
  const { id, revision, createdAt: _created, updatedAt: _updated, ...input } = seeded;
  catalog.save({ ...input, name: 'GPT Image 2', enabled: true, verified: true, isDefault: true, modes: ['generate', 'edit', 'inpaint'], sizes: ['1024x1024'], qualities: ['standard'], maxImages: 1, sizeNotice: '方图实测1254×1254，以实际图片为准。' }, admin.id, id, revision);
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aabbcc' } }).png().toBuffer();
  const mask = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
  let behavior: 'success' | 'failed' | 'uncertain' = 'success'; let callCount = 0;
  const worker = new Worker(store, media, { generate: async () => {
    callCount++;
    if (behavior !== 'success') throw new ProviderFailure(behavior === 'uncertain', '测试异常');
    return { images: [image] };
  } }, 1);
  const server = createApp(config, store, media).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  let cookie = '';
  const request = (route: string, body?: unknown, key?: string) => fetch(base + route, {
    method: body ? 'POST' : 'GET', headers: { Origin: config.origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const waitFor = async (task: Task, status: string) => {
    for (let i = 0; i < 70 && store.taskRow(task.id).status !== status; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.taskRow(task.id).status, status);
  };
  try {
    const registered = await request('/auth/register', { name: '试用创作者', email: 'pilot@example.com', password: 'PilotPassword1234' });
    assert.equal(registered.status, 201); cookie = registered.headers.get('set-cookie')!.split(';')[0]; const user = (await registered.json()).user;
    store.createVoucher('IMG-PILOT-500', 500, new Date(Date.now() + 86400000).toISOString(), { createdBy: admin.id });
    assert.equal((await request('/wallet/redeem', { code: 'IMG-PILOT-500' }).then(r => r.json())).user.credits, 500);
    assert.equal((await request('/wallet/redeem', { code: 'IMG-PILOT-500' })).status, 400);
    assert.equal((await request('/admin/users')).status, 403);
    const site: PublicConfig = await request('/config').then(r => r.json()); const model = site.models[0];
    assert.equal(site.paymentEnabled, false); assert.equal(model.maxImages, 1); assert.deepEqual(model.qualities, ['standard']); assert.equal(site.adminTestModels, undefined); assert.match(model.sizeNotice!, /1254/);
    const quote = { prompt: 'A plain ceramic cup', mode: 'generate', size: '1024x1024', quality: 'standard', count: 1, modelId: model.id, modelRevision: model.revision, expectedUnitPrice: 12 };
    for (const invalid of [{ quality: 'high' }, { size: '1536x1024' }, { count: 2 }, { adminTest: true }]) assert.ok((await request('/tasks', { ...quote, ...invalid }, randomUUID())).status >= 400);
    assert.equal(callCount, 0); assert.equal(store.user(user.id).credits, 500);
    const upload = async (bytes: Buffer, kind: string) => {
      const form = new FormData(); form.set('kind', kind); form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `${kind}.png`);
      const response = await fetch(base + '/assets', { method: 'POST', headers: { Origin: config.origin, Cookie: cookie }, body: form }); assert.equal(response.status, 201); return (await response.json()).asset;
    };
    const reference = await upload(image, 'reference'); const maskAsset = await upload(mask, 'mask');
    worker.start();
    for (const mode of ['generate', 'edit', 'inpaint']) {
      const submitted = await request('/tasks', { ...quote, mode, ...(mode !== 'generate' ? { referenceId: reference.id } : {}), ...(mode === 'inpaint' ? { maskId: maskAsset.id } : {}) }, randomUUID());
      assert.equal(submitted.status, 201); const task: Task = (await submitted.json()).task;
      worker.tick(); await waitFor(task, 'succeeded');
      assert.equal(store.taskRow(task.id).charged, 12); const output = store.taskView(store.taskRow(task.id)).outputs[0];
      const downloaded = await request(`/assets/${output.id}?download=1`); assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition')!, /attachment/); assert.ok((await downloaded.arrayBuffer()).byteLength > 0);
    }
    assert.equal(callCount, 3); assert.equal(store.user(user.id).credits, 464); assert.equal(store.user(user.id).frozen, 0);
    behavior = 'failed';
    const failed: Task = (await request('/tasks', quote, randomUUID()).then(r => r.json())).task;
    worker.tick(); await waitFor(failed, 'failed'); assert.equal(store.user(user.id).credits, 464); assert.equal(store.user(user.id).frozen, 0);
    behavior = 'uncertain';
    const uncertain: Task = (await request('/tasks', quote, randomUUID()).then(r => r.json())).task;
    worker.tick(); await waitFor(uncertain, 'uncertain'); assert.equal(store.user(user.id).credits, 452); assert.equal(store.user(user.id).frozen, 12);
    store.settleTask(uncertain.id, [], '经核对未交付图片，积分已退回', undefined, undefined, { actorId: admin.id, note: '验收测试：未交付产物，退回网站积分，不代表上游退款。' });
    assert.equal(store.user(user.id).credits, 464); assert.equal(store.user(user.id).frozen, 0);
    assert.equal(callCount, 5); assert.equal(store.claimTask(), undefined);
    const ledger = store.ledger(user.id); assert.equal(ledger.reduce((n, r) => n + r.delta, 0), 464); assert.equal(ledger.reduce((n, r) => n + r.frozenDelta, 0), 0);
  } finally {
    await worker.stop(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'yidian-pilot-acceptance-')));
    await rm(directory, { recursive: true, force: true });
  }
});
