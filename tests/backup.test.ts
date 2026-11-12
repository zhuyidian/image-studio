import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { createBackup, verifyBackup } from '../server/backup.js';

test('database and immutable media backup restores independently and detects corrupted files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yidian-backup-test-'));
  const source = path.join(root, 'source'); await mkdir(path.join(source, 'media'), { recursive: true });
  const store = new Store(path.join(source, 'studio.sqlite'));
  try {
    const user = store.createUser('creator@example.com', '创作者', 'hash', 100);
    store.addAsset(user.id, 'image.png', 10, 10, 'reference');
    await writeFile(path.join(source, 'media', 'image.png'), 'immutable-image-bytes');
    const backupDirectory = path.join(root, 'backup'); await createBackup(source, backupDirectory);
    const checked = await verifyBackup(backupDirectory); assert.equal(checked.valid, true); assert.equal(checked.images, 1); assert.equal(checked.users, 1);
    store.createVoucher('IMG-LATER', 50, new Date(Date.now() + 86400000).toISOString()); store.redeem(user.id, 'IMG-LATER');
    const restoredDirectory = path.join(root, 'restored'); await mkdir(path.join(restoredDirectory, 'media'), { recursive: true });
    await copyFile(path.join(backupDirectory, 'studio.sqlite'), path.join(restoredDirectory, 'studio.sqlite'));
    await copyFile(path.join(backupDirectory, 'media', 'image.png'), path.join(restoredDirectory, 'media', 'image.png'));
    const restored = new Store(path.join(restoredDirectory, 'studio.sqlite'));
    try { assert.equal(restored.user(user.id).credits, 100); assert.equal(restored.asset(store.db.prepare('SELECT id FROM assets').get()!.id as string, user.id).filename, 'image.png'); }
    finally { restored.close(); }
    assert.equal(store.user(user.id).credits, 150);
    await writeFile(path.join(backupDirectory, 'media', 'image.png'), 'corrupt');
    await assert.rejects(verifyBackup(backupDirectory), /图片损坏/);
  } finally {
    store.close();
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'yidian-backup-test-')));
    await rm(root, { recursive: true, force: true });
  }
});
