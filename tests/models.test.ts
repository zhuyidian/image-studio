import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { ImageCatalog } from '../server/catalog.js';
import { Store } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { MediaStore } from '../server/media.js';
import { Worker } from '../server/worker.js';
import { ProviderFailure } from '../server/provider.js';
import type { AdminImageModel, ImageModelInput, PublicConfig } from '../shared/types.js';

function modelInput(overrides: Partial<ImageModelInput> = {}): ImageModelInput {
  return { name: '轻量创作', description: '用于测试的创作选项', tag: '快速', upstreamModel: 'private-upstream-fast', adapter: 'images-v1',
    modes: ['generate'], sizes: ['1024x1024'], qualities: ['standard'], maxImages: 1,
    prices: { generate: { standard: 5, high: 10 }, edit: { standard: 8, high: 12 }, inpaint: { standard: 10, high: 15 } },
    qualityMap: { standard: 'omit', high: 'high' }, sendSize: true, enabled: false, verified: false, isDefault: false, sortOrder: 10, ...overrides };
}
function editable(model: AdminImageModel): ImageModelInput {
  const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...input } = model;
  return input;
}
test('model directory migrates once, keeps drafts private and maintains one default without resetting edited prices', () => {
  const store = new Store(':memory:'); const config = loadConfig({ NODE_ENV: 'test' });
  try {
    const admin = store.createUser('admin@example.com', 'Admin', 'hash', 0, 'admin');
    const catalog = new ImageCatalog(store, config);
    const initial = catalog.list()[0]; assert.equal(catalog.publicModels().length, 1); assert.equal(initial.verified, false);
    const draft = catalog.save(modelInput(), admin.id); assert.equal(catalog.list().length, 2); assert.equal(catalog.publicModels().length, 1);
    const enabled = catalog.save({ ...editable(draft), enabled: true, isDefault: true }, admin.id, draft.id, draft.revision);
    assert.equal(catalog.publicModels()[0].id, enabled.id); assert.equal(catalog.list().filter(m => m.isDefault).length, 1);
    assert.equal(catalog.get(initial.id).isDefault, false);
    const changed = catalog.save({ ...editable(enabled), prices: { ...enabled.prices, generate: { standard: 7, high: 14 } } }, admin.id, enabled.id, enabled.revision);
    assert.throws(() => catalog.save(editable(enabled), admin.id, enabled.id, enabled.revision), /已被更新/);
    const disabled = catalog.save({ ...editable(changed), enabled: false, isDefault: false }, admin.id, changed.id, changed.revision);
    assert.equal(disabled.enabled, false); assert.equal(catalog.publicModels()[0].id, initial.id); assert.equal(catalog.list().filter(m => m.isDefault).length, 1);
    const reinitialized = new ImageCatalog(store, loadConfig({ NODE_ENV: 'test', STANDARD_IMAGE_CREDITS: '999', NEW_API_IMAGE_MODEL: 'other-env-model' }));
    assert.equal(reinitialized.list().length, 2); assert.equal(reinitialized.get(draft.id).prices.generate.standard, 7);
    assert.equal(reinitialized.get(initial.id).upstreamModel, config.NEW_API_IMAGE_MODEL);
    assert.equal(JSON.stringify(catalog.publicModels()).includes('private-upstream-fast'), false);
    assert.equal(JSON.stringify(catalog.publicModels()).includes('qualityMap'), false);
    assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='model.update'").get()!.n as number > 0);
  } finally { store.close(); }
});

test('administrators can test unpublished real models without publishing them; regular users cannot see or submit test models', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yidian-model-preview-'));
  const config = loadConfig({ NODE_ENV: 'test', IMAGE_PROVIDER: 'newapi', NEW_API_BASE_URL: 'https://gateway.example.com/v1', NEW_API_KEY: 'SECRET-TEST-KEY', DATA_DIR: directory, MAX_ACTIVE_TASKS_PER_USER: '10' });
  const store = new Store(path.join(directory, 'test.sqlite'));
  const admin = store.createUser('admin@example.com', '管理员', 'hash', 200, 'admin');
  const user = store.createUser('creator@example.com', '普通创作者', 'hash', 100);
  store.createSession(admin.id, 'admin-test-session'); store.createSession(user.id, 'user-test-session');
  const media = new MediaStore(store, directory);
  const server = createApp(config, store, media).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = (route: string, token = 'admin-test-session', method = 'GET', body?: unknown, key?: string) => fetch(base + route, { method,
    headers: { Cookie: `studio_session=${token}`, Origin: config.origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aabb88' } }).png().toBuffer();
  let shouldFail = false;
  const worker = new Worker(store, media, { generate: async () => {
    if (shouldFail) throw new ProviderFailure(false, '上游明确拒绝，本次未交付');
    return { images: [image] };
  } }, 1);
  try {
    const publicConfig: PublicConfig = await request('/config', '').then(r => r.json()); assert.equal(publicConfig.models.length, 0); assert.equal(publicConfig.adminTestModels, undefined);
    const userConfig: PublicConfig = await request('/config', 'user-test-session').then(r => r.json()); assert.equal(userConfig.adminTestModels, undefined);
    const adminConfig: PublicConfig = await request('/config').then(r => r.json()); assert.equal(adminConfig.models.length, 0); assert.equal(adminConfig.adminTestModels?.length, 1);
    const json = JSON.stringify(adminConfig); for (const secret of ['SECRET-TEST-KEY', 'qualityMap', 'upstreamModel', 'gateway.example.com']) assert.equal(json.includes(secret), false);
    const model = adminConfig.adminTestModels![0];
    const body = { prompt: 'admin unpublished model test', mode: 'generate', size: '1024x1024', quality: 'standard', count: 1, modelId: model.id, modelRevision: model.revision, expectedUnitPrice: model.prices.generate.standard };
    assert.equal((await request('/tasks', 'admin-test-session', 'POST', body, randomUUID())).status, 409);
    assert.equal((await request('/tasks', 'user-test-session', 'POST', body, randomUUID())).status, 409);
    assert.equal((await request('/tasks', 'user-test-session', 'POST', { ...body, adminTest: true }, randomUUID())).status, 403);
    assert.equal((await request('/tasks', '', 'POST', { ...body, adminTest: true }, randomUUID())).status, 401);
    assert.equal(store.user(user.id).credits, 100); assert.equal(store.tasks(user.id).length, 0);
    assert.equal((await request('/tasks', 'admin-test-session', 'POST', { ...body, adminTest: true, expectedUnitPrice: 1 }, randomUUID())).status, 409);
    assert.equal((await request('/tasks', 'admin-test-session', 'POST', { ...body, adminTest: true, modelRevision: 999 }, randomUUID())).status, 409);
    const key = randomUUID(); const submitted = await request('/tasks', 'admin-test-session', 'POST', { ...body, adminTest: true }, key);
    assert.equal(submitted.status, 201); const task = (await submitted.json()).task; assert.equal(task.isTest, true); assert.equal(task.reserved, 12);
    const duplicated = await request('/tasks', 'admin-test-session', 'POST', { ...body, adminTest: true }, key); assert.equal((await duplicated.json()).task.id, task.id);
    assert.equal(store.user(admin.id).credits, 188); assert.equal(store.user(admin.id).frozen, 12);
    worker.start();
    for (let i = 0; i < 50 && store.taskRow(task.id).status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.taskRow(task.id).status, 'succeeded'); assert.equal(store.taskRow(task.id).charged, 12); assert.equal(store.user(admin.id).frozen, 0);
    assert.equal(store.adminTasks().items[0].isTest, true);
    assert.equal((await request('/tasks', 'user-test-session').then(r => r.json())).tasks.length, 0);
    assert.equal((await request(`/tasks/${task.id}`, 'user-test-session')).status, 404);
    const catalogue = new ImageCatalog(store, config); assert.equal(catalogue.get(model.id).verified, false); assert.equal(catalogue.get(model.id).enabled, false); assert.equal(catalogue.publicModels().length, 0);
    assert.equal((await request('/config', '').then(r => r.json())).models.length, 0);
    shouldFail = true;
    const failed = await request('/tasks', 'admin-test-session', 'POST', { ...body, prompt: 'clear failure test', adminTest: true }, randomUUID()); assert.equal(failed.status, 201); const failedTask = (await failed.json()).task;
    worker.tick();
    for (let i = 0; i < 50 && store.taskRow(failedTask.id).status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.taskRow(failedTask.id).status, 'failed'); assert.equal(store.user(admin.id).credits, 188); assert.equal(store.user(admin.id).frozen, 0);
    const audit = store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor_id=? AND action='model.test.submit'").get(admin.id) as { n: number }; assert.equal(audit.n, 2);
    const disabledDraft = catalogue.save(modelInput(), admin.id);
    const unsupported = { ...body, adminTest: true, modelId: disabledDraft.id, modelRevision: disabledDraft.revision, expectedUnitPrice: disabledDraft.prices.generate.standard, quality: 'high' };
    assert.equal((await request('/tasks', 'admin-test-session', 'POST', unsupported, randomUUID())).status, 400);
    const freeAdmin = store.createUser('empty-admin@example.com', '无积分管理员', 'hash', 0, 'admin'); store.createSession(freeAdmin.id, 'empty-admin-session');
    assert.equal((await request('/tasks', 'empty-admin-session', 'POST', { ...body, adminTest: true }, randomUUID())).status, 402);
    store.db.prepare("UPDATE users SET role='user' WHERE id=?").run(admin.id);
    assert.equal((await request('/config').then(r => r.json())).adminTestModels, undefined);
    assert.equal((await request('/tasks', 'admin-test-session', 'POST', { ...body, adminTest: true }, key)).status, 403);
  } finally {
    await worker.stop(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'yidian-model-preview-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('real models require manual verification; unsupported capabilities, stale quotes and malformed settings are rejected', () => {
  const store = new Store(':memory:');
  const config = loadConfig({ NODE_ENV: 'test', IMAGE_PROVIDER: 'newapi', NEW_API_BASE_URL: 'https://gateway.example.com/v1', NEW_API_KEY: 'test-only-key' });
  try {
    const admin = store.createUser('admin@example.com', 'Admin', 'hash', 0, 'admin'); const catalog = new ImageCatalog(store, config);
    assert.equal(catalog.publicModels().length, 0); assert.equal(catalog.list()[0].enabled, false);
    assert.throws(() => catalog.save(modelInput({ enabled: true }), admin.id), /先完成真实模型/);
    const model = catalog.save(modelInput({ enabled: true, verified: true }), admin.id);
    const input = { modelId: model.id, mode: 'generate' as const, size: '1024x1024' as const, quality: 'standard' as const, count: 1, expectedUnitPrice: 5, modelRevision: model.revision };
    assert.equal(catalog.quote(input).model, model.upstreamModel); assert.equal(catalog.quote(input).unitPrice, 5);
    for (const invalid of [{ mode: 'edit' }, { mode: 'inpaint' }, { quality: 'high' }, { size: '1536x1024' }, { count: 2 }]) assert.throws(() => catalog.quote({ ...input, ...invalid } as typeof input), /不支持/);
    assert.throws(() => catalog.quote({ ...input, expectedUnitPrice: 1 }), /价格已更新/);
    assert.throws(() => catalog.quote({ ...input, modelRevision: 999 }), /价格已更新/);
    for (const invalid of [modelInput({ name: '' }), modelInput({ adapter: 'other' as 'images-v1' }), modelInput({ modes: [] }), modelInput({ modes: ['generate', 'generate'] }), modelInput({ maxImages: 5 }), modelInput({ enabled: false, isDefault: true }), modelInput({ prices: { ...model.prices, generate: { standard: 0, high: 2 } } })]) assert.throws(() => catalog.save(invalid, admin.id));
    assert.throws(() => catalog.save(modelInput({ enabled: false }), admin.id), /已有配置/);
    // Switching from a mock migration does not publish previously unverified models.
    const mockStore = new Store(':memory:');
    try {
      const mock = new ImageCatalog(mockStore, loadConfig({ NODE_ENV: 'test' })); assert.equal(mock.publicModels().length, 1);
      const real = new ImageCatalog(mockStore, config); assert.equal(real.publicModels().length, 0);
    } finally { mockStore.close(); }
  } finally { store.close(); }
});

test('HTTP model selection enforces permissions, quotes and capabilities; queued tasks keep model and price snapshots', async () => {
  const store = new Store(':memory:'); const config = loadConfig({ NODE_ENV: 'test' });
  const admin = store.createUser('admin@example.com', 'Admin', 'SECRET-HASH', 0, 'admin');
  const user = store.createUser('creator@example.com', 'Creator', 'SECRET-HASH', 200);
  store.createSession(admin.id, 'admin-session'); store.createSession(user.id, 'user-session');
  const server = createApp(config, store, new MediaStore(store, path.join(tmpdir(), 'unused-model-test-media'))).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = (route: string, token = 'admin-session', method = 'GET', body?: unknown, key?: string) => fetch(base + route, { method,
    headers: { Cookie: `studio_session=${token}`, Origin: config.origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('/admin/models', '')).status, 401); assert.equal((await request('/admin/models', 'user-session')).status, 403);
    assert.equal((await request('/admin/models', 'user-session', 'POST', modelInput())).status, 403);
    const createdResponse = await request('/admin/models', 'admin-session', 'POST', modelInput()); assert.equal(createdResponse.status, 201);
    const created: AdminImageModel = (await createdResponse.json()).model;
    let publicConfig: PublicConfig = await request('/config', '').then(r => r.json()); assert.equal(publicConfig.models.some(m => m.id === created.id), false);
    assert.equal((await request(`/admin/models/${created.id}`, 'user-session', 'PUT', { ...editable(created), revision: created.revision })).status, 403);
    const enabledResponse = await request(`/admin/models/${created.id}`, 'admin-session', 'PUT', { ...editable(created), enabled: true, isDefault: true, revision: created.revision }); assert.equal(enabledResponse.status, 200);
    const enabled: AdminImageModel = (await enabledResponse.json()).model;
    publicConfig = await request('/config', '').then(r => r.json()); assert.equal(publicConfig.models[0].id, enabled.id);
    const publicText = JSON.stringify(publicConfig); for (const secret of ['private-upstream-fast', 'qualityMap', 'upstreamModel', 'SECRET-HASH']) assert.equal(publicText.includes(secret), false);
    const body = { prompt: 'a thoughtful image', mode: 'generate', size: '1024x1024', quality: 'standard', count: 1, modelId: enabled.id, modelRevision: enabled.revision, expectedUnitPrice: 5 };
    for (const invalid of [{ ...body, modelId: randomUUID() }, { ...body, expectedUnitPrice: 1 }, { ...body, modelRevision: 999 }, { ...body, quality: 'high' }, { ...body, count: 2 }, { ...body, size: '1536x1024' }, { ...body, modelId: undefined }, { ...body, expectedUnitPrice: undefined }, { ...body, unitPrice: 1 }]) {
      assert.ok((await request('/tasks', 'user-session', 'POST', invalid, randomUUID())).status >= 400);
    }
    assert.equal(store.user(user.id).credits, 200); assert.equal(store.tasks(user.id).length, 0);
    const key = randomUUID(); const submittedResponse = await request('/tasks', 'user-session', 'POST', body, key); assert.equal(submittedResponse.status, 201);
    const submitted = await submittedResponse.json(); assert.equal(submitted.user.credits, 195); assert.equal(submitted.task.modelName, enabled.name);
    const updatedResponse = await request(`/admin/models/${enabled.id}`, 'admin-session', 'PUT', { ...editable(enabled), name: '已改名模型', upstreamModel: 'different-upstream-now', qualityMap: { standard: 'high', high: 'hd' }, sendSize: false, prices: { ...enabled.prices, generate: { standard: 77, high: 88 } }, enabled: false, isDefault: false, revision: enabled.revision });
    assert.equal(updatedResponse.status, 200);
    const updated = (await updatedResponse.json()).model;
    assert.equal((await request(`/admin/models/${enabled.id}`, 'admin-session', 'PUT', { ...editable(enabled), revision: enabled.revision })).status, 409);
    const retried = await request('/tasks', 'user-session', 'POST', body, key); assert.equal(retried.status, 201); assert.equal((await retried.json()).task.id, submitted.task.id);
    assert.equal((await request('/tasks', 'user-session', 'POST', { ...body, prompt: 'different request' }, key)).status, 409);
    assert.equal((await request('/tasks', 'user-session', 'POST', body, randomUUID())).status, 409);
    const queued = store.claimTask()!; assert.equal(queued.id, submitted.task.id); assert.equal(queued.model, 'private-upstream-fast'); assert.equal(queued.unit_price, 5);
    const snapshot = JSON.parse(queued.model_config_json!); assert.equal(snapshot.name, enabled.name); assert.equal(snapshot.qualityMap.standard, 'omit'); assert.equal(snapshot.sendSize, true);
    const output = store.addAsset(user.id, 'test-snapshot-output.png', 20, 20, 'output'); store.settleTask(queued.id, [output]);
    assert.equal(store.user(user.id).credits, 195); assert.equal(store.taskView(store.taskRow(queued.id)).charged, 5);
    const reenabledResponse = await request(`/admin/models/${enabled.id}`, 'admin-session', 'PUT', { ...editable(updated), enabled: true, revision: updated.revision }); assert.equal(reenabledResponse.status, 200);
    assert.equal((await request('/tasks', 'user-session', 'POST', body, randomUUID())).status, 409);
    const current = (await reenabledResponse.json()).model;
    const reference = store.addAsset(user.id, 'fake-reference.png', 10, 10, 'reference'); const mask = store.addAsset(user.id, 'fake-mask.png', 10, 10, 'mask');
    assert.equal((await request('/tasks', 'user-session', 'POST', { ...body, modelRevision: current.revision, expectedUnitPrice: 77, mode: 'inpaint', referenceId: reference.id, maskId: mask.id }, randomUUID())).status, 400);
    const editorResponse = await request('/admin/models', 'admin-session', 'POST', modelInput({ name: '参考图编辑', upstreamModel: 'private-editor', enabled: true, modes: ['edit'], maxImages: 1 }));
    assert.equal(editorResponse.status, 201); const editor = (await editorResponse.json()).model;
    const edited = await request('/tasks', 'user-session', 'POST', { ...body, modelId: editor.id, modelRevision: editor.revision, expectedUnitPrice: 8, mode: 'edit', referenceId: reference.id }, randomUUID());
    assert.equal(edited.status, 201); assert.equal((await edited.json()).task.reserved, 8);
    assert.equal(store.user(user.id).credits, 187);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
