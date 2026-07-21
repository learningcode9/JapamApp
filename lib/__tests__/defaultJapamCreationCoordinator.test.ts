import { createDefaultJapamCreationCoordinator } from '../defaultJapamCreationCoordinator';

describe('DefaultJapamCreationCoordinator', () => {
  let coordinator: ReturnType<typeof createDefaultJapamCreationCoordinator>;

  beforeEach(() => {
    coordinator = createDefaultJapamCreationCoordinator();
  });

  it('same user called twice concurrently → exactly one create call', async () => {
    let resolve: () => void;
    const deferred = new Promise<void>((r) => { resolve = r; });
    const create = jest.fn().mockImplementation(async () => { await deferred; });

    const p1 = coordinator.ensureCreation('user', create);
    const p2 = coordinator.ensureCreation('user', create);

    expect(create).toHaveBeenCalledTimes(1);

    resolve!();
    await Promise.all([p1, p2]);
  });

  it('different users A and B concurrently → exactly one create call each', async () => {
    let resolveA: () => void;
    const deferredA = new Promise<void>((r) => { resolveA = r; });
    let resolveB: () => void;
    const deferredB = new Promise<void>((r) => { resolveB = r; });

    const createA = jest.fn().mockImplementation(async () => { await deferredA; });
    const createB = jest.fn().mockImplementation(async () => { await deferredB; });

    const pA = coordinator.ensureCreation('A', createA);
    const pB = coordinator.ensureCreation('B', createB);

    expect(createA).toHaveBeenCalledTimes(1);
    expect(createB).toHaveBeenCalledTimes(1);

    resolveA!();
    resolveB!();
    await Promise.all([pA, pB]);
  });

  it('A → B → A rapid switch → exactly one create call for A and one for B', async () => {
    let resolveA: () => void;
    const deferredA = new Promise<void>((r) => { resolveA = r; });

    const createA = jest.fn().mockImplementation(async () => { await deferredA; });
    const createB = jest.fn().mockResolvedValue(undefined);

    const pA1 = coordinator.ensureCreation('A', createA);
    expect(createA).toHaveBeenCalledTimes(1);

    const pB = coordinator.ensureCreation('B', createB);
    expect(createB).toHaveBeenCalledTimes(1);

    const pA2 = coordinator.ensureCreation('A', createA);
    expect(createA).toHaveBeenCalledTimes(1);

    resolveA!();
    await Promise.all([pA1, pA2, pB]);

    expect(createA).toHaveBeenCalledTimes(1);
    expect(createB).toHaveBeenCalledTimes(1);
  });

  it('returns only after creation settles', async () => {
    let settled = false;
    const create = jest.fn().mockImplementation(async () => { settled = true; });

    await coordinator.ensureCreation('user', create);
    expect(settled).toBe(true);
  });

  it('subsequent creation for same user starts fresh after cleanup', async () => {
    const create = jest.fn().mockResolvedValue(undefined);

    await coordinator.ensureCreation('user', create);
    expect(create).toHaveBeenCalledTimes(1);

    await coordinator.ensureCreation('user', create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('failed creation clears entry and allows retry', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);

    await coordinator.ensureCreation('user', create);
    expect(create).toHaveBeenCalledTimes(1);

    await coordinator.ensureCreation('user', create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls return the same created value', async () => {
    let resolve: (v: string) => void;
    const deferred = new Promise<string>((r) => { resolve = r; });
    const create = jest.fn().mockImplementation(async () => {
      const result = await deferred;
      return result;
    });

    const p1 = coordinator.ensureCreation('user', create);
    const p2 = coordinator.ensureCreation('user', create);

    expect(create).toHaveBeenCalledTimes(1);

    resolve!('japam-42');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('japam-42');
    expect(r2).toBe('japam-42');
  });

  it('non-void create return value is propagated', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'j-1', name: 'My Japam' });

    const result = await coordinator.ensureCreation('user', create);
    expect(result).toEqual({ id: 'j-1', name: 'My Japam' });
  });
});
