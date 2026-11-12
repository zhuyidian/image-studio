import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { loadConfig } from '../server/config.js';
import { NewApiProvider, ProviderFailure } from '../server/provider.js';
import type { MediaStore } from '../server/media.js';
import type { TaskRow } from '../server/store.js';

test('New API adapter uses the configured gateway, maps retail quality and never retries ambiguous failures', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#aaccee' } }).png().toBuffer();
  let calls = 0; let responseStatus = 200; let lastUrl = ''; let lastBody = '';
  const upstream = createServer(async (req, res) => {
    calls++; lastUrl = req.url!; const chunks = []; for await (const chunk of req) chunks.push(chunk); lastBody = Buffer.concat(chunks).toString();
    assert.equal(req.headers.authorization, 'Bearer test-key');
    res.writeHead(responseStatus, { 'Content-Type': 'application/json', 'X-Request-ID': 'upstream-123' });
    res.end(JSON.stringify(responseStatus === 200 ? { data: [{ b64_json: png.toString('base64') }], usage: { total_tokens: 9 } } : { error: { message: 'SECRET upstream detail' } }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => upstream.once('listening', resolve));
  const address = upstream.address() as { port: number };
  const config = loadConfig({ NODE_ENV: 'test', IMAGE_PROVIDER: 'newapi', NEW_API_BASE_URL: `http://127.0.0.1:${address.port}/v1/`, NEW_API_KEY: 'test-key' });
  const provider = new NewApiProvider(config, { read: async () => png } as unknown as MediaStore);
  const task = { id: 'test-task-id', model: 'gpt-image-2', prompt: 'a test', quality: 'standard', size: '1024x1024', count: 1, mode: 'generate', user_id: 'test-user', reference_id: 'test-reference', mask_id: 'test-mask' } as TaskRow;
  try {
    const result = await provider.generate(task); assert.deepEqual(result.images[0], png); assert.equal(result.requestId, 'upstream-123');
    assert.equal(lastUrl, '/v1/images/generations'); assert.equal(JSON.parse(lastBody).quality, 'medium'); assert.equal(JSON.parse(lastBody).model, 'gpt-image-2');
    await provider.generate({ ...task, mode: 'inpaint' }); assert.equal(lastUrl, '/v1/images/edits'); assert.match(lastBody, /name="image"/); assert.match(lastBody, /name="mask"/);
    responseStatus = 502;
    await assert.rejects(provider.generate(task), (e: unknown) => e instanceof ProviderFailure && e.uncertain && !e.message.includes('SECRET')); assert.equal(calls, 3);
    responseStatus = 400;
    await assert.rejects(provider.generate(task), (e: unknown) => e instanceof ProviderFailure && !e.uncertain); assert.equal(calls, 4);
  } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test('queued model snapshots control request mapping and price edits cannot change upstream parameters', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#abccdd' } }).png().toBuffer();
  let lastBody: Record<string, unknown> = {};
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); lastBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => upstream.once('listening', resolve));
  const config = loadConfig({ NODE_ENV: 'test', IMAGE_PROVIDER: 'newapi', NEW_API_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, NEW_API_KEY: 'test-key', NEW_API_IMAGE_MODEL: 'new-config-model' });
  const provider = new NewApiProvider(config, {} as MediaStore);
  const task = { id: 'snapshot-test', user_id: 'test-user', model: 'original-model', prompt: 'image test', size: '1024x1024', quality: 'standard', count: 1, mode: 'generate',
    model_config_json: JSON.stringify({ catalogModelId: 'catalog-id', name: '原模型', adapter: 'images-v1', qualityMap: { standard: 'omit', high: 'hd' }, sendSize: false }) } as TaskRow;
  try {
    await provider.generate(task); assert.equal(lastBody.model, 'original-model'); assert.equal('quality' in lastBody, false); assert.equal('size' in lastBody, false);
    await provider.generate({ ...task, quality: 'high' }); assert.equal(lastBody.quality, 'hd'); assert.equal(lastBody.model, 'original-model');
    await assert.rejects(provider.generate({ ...task, model_config_json: JSON.stringify({ adapter: 'unsupported' }) }), (error: unknown) => error instanceof ProviderFailure && !error.uncertain);
  } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
