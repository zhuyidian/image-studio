import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2] ?? 'yidian-image:ci';
const suffix = randomUUID().slice(0, 8);
const container = `yidian-image-check-${suffix}`;
const volume = `yidian-image-check-${suffix}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
let created = false;
async function healthy(base) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok && (await r.json()).ok) return; } catch { /* cold start */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Production container did not become healthy');
}
try {
  docker(['volume', 'create', volume]); created = true;
  docker(['run', '--detach', '--name', container, '--init', '--publish', '127.0.0.1::8787', '--mount', `source=${volume},target=/app/data`,
    '--env', 'NODE_ENV=production', '--env', 'APP_ORIGIN=https://image.yidianhub.com', '--env', 'PUBLIC_ORIGIN=https://image.yidianhub.com',
    '--env', 'IMAGE_PROVIDER=mock', '--env', 'MAIL_TRANSPORT=disabled', image]);
  const published = docker(['port', container, '8787/tcp']);
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const base = `http://${published}`;
  await healthy(base);
  assert.notEqual(docker(['exec', container, 'id', '-u']), '0');
  assert.equal((await fetch(base)).status, 200);
  const config = await fetch(`${base}/api/config`).then(r => r.json());
  assert.equal(config.demoAvailable, false); assert.equal(config.registration, false); assert.equal(config.paymentEnabled, false);
  assert.equal((await fetch(`${base}/api/admin/users`)).status, 401);
  const assets = (await fetch(base).then(r => r.text())).match(/(?:src|href)="(\/assets\/[^\"]+)"/g) ?? [];
  assert.ok(assets.length >= 2);
  for (const item of assets) assert.equal((await fetch(base + item.match(/"([^\"]+)"/)[1])).status, 200);
  docker(['exec', container, 'node', 'dist/scripts/admin.js', 'registration', 'true']);
  assert.equal((await fetch(`${base}/api/config`).then(r => r.json())).registration, false, 'Verification stays enabled while mail is disabled');
  docker(['exec', container, 'node', 'dist/scripts/admin.js', 'registration', 'false']);
  docker(['exec', container, 'node', '--input-type=module', '-e',
    "import {Store} from './dist/server/store.js';const s=new Store('/app/data/studio.sqlite');try{s.createUser('ci@example.test','CI','not-a-login-credential',123,'admin',true);}finally{s.close();}"]);
  docker(['restart', '--time', '30', container]); await healthy(base);
  const credits = docker(['exec', container, 'node', '--input-type=module', '-e',
    "import {Store} from './dist/server/store.js';const s=new Store('/app/data/studio.sqlite');try{console.log(s.findUser('ci@example.test').credits);}finally{s.close();}"]);
  assert.equal(credits, '123');
  console.log('Production container passed: non-root, frontend/API, protected routes, admin CLI and persistent SQLite.');
} catch (error) {
  try { console.error(docker(['logs', '--tail', '60', container])); } catch { /* may not have started */ }
  throw error;
} finally {
  try { docker(['rm', '--force', container]); } catch { /* only this isolated test container */ }
  if (created) docker(['volume', 'rm', volume]);
}
