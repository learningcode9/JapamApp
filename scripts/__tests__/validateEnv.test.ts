import { validateEnv, parseArgs } from '../validate-env';

const VALID_SUPABASE_URL = 'https://rftlqybgnb.supabase.co';
const VALID_PUBLISHABLE_KEY = 'sb_publishable_WAU1234567890abcdef';
const VALID_LEGACY_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdF9zaWduYXR1cmU';
const VALID_GOOGLE_ID = '1234567890-something.apps.googleusercontent.com';
const VALID_ANDROID_ID = '1234567890-android.apps.googleusercontent.com';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

const WEB_ENV = {
  EXPO_PUBLIC_SUPABASE_URL: VALID_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_PUBLISHABLE_KEY,
  EXPO_PUBLIC_GOOGLE_CLIENT_ID: VALID_GOOGLE_ID,
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: VALID_GOOGLE_ID,
};

const ANDROID_ENV = {
  ...WEB_ENV,
  EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: VALID_ANDROID_ID,
};

describe('validate-env', () => {
  describe('valid configurations', () => {
    it('passes valid web configuration (default target)', () => {
      withEnv(WEB_ENV, () => {
        expect(validateEnv()).toEqual([]);
      });
    });

    it('passes valid web configuration (explicit target)', () => {
      withEnv(WEB_ENV, () => {
        expect(validateEnv({ target: 'web' })).toEqual([]);
      });
    });

    it('passes valid Android configuration', () => {
      withEnv(ANDROID_ENV, () => {
        expect(validateEnv({ target: 'android' })).toEqual([]);
      });
    });

    it('accepts legacy JWT-style anon key', () => {
      withEnv(
        { ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_LEGACY_KEY },
        () => {
          expect(validateEnv()).toEqual([]);
        },
      );
    });

    it('accepts modern sb_publishable_ key', () => {
      withEnv(
        { ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_PUBLISHABLE_KEY },
        () => {
          expect(validateEnv()).toEqual([]);
        },
      );
    });
  });

  describe('target handling', () => {
    it('rejects unsupported target', () => {
      const errors = validateEnv({ target: 'production' });
      expect(errors).toHaveLength(1);
      expect(errors[0].name).toBe('(target)');
      expect(errors[0].reason).toContain('unsupported target');
    });

    it('default target is web', () => {
      expect(parseArgs([])).toEqual({ target: 'web' });
    });

    it('parses --target android from args', () => {
      expect(parseArgs(['--target', 'android'])).toEqual({ target: 'android' });
    });
  });

  describe('missing variables', () => {
    for (const name of [
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_SUPABASE_ANON_KEY',
      'EXPO_PUBLIC_GOOGLE_CLIENT_ID',
      'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
    ]) {
      it(`reports missing ${name}`, () => {
        withEnv({ ...WEB_ENV, [name]: undefined }, () => {
          const errors = validateEnv();
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({ name, reason: 'missing' });
        });
      });
    }

    it('reports Android client ID missing for Android target', () => {
      withEnv(WEB_ENV, () => {
        const errors = validateEnv({ target: 'android' });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          name: 'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID',
          reason: 'missing',
        });
      });
    });

    it('does not require Android client ID for web target', () => {
      withEnv(WEB_ENV, () => {
        expect(validateEnv({ target: 'web' })).toEqual([]);
      });
    });
  });

  describe('empty and whitespace', () => {
    it('reports empty string as missing', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_URL: '' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ name: 'EXPO_PUBLIC_SUPABASE_URL', reason: 'missing' });
      });
    });

    it('reports whitespace-only as missing', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: '   ' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ name: 'EXPO_PUBLIC_SUPABASE_ANON_KEY', reason: 'missing' });
      });
    });
  });

  describe('placeholder detection', () => {
    const placeholders = [
      'your-value-here',
      'your_value_here',
      'replace-me',
      'replace_me',
      'placeholder',
      'example',
      'undefined',
      'null',
      'YOUR_VALUE_HERE',
    ];

    for (const placeholder of placeholders) {
      it(`rejects placeholder "${placeholder}"`, () => {
        withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_URL: placeholder }, () => {
          const errors = validateEnv();
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({ name: 'EXPO_PUBLIC_SUPABASE_URL', reason: 'placeholder value' });
        });
      });
    }
  });

  describe('Supabase URL validation', () => {
    it('rejects http:// URL', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_URL: 'http://rftlqybgnb.supabase.co' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('https://');
      });
    });

    it('rejects unrelated HTTPS hostname', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_URL: 'https://example.com' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('.supabase.co');
      });
    });

    it('rejects malformed URL', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_URL: 'not-a-url' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('https://');
      });
    });

    it('rejects HTTPS URL with valid suffix but wrong subdomain', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_URL: 'https://evil.com?host=something.supabase.co' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
      });
    });
  });

  describe('Supabase anon key validation', () => {
    it('rejects short random string', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'too-short' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('publishable');
      });
    });

    it('rejects long random string without valid format', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'this-is-a-long-random-string-without-valid-format' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('publishable');
      });
    });

    it('rejects empty key', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: '' }, () => {
        const errors = validateEnv();
        expect(errors[0].reason).toBe('missing');
      });
    });

    it('rejects JWT with only two segments', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'header.payload' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('publishable');
      });
    });

    it('rejects JWT with four segments', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'a.b.c.d' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('publishable');
      });
    });

    it('rejects JWT with invalid characters in segment', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'header.pay-load.signature!' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('publishable');
      });
    });

    it('rejects placeholder in key', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'your-value-here' }, () => {
        const errors = validateEnv();
        expect(errors[0].reason).toBe('placeholder value');
      });
    });
  });

  describe('Google client ID validation', () => {
    it('rejects invalid suffix', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_GOOGLE_CLIENT_ID: 'bad-client-id' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toContain('.apps.googleusercontent.com');
      });
    });

    it('rejects suffix in the middle of string', () => {
      withEnv(
        { ...WEB_ENV, EXPO_PUBLIC_GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com.evil.com' },
        () => {
          const errors = validateEnv();
          expect(errors).toHaveLength(1);
          expect(errors[0].reason).toContain('end with');
        },
      );
    });

    it('rejects unrelated domain', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'test@example.com' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
      });
    });

    it('rejects placeholder in Google client ID', () => {
      withEnv({ ...WEB_ENV, EXPO_PUBLIC_GOOGLE_CLIENT_ID: 'placeholder' }, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toBe('placeholder value');
      });
    });

    it('validates Android client ID format when present', () => {
      withEnv(
        { ...ANDROID_ENV, EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: 'bad-format' },
        () => {
          const errors = validateEnv({ target: 'android' });
          expect(errors).toHaveLength(1);
          expect(errors[0].reason).toContain('.apps.googleusercontent.com');
        },
      );
    });
  });

  describe('multiple errors', () => {
    it('reports all missing variables simultaneously', () => {
      const empty: Record<string, undefined> = {
        EXPO_PUBLIC_SUPABASE_URL: undefined,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: undefined,
        EXPO_PUBLIC_GOOGLE_CLIENT_ID: undefined,
        EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: undefined,
      };
      withEnv(empty, () => {
        const errors = validateEnv();
        expect(errors).toHaveLength(4);
        for (const e of errors) {
          expect(e.reason).toBe('missing');
        }
      });
    });
  });

  describe('parseArgs', () => {
    it('defaults to web target', () => {
      expect(parseArgs([])).toEqual({ target: 'web' });
    });

    it('parses --target web', () => {
      expect(parseArgs(['--target', 'web'])).toEqual({ target: 'web' });
    });

    it('parses --target android', () => {
      expect(parseArgs(['--target', 'android'])).toEqual({ target: 'android' });
    });

    it('ignores flags without value', () => {
      expect(parseArgs(['--target'])).toEqual({ target: 'web' });
    });
  });

  describe('validateEnv with custom env', () => {
    it('accepts custom env object instead of process.env', () => {
      const errors = validateEnv({
        target: 'web',
        env: {
          EXPO_PUBLIC_SUPABASE_URL: VALID_SUPABASE_URL,
          EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_PUBLISHABLE_KEY,
          EXPO_PUBLIC_GOOGLE_CLIENT_ID: VALID_GOOGLE_ID,
          EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: VALID_GOOGLE_ID,
        },
      });
      expect(errors).toEqual([]);
    });
  });
});
