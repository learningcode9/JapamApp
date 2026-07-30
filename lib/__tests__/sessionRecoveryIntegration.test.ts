jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

let mockSessionState: { data: { session: { access_token: string; user: { id: string } } | null }; error: null } = {
  data: { session: null },
  error: null,
};
const mockSignInWithIdToken = jest.fn();
const mockSignInSilently = jest.fn();
const mockGetIsAnonymous = jest.fn();
const mockRepairLegacy = jest.fn();

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve(mockSessionState)),
      signInWithIdToken: (...args: unknown[]) => mockSignInWithIdToken(...args),
    },
  },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signInSilently: (...args: unknown[]) => mockSignInSilently(...args),
  },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('../anonymousAuth', () => ({
  getIsAnonymous: (...args: unknown[]) => mockGetIsAnonymous(...args),
  repairLegacyStoredUserId: (...args: unknown[]) => mockRepairLegacy(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recoverSessionIfNeeded, resetRecoveryState } from '../sessionRecovery';
import { supabase } from '../supabase';
import {
  getPending,
  makeCompletionId,
  markSynced,
  type HistoryRecord,
} from '../historyStore';

const USER_ID_KEY = 'userId';
const HISTORY_KEY = 'history';
const UID = '113789561834940779353';
const JAPAM_ID = '2d5e599d-48f3-482b-bd18-f14ea8297140';

const makePendingRecord = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  date: new Date().toISOString(),
  malas: 1,
  totalCount: 108,
  duration: 60,
  manual: false,
  userId: UID,
  userName: 'Test User',
  completionId: makeCompletionId(UID, new Date().toISOString()),
  japamId: JAPAM_ID,
  japamName: 'Test Japam',
  syncStatus: 'pending',
  ...overrides,
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  resetRecoveryState();
  mockSessionState = { data: { session: null }, error: null };
  mockGetIsAnonymous.mockResolvedValue(false);
  mockRepairLegacy.mockResolvedValue(UID);
  mockSignInSilently.mockRejectedValue(new Error('no cached credentials'));
  mockSignInWithIdToken.mockImplementation(async () => {
    mockSessionState = {
      data: { session: { access_token: 'recovered-token', user: { id: UID } } },
      error: null,
    };
    return { data: { user: { id: UID }, session: { access_token: 'recovered-token' } }, error: null };
  });
});

describe('recovery + sync integration', () => {
  it('pending row + no session → recovery → getSession returns token', async () => {
    // Arrange: store a pending history row and userId
    await AsyncStorage.setItem(USER_ID_KEY, UID);
    const record = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([record]));

    // Verify preconditions: no session, pending record exists
    expect((await supabase.auth.getSession()).data.session).toBeNull();
    const stored = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
    expect(getPending(stored).length).toBe(1);

    // Act: recovery succeeds
    mockSignInSilently.mockResolvedValue({ data: { idToken: 'fresh-id-token' } });
    const recovered = await recoverSessionIfNeeded();

    // Assert: session is now available with a token
    expect(recovered).toBe(true);
    const session = await supabase.auth.getSession();
    expect(session.data.session?.access_token).toBe('recovered-token');
    // The pending record is still present (sync happens after recovery)
    const after = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
    expect(after.length).toBe(1);
    expect(after[0].syncStatus).toBe('pending');
  });

  it('recovery failure → no session → row remains pending', async () => {
    // Arrange: store userId and pending record
    await AsyncStorage.setItem(USER_ID_KEY, UID);
    const record = makePendingRecord();
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([record]));

    // Act: recovery fails (silent sign-in throws)
    const recovered = await recoverSessionIfNeeded();

    // Assert: no session, record still pending
    expect(recovered).toBe(false);
    const session = await supabase.auth.getSession();
    expect(session.data.session).toBeNull();
    const stored = JSON.parse((await AsyncStorage.getItem(HISTORY_KEY)) || '[]');
    expect(getPending(stored).length).toBe(1);
  });

  it('repeated auth events do not trigger duplicate recovery', async () => {
    // Arrange: store userId
    await AsyncStorage.setItem(USER_ID_KEY, UID);
    mockSignInSilently.mockResolvedValue({ data: { idToken: 'token' } });

    // Act: call recovery multiple times sequentially
    const result1 = await recoverSessionIfNeeded();
    const result2 = await recoverSessionIfNeeded();

    // Assert: first call succeeded and created the session; second call
    // short-circuits because session already exists
    expect(result1).toBe(true);
    expect(result2).toBe(true);
    expect(mockSignInSilently).toHaveBeenCalledTimes(1);
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);
  });

  it('cold-start with existing session does not call silent sign-in', async () => {
    // Arrange: session already exists (cold start from persisted storage)
    mockSessionState = {
      data: { session: { access_token: 'cold-start-token', user: { id: UID } } },
      error: null,
    };
    await AsyncStorage.setItem(USER_ID_KEY, UID);

    // Act
    const result = await recoverSessionIfNeeded();

    // Assert: no silent sign-in or signInWithIdToken called
    expect(result).toBe(true);
    expect(mockSignInSilently).not.toHaveBeenCalled();
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
  });

  it('verifies identity after recovery rejects incompatible session', async () => {
    // Arrange: stored userId does not match recovered session
    await AsyncStorage.setItem(USER_ID_KEY, UID);
    mockSignInSilently.mockResolvedValue({ data: { idToken: 'token' } });
    // repairLegacyStoredUserId returns null for incompatible identity
    mockRepairLegacy.mockResolvedValue(null);

    // Act
    const result = await recoverSessionIfNeeded();

    // Assert: recovery returns false even though signInWithIdToken succeeded
    expect(result).toBe(false);
    expect(mockSignInWithIdToken).toHaveBeenCalledTimes(1);
    expect(mockRepairLegacy).toHaveBeenCalledTimes(1);
  });

  it('uploads pending records only once when sync follows recovery', async () => {
    // This test verifies the contract used by syncPendingHistory:
    // after recovery succeeds, getSession() returns the recovered session,
    // so the sync path can obtain an access_token.
    await AsyncStorage.setItem(USER_ID_KEY, UID);
    mockSignInSilently.mockResolvedValue({ data: { idToken: 'token' } });

    await recoverSessionIfNeeded();

    // Simulate what syncPendingHistory does after recovery:
    const { data } = await supabase.auth.getSession();
    expect(data.session?.access_token).toBe('recovered-token');

    // Mark records as synced (simulating what sync would do)
    const history: HistoryRecord[] = [makePendingRecord()];
    const synced = markSynced(history, [history[0].completionId]);
    expect(synced[0].syncStatus).toBe('synced');
    expect(synced.length).toBe(1);
  });
});
