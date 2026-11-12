import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { MediaStore } from '../server/media.js';
import { MiB, outputReservationBytes } from '../server/storage.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createBackup, verifyBackup } from '../server/backup.js';
import { withMediaLock } from '../server/media-lock.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'yidian-storage-test-'));
  await mkdir(path.join(root, 'media'));
  const store = new Store(path.join(root, 'studio.sqlite')); const media = new MediaStore(store, root); const storage = media.storage;
  const user = store.createUser('creator@example.com', '创作者', 'hash', 1000, 'user', true);
  const other = store.createUser('other@example.com', '其他用户', 'hash', 1000, 'user', true);
  const admin = store.createUser('admin@example.com', '管理员', 'hash', 0, 'admin', true);
  const png = await sharp({ create: { width: 48, height: 48, channels: 4, background: '#aabbcc' } }).png().toBuffer();
  const create = (owner = user.id, referenceId?: string, reserved = false) => store.createTask({ userId: owner, prompt: 'test storage work', mode: referenceId ? 'edit' : 'generate', size: '1024x1024', quality: 'standard', count: 1,
    model: 'test', provider: 'mock', unitPrice: 12, referenceId, maxActive: 20, key: randomUUID(), ...(reserved ? { storageLimitBytes: storage.policy().userLimitMiB * MiB, storageReserveBytes: outputReservationBytes } : {}) });
  const success = async (referenceId?: string) => {
    const task = create(user.id, referenceId); const claimed = store.claimTask(); assert.equal(claimed?.id, task.id);
    const asset = await media.save(user.id, png, 'output', task.id); store.settleTask(task.id, [asset]); return { task, asset, filename: store.asset(asset.id, user.id).filename };
  };
  const close = async () => { store.close(); assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'yidian-storage-test-'))); await rm(root, { recursive: true, force: true }); };
  return { root, store, media, storage, user, other, admin, png, create, success, close };
}

test('trash, restore and permanent cleanup preserve ledger; shared references protect original images', async () => {
  const f = await fixture();
  try {
    const first = await f.success(); const second = await f.success(first.asset.id);
    const balance = f.store.user(f.user.id).credits; const ledgerBefore = f.store.ledger(f.user.id);
    const usedBefore = f.storage.usage(f.user.id).usedBytes;
    f.storage.changeWorks(f.user.id, [first.task.id], 'trash');
    assert.equal(f.store.tasks(f.user.id).some(t => t.id === first.task.id), false); assert.equal(f.storage.works(f.user.id, 'trash', 1).trashTotal, 1);
    assert.equal(f.storage.usage(f.user.id).usedBytes, usedBefore); assert.ok(f.storage.works(f.user.id, 'trash', 1).items[0].purgeAfter);
    f.storage.changeWorks(f.user.id, [first.task.id], 'restore'); assert.equal(f.storage.works(f.user.id, 'active', 1).activeTotal, 2);
    f.storage.changeWorks(f.user.id, [first.task.id], 'trash'); f.storage.changeWorks(f.user.id, [first.task.id], 'purge');
    const protectedReport = await f.storage.cleanup(f.user.id); assert.equal(protectedReport.removedFiles, 0);
    assert.ok((await f.media.read(first.asset.id, f.user.id)).length); assert.equal(f.storage.usage(f.user.id).protectedBytes, f.png.length);
    assert.equal(f.store.taskView(f.store.taskRow(first.task.id)).outputs.length, 0);
    assert.throws(() => f.storage.changeWorks(f.user.id, [first.task.id], 'restore'), /已永久清除/);
    f.storage.changeWorks(f.user.id, [second.task.id], 'trash'); f.storage.changeWorks(f.user.id, [second.task.id], 'purge');
    const removed = await f.storage.cleanup(f.user.id); assert.equal(removed.removedFiles, 2); assert.equal(f.storage.usage(f.user.id).usedBytes, 0);
    assert.throws(() => f.store.asset(first.asset.id, f.user.id), /不存在/); await assert.rejects(access(path.join(f.root, 'media', first.filename)));
    assert.equal(f.store.user(f.user.id).credits, balance); assert.deepEqual(f.store.ledger(f.user.id), ledgerBefore);
    assert.ok(f.store.taskRow(first.task.id).purged_at); assert.equal(f.store.taskRow(first.task.id).charged, 12);
    assert.equal((await f.storage.cleanup(f.user.id)).reclaimedBytes, 0);
  } finally { await f.close(); }
});

test('ownership, active tasks and atomic batch validation prevent deleting or reusing protected records', async () => {
  const f = await fixture();
  try {
    const done = await f.success(); const active = f.create();
    assert.throws(() => f.storage.changeWorks(f.user.id, [done.task.id, active.id], 'trash'), /不能删除/);
    assert.equal(f.store.taskRow(done.task.id).deleted_at, null);
    assert.throws(() => f.storage.changeWorks(f.other.id, [done.task.id], 'trash'), /无权访问/);
    f.store.claimTask(); f.store.markUncertain(active.id); assert.throws(() => f.storage.changeWorks(f.user.id, [active.id], 'trash'), /不能删除/);
    f.storage.changeWorks(f.user.id, [done.task.id], 'trash'); f.storage.changeWorks(f.user.id, [done.task.id], 'purge');
    await f.storage.cleanup(f.user.id);
    const before = f.store.user(f.user.id).credits;
    assert.throws(() => f.create(f.user.id, done.asset.id), /图片不存在/); assert.equal(f.store.user(f.user.id).credits, before);
    assert.equal(f.storage.works(f.other.id, 'trash', 1).items.length, 0);
  } finally { await f.close(); }
});

test('limits account for uploads, trash and reserved outputs before credit debit; in-flight output survives lower limits', async () => {
  const f = await fixture();
  try {
    f.storage.updatePolicy({ ...f.storage.policy(), userLimitMiB: 40, dailyUploadLimit: 1, maxUploadMiB: 1 }, f.admin.id);
    const uploaded = await f.media.save(f.user.id, f.png, 'reference'); assert.equal(f.storage.usage(f.user.id).uploadedToday, 1);
    await assert.rejects(f.media.save(f.user.id, f.png, 'reference'), /上传次数/);
    assert.throws(() => f.storage.checkUpload(f.other.id, MiB + 1), /不能超过/);
    const first = f.create(f.user.id, undefined, true); assert.equal(f.storage.usage(f.user.id).reservedBytes, outputReservationBytes);
    const before = f.store.user(f.user.id).credits; assert.throws(() => f.create(f.user.id, undefined, true), /空间不足/); assert.equal(f.store.user(f.user.id).credits, before);
    const claimed = f.store.claimTask(); assert.equal(claimed?.id, first.id);
    const output = await f.media.save(f.user.id, f.png, 'output', first.id); assert.equal(f.storage.usage(f.user.id).reservedBytes, 0);
    f.store.settleTask(first.id, [output]); assert.equal(f.storage.usage(f.user.id).assets, 2);
    f.storage.changeWorks(f.user.id, [first.id], 'trash'); assert.equal(f.storage.usage(f.user.id).assets, 2);
    f.storage.changeWorks(f.user.id, [first.id], 'purge'); await f.storage.cleanup(f.user.id); assert.equal(f.storage.usage(f.user.id).uploadedToday, 1);
    assert.ok(f.store.asset(uploaded.id, f.user.id));
    // Simulate a quota lowered below existing data after this task has already started.
    const task = f.create(f.other.id, undefined, true); f.store.claimTask();
    f.store.addAsset(f.other.id, 'large-existing.png', 1, 1, 'reference', 39 * MiB);
    const delivered = await f.media.save(f.other.id, f.png, 'output', task.id); f.store.settleTask(task.id, [delivered]); assert.equal(f.store.taskRow(task.id).charged, 12);
    assert.throws(() => f.create(f.other.id, undefined, true), /空间不足/);
  } finally { await f.close(); }
});

test('retention first moves old work to trash; restore resets its timer; expired trash and orphan files are reclaimed safely', async () => {
  const f = await fixture();
  try {
    const done = await f.success(); const orphan = await f.media.save(f.user.id, f.png, 'reference');
    const base = f.storage.policy(); f.storage.updatePolicy({ ...base, workRetentionDays: 1, trashRetentionDays: 7, orphanRetentionDays: 1 }, f.admin.id);
    assert.throws(() => f.storage.updatePolicy(base, f.admin.id), /已更新/);
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    f.store.db.prepare('UPDATE tasks SET created_at=?,finished_at=? WHERE id=?').run(old, old, done.task.id);
    const moved = await f.storage.cleanup(f.user.id); assert.equal(moved.movedToTrash, 1); assert.equal(moved.removedFiles, 0);
    f.storage.changeWorks(f.user.id, [done.task.id], 'restore'); assert.equal((await f.storage.cleanup(f.user.id)).movedToTrash, 0);
    f.storage.changeWorks(f.user.id, [done.task.id], 'trash'); f.store.db.prepare('UPDATE tasks SET purge_after=? WHERE id=?').run(old, done.task.id);
    assert.throws(() => f.storage.changeWorks(f.user.id, [done.task.id], 'restore'), /保留期已结束/);
    f.store.db.prepare('UPDATE assets SET created_at=? WHERE id=?').run(old, orphan.id);
    const cleaned = await f.storage.cleanup(f.user.id); assert.equal(cleaned.purgedWorks, 1); assert.equal(cleaned.removedFiles, 2); assert.equal(f.storage.usage(f.user.id).usedBytes, 0);
    assert.equal(f.store.user(f.user.id).credits, 988); assert.equal(f.store.ledger(f.user.id).length, 3);
  } finally { await f.close(); }
});

test('cleanup and backup serialize; deleted tombstones restore without missing media or ledger loss', async () => {
  const f = await fixture();
  try {
    const done = await f.success(); const held = await f.media.save(f.user.id, f.png, 'reference');
    f.storage.changeWorks(f.user.id, [done.task.id], 'trash'); f.storage.changeWorks(f.user.id, [done.task.id], 'purge');
    let release!: () => void; let acquired!: () => void;
    const acquiredSignal = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = withMediaLock(f.root, async () => { acquired(); await gate; }); await acquiredSignal;
    let cleaned = false; const pending = f.storage.cleanup(f.user.id).then(value => { cleaned = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(cleaned, false); release(); await lock; await pending;
    const backupDirectory = path.join(f.root, 'backup'); await createBackup(f.root, backupDirectory);
    const verification = await verifyBackup(backupDirectory); assert.equal(verification.images, 1);
    const restored = new Store(path.join(backupDirectory, 'studio.sqlite'));
    try { assert.equal(restored.user(f.user.id).credits, 988); assert.ok(restored.taskRow(done.task.id).purged_at); assert.ok(restored.asset(held.id, f.user.id)); assert.equal(restored.taskView(restored.taskRow(done.task.id)).outputs.length, 0); }
    finally { restored.close(); }
    const manifest = JSON.parse(await readFile(path.join(backupDirectory, 'manifest.json'), 'utf8')); assert.equal(manifest.media.length, 1);
  } finally { await f.close(); }
});

test('works HTTP routes enforce user ownership, confirmation, limits and pagination', async () => {
  const f = await fixture(); const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: f.root });
  f.store.createSession(f.user.id, 'user-token'); f.store.createSession(f.other.id, 'other-token'); f.store.createSession(f.admin.id, 'admin-token');
  const server = createApp(config, f.store, f.media).listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = (route: string, method = 'GET', body?: unknown, token = 'user-token', origin = config.origin) => fetch(base + route, { method, headers: { Origin: origin, Cookie: `studio_session=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const done = await f.success();
    assert.equal((await request('/storage', 'GET', undefined, '')).status, 401); assert.equal((await request('/admin/storage')).status, 403);
    const policy = (await request('/admin/storage', 'GET', undefined, 'admin-token').then(r => r.json())).policy;
    assert.equal((await request('/admin/storage', 'PUT', { ...policy, userLimitMiB: 1 }, 'admin-token')).status, 400);
    assert.equal((await request('/works?scope=unknown')).status, 400);
    const mutation = { ids: [done.task.id], action: 'trash' };
    assert.equal((await request('/works/actions', 'POST', mutation, 'other-token')).status, 404);
    assert.equal((await request('/works/actions', 'POST', mutation, 'user-token', 'https://evil.example.com')).status, 403);
    assert.equal((await request('/works/actions', 'POST', { ...mutation, ids: [done.task.id, done.task.id] })).status, 400);
    assert.equal((await request('/works/actions', 'POST', mutation)).status, 200);
    assert.equal((await request('/tasks').then(r => r.json())).tasks.length, 0);
    assert.equal((await request('/works?scope=trash').then(r => r.json())).items.length, 1);
    assert.equal((await request('/works/actions', 'POST', { ...mutation, action: 'purge' })).status, 400);
    assert.equal((await request('/works/actions', 'POST', { ...mutation, action: 'restore' })).status, 200);
    for (let i = 0; i < 23; i++) { const t = f.create(); f.store.claimTask(); f.store.settleTask(t.id, [], 'explicit failure'); }
    const works = await request('/works?page=2').then(r => r.json()); assert.equal(works.total, 24); assert.equal(works.items.length, 4);
    assert.equal((await request('/works?q=nevermatch').then(r => r.json())).items.length, 0);
    const usage = await request('/storage').then(r => r.json()); assert.equal(usage.usedBytes, f.png.length); assert.equal('filename' in usage, false);
    assert.equal((await request('/works/actions', 'POST', mutation)).status, 200);
    assert.equal((await request('/works/actions', 'POST', { ...mutation, action: 'purge', confirm: true })).status, 200);
    assert.equal((await request(`/assets/${done.asset.id}`)).status, 404);
    assert.equal(f.store.user(f.user.id).credits, 988);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('legacy image sizes are backfilled from files and cleanup never follows an out-of-directory filename', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'media', 'legacy.png'), f.png);
    const legacy = f.store.addAsset(f.user.id, 'legacy.png', 48, 48, 'reference');
    assert.equal(f.storage.usage(f.user.id).usedBytes, outputReservationBytes);
    await f.storage.initializeSizes(); assert.equal(f.storage.usage(f.user.id).usedBytes, f.png.length);
    assert.equal(f.store.asset(legacy.id, f.user.id).byte_size, f.png.length);
    const outside = path.join(f.root, 'outside.txt'); await writeFile(outside, 'must remain');
    const malicious = f.store.addAsset(f.user.id, '../outside.txt', 1, 1, 'reference', 11);
    f.store.db.prepare('UPDATE assets SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', malicious.id);
    const report = await f.storage.cleanup(f.user.id); assert.equal(report.pendingFiles, 1); assert.equal(await readFile(outside, 'utf8'), 'must remain');
    assert.equal((await f.media.read(legacy.id, f.user.id)).length, f.png.length);
  } finally { await f.close(); }
});
