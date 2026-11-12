import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../server/config.js';

test('production disables demo login, public registration and free credits by default', () => {
  const config = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://image.yidianhub.com', IMAGE_PROVIDER: 'newapi', NEW_API_BASE_URL: 'https://gateway.example.com/v1', NEW_API_KEY: 'private-test-key' });
  assert.equal(config.registration, false); assert.equal(config.signupCredits, 0); assert.equal(publicConfig(config).demoAvailable, false);
  assert.equal(JSON.stringify(publicConfig(config)).includes('private-test-key'), false);
});
test('configuration refuses insecure production, missing model credentials and real payments for mock images', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://image.yidianhub.com' }), /HTTPS/);
  assert.throws(() => loadConfig({ IMAGE_PROVIDER: 'newapi' }), /未配置/);
  assert.throws(() => loadConfig({ PAYMENT_PROVIDER: 'epay', IMAGE_PROVIDER: 'mock' }), /模拟图片模式禁止/);
});
