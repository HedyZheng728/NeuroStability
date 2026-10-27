/** Workers Builds supplies account credentials; Git contains no personal account IDs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function createDeployConfig(base, env) {
  if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(env.CLOUDFLARE_DATABASE_ID || '')) throw new Error('Set CLOUDFLARE_DATABASE_ID in Cloudflare Build variables.');
  if (env.WORKERS_CI_BRANCH && env.WORKERS_CI_BRANCH !== 'main') throw new Error('Production deploy accepts main only; use isolated resources for previews.');
  if (!/^[a-f\d]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the target account in Cloudflare Build variables.');
  const config = structuredClone(base);
  config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  config.keep_vars = true;
  config.d1_databases[0].database_id = env.CLOUDFLARE_DATABASE_ID;
  delete config.r2_buckets;
  config.vars = { ...config.vars, ARENA_RESULTS_ONLY: 'true' };
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const base = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
    const config = createDeployConfig(base, process.env);
    writeFileSync(new URL('./wrangler.deploy.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
    console.log('Production bindings prepared; credentials and runtime secrets are not written to the config.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
