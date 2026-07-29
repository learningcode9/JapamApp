import { uuidV5 } from '../deterministicUuid';

describe('uuidV5', () => {
  it('matches the RFC-compatible DNS namespace test vector', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'))
      .toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is deterministic and user-specific for default Japam names', () => {
    const namespace = '62f5824e-58fd-5d39-9f87-1f761082d8e3';
    const first = uuidV5('user-a:default-japam', namespace);
    const second = uuidV5('user-a:default-japam', namespace);
    const other = uuidV5('user-b:default-japam', namespace);

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
