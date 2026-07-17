#!/usr/bin/env node

const PLACEHOLDER_PATTERN = /^(your[_-]?value[_-]?here|replace[_-]?me|placeholder|example|undefined|null)$/i;
const REQUIRED_VARS = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_GOOGLE_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
];
const ANDROID_VAR = 'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID';
const SUPPORTED_TARGETS = ['web', 'android'];
const GOOGLE_ID_RE = /^[^\s]+\.apps\.googleusercontent\.com$/;
const PUBLISHABLE_PREFIX = 'sb_publishable_';
const JWT_SEGMENT_RE = /^[A-Za-z0-9_-]+=*$/;

function isPlaceholder(val) {
  return PLACEHOLDER_PATTERN.test(val.trim());
}

function validateSupabaseUrl(val) {
  let parsed;
  try {
    parsed = new URL(val);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (!parsed.hostname.endsWith('.supabase.co')) return false;
  return true;
}

function validateAnonKey(val) {
  const trimmed = val.trim();
  if (trimmed.indexOf(PUBLISHABLE_PREFIX) === 0) {
    return trimmed.length > PUBLISHABLE_PREFIX.length;
  }
  const parts = trimmed.split('.');
  if (parts.length !== 3) return false;
  for (let i = 0; i < parts.length; i++) {
    if (!JWT_SEGMENT_RE.test(parts[i])) return false;
  }
  return true;
}

function validateGoogleClientId(val) {
  return GOOGLE_ID_RE.test(val.trim());
}

function validateEnv(options) {
  if (!options) options = {};
  const target = options.target || 'web';
  const env = options.env || process.env;
  const errors = [];

  if (SUPPORTED_TARGETS.indexOf(target) === -1) {
    errors.push({
      name: '(target)',
      reason: `unsupported target "${target}"; supported: ${SUPPORTED_TARGETS.join(', ')}`,
    });
    return errors;
  }

  function check(name, val) {
    if (!val || val.trim() === '') {
      errors.push({ name, reason: 'missing' });
      return false;
    }
    const trimmed = val.trim();
    if (isPlaceholder(trimmed)) {
      errors.push({ name, reason: 'placeholder value' });
      return false;
    }
    return true;
  }

  for (const name of REQUIRED_VARS) {
    const val = env[name];
    if (!check(name, val)) continue;
    const trimmed = val.trim();

    if (name === 'EXPO_PUBLIC_SUPABASE_URL') {
      if (!validateSupabaseUrl(trimmed)) {
        errors.push({ name, reason: 'must be an https:// URL ending in .supabase.co' });
      }
    }

    if (name === 'EXPO_PUBLIC_SUPABASE_ANON_KEY') {
      if (!validateAnonKey(trimmed)) {
        errors.push({ name, reason: 'must be a valid publishable key (sb_publishable_...) or JWT (header.payload.signature)' });
      }
    }

    if (name === 'EXPO_PUBLIC_GOOGLE_CLIENT_ID' || name === 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID') {
      if (!validateGoogleClientId(trimmed)) {
        errors.push({ name, reason: 'must end with .apps.googleusercontent.com' });
      }
    }
  }

  if (target === 'android') {
    const androidVal = env[ANDROID_VAR];
    if (check(ANDROID_VAR, androidVal)) {
      if (!validateGoogleClientId(androidVal.trim())) {
        errors.push({ name: ANDROID_VAR, reason: 'must end with .apps.googleusercontent.com' });
      }
    }
  }

  return errors;
}

function parseArgs(args) {
  let target = 'web';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && i + 1 < args.length) {
      target = args[i + 1];
      break;
    }
  }
  return { target };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const errors = validateEnv({ target: opts.target });

  if (errors.length > 0) {
    console.error('\n\u274c Build aborted: required environment variables missing or invalid:\n');
    for (const { name, reason } of errors) {
      console.error(`   ${name} \u2014 ${reason}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log('\u2713 All required environment variables present and valid.');
}

module.exports = { validateEnv, parseArgs };

if (require.main === module) {
  main();
}
