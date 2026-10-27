import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const valid = { CLOUDFLARE_DATABASE_ID: '01234567-89ab-cdef-0123-456789abcdef', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', WORKERS_CI_BRANCH: 'main' };

test('GitHub build injects resource IDs and preserves all private bindings without embedding secrets', async () => {
  const { createDeployConfig } = await import('../configure-build.mjs');
  const config = createDeployConfig(base, { ...valid, R2_BUCKET_NAME: 'athlete-private', ARENA_WORKER_TOKEN: 'never-in-build-output', CLOUDFLARE_API_TOKEN: 'never-in-build-output' });
  assert.equal(config.d1_databases[0].database_id, valid.CLOUDFLARE_DATABASE_ID);
  assert.equal(config.account_id, valid.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.vars.ARENA_RESULTS_ONLY, 'true');
  assert.equal(config.assets.directory, '../frontend/dist');
  assert.equal(config.keep_vars, true);
  assert.ok(!JSON.stringify(config).includes('never-in-build-output'));
  assert.equal(base.d1_databases[0].database_id, 'REPLACE_WITH_CREATED_D1_DATABASE_ID');
});

test('production build refuses missing IDs and nonproduction branches before deployment', async () => {
  const { createDeployConfig } = await import('../configure-build.mjs');
  assert.throws(() => createDeployConfig(base, {}), /CLOUDFLARE_DATABASE_ID/);
  assert.throws(() => createDeployConfig(base, { ...valid, WORKERS_CI_BRANCH: 'feature/test' }), /main/);
  assert.throws(() => createDeployConfig(base, { ...valid, CLOUDFLARE_ACCOUNT_ID: 'wrong' }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(createDeployConfig(base, { ...valid, R2_BUCKET_NAME: '../private' }).r2_buckets, undefined);
});
