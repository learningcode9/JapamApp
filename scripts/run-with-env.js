#!/usr/bin/env node
/**
 * Runs a command with environment variables loaded from a given .env-style file,
 * layered on top of (and taking precedence over) the normal .env/.env.local chain.
 * No new dependency — used only to switch between production (default, via plain
 * `npm start`) and staging (`npm run start:staging`) for local development.
 *
 * Usage: node scripts/run-with-env.js <envFile> -- <command> [...args]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const sepIndex = args.indexOf('--');
if (sepIndex <= 0) {
  console.error('Usage: node scripts/run-with-env.js <envFile> -- <command> [...args]');
  process.exit(1);
}

const envFile = args[0];
const command = args.slice(sepIndex + 1);
const envPath = path.resolve(process.cwd(), envFile);

if (!fs.existsSync(envPath)) {
  console.error(`[run-with-env] Env file not found: ${envPath}`);
  console.error(`[run-with-env] Copy ${envFile}.example to ${envFile} and fill in real values first.`);
  process.exit(1);
}

const parsed = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  parsed[key] = value;
}

console.log(`[run-with-env] Loaded ${Object.keys(parsed).length} var(s) from ${envFile}`);
for (const key of Object.keys(parsed)) {
  console.log(`[run-with-env]   ${key}`);
}

// parsed vars are spread last so they win over anything already in process.env —
// this also means Expo's own internal .env/.env.local loading (which does not
// override already-set process.env vars) will not clobber these.
const result = spawnSync(command[0], command.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, ...parsed },
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
