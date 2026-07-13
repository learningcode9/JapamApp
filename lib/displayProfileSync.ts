import {
  saveMyDisplayProfile,
  type SaveDisplayProfileInput,
} from './displayProfileService';

export type DisplayProfileSession = {
  user: {
    id: string;
    user_metadata?: Record<string, unknown> | null;
  };
} | null;

type SyncEvent = 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED' | 'RETRY';

type DisplayProfileSyncOptions = {
  retryDelayMs?: number;
  maxRetries?: number;
  log?: (message: string) => void;
  saveProfile?: (input: SaveDisplayProfileInput) => ReturnType<typeof saveMyDisplayProfile>;
};

const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;

const providerDisplayName = (session: DisplayProfileSession): string | null => {
  const metadata = session?.user.user_metadata;
  if (!metadata) return null;

  if (typeof metadata.given_name === 'string') {
    const givenName = metadata.given_name.trim();
    if (givenName) return givenName;
  }

  // Provider full names are input only. For automatic display names, use the
  // first nonblank word from `name`; manually selected display names never pass
  // through this normalization path.
  if (typeof metadata.name !== 'string') return null;
  const providerName = metadata.name.trim();
  if (!providerName) return null;

  return providerName.split(/\s+/)[0] || null;
};

/**
 * In-memory coordinator for the single root-level profile synchronization path.
 * It intentionally has no AsyncStorage access and no screen dependencies: the
 * canonical profile is server authority and compatibility caches stay untouched.
 */
export class DisplayProfileSyncController {
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly log: (message: string) => void;
  private readonly saveProfile: (input: SaveDisplayProfileInput) => ReturnType<typeof saveMyDisplayProfile>;
  private currentUserId: string | null = null;
  private manualProfileUserId: string | null = null;
  private generation = 0;
  private lastSuccessfulSignature: string | null = null;
  private failedSignature: string | null = null;
  private activeSignature: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;

  constructor(options: DisplayProfileSyncOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.log = options.log ?? console.log;
    this.saveProfile = options.saveProfile ?? saveMyDisplayProfile;
  }

  async sync(session: DisplayProfileSession, event: SyncEvent, force = false): Promise<void> {
    const userId = session?.user.id;
    if (!userId) {
      this.reset();
      return;
    }

    const displayName = providerDisplayName(session);
    if (!displayName) {
      this.writeLog(event, 'skipped', 'no_provider_name');
      return;
    }

    if (this.currentUserId && this.currentUserId !== userId) {
      this.resetForNewSession();
    }
    this.currentUserId = userId;

    if (this.manualProfileUserId === userId && !force) {
      this.writeLog(event, 'skipped', 'manual_profile');
      return;
    }

    const signature = `${userId}\u0000${displayName}`;
    if (this.lastSuccessfulSignature === signature || this.activeSignature === signature) return;
    if (this.retryTimer && this.failedSignature === signature) return;
    if (this.failedSignature === signature && !force) return;

    this.activeSignature = signature;
    const generation = this.generation;
    try {
      const outcome = await this.saveProfile({ displayName, nameSource: 'provider' });
      if (generation !== this.generation || this.currentUserId !== userId) return;
      if (outcome.kind === 'updated') {
        this.manualProfileUserId = outcome.profile.nameSource === 'manual' ? userId : null;
        this.lastSuccessfulSignature = signature;
        this.failedSignature = null;
        this.retryAttempts = 0;
        this.clearRetry();
        this.writeLog(event, 'synced');
        return;
      }

      this.failedSignature = signature;
      this.writeLog(event, 'failed', 'rpc');
      this.scheduleRetry(session, signature, generation);
    } catch {
      if (generation !== this.generation || this.currentUserId !== userId) return;
      this.failedSignature = signature;
      this.writeLog(event, 'failed', 'network');
      this.scheduleRetry(session, signature, generation);
    } finally {
      if (this.activeSignature === signature) this.activeSignature = null;
    }
  }

  reset(): void {
    this.generation += 1;
    this.clearRetry();
    this.currentUserId = null;
    this.manualProfileUserId = null;
    this.lastSuccessfulSignature = null;
    this.failedSignature = null;
    this.activeSignature = null;
    this.retryAttempts = 0;
  }

  private resetForNewSession(): void {
    this.generation += 1;
    this.clearRetry();
    this.lastSuccessfulSignature = null;
    this.failedSignature = null;
    this.manualProfileUserId = null;
    this.activeSignature = null;
    this.retryAttempts = 0;
  }

  dispose(): void {
    this.reset();
  }

  reportSessionError(): void {
    this.writeLog('INITIAL_SESSION', 'failed', 'session');
  }

  private scheduleRetry(session: DisplayProfileSession, signature: string, generation: number): void {
    if (this.retryAttempts >= this.maxRetries) {
      this.writeLog('RETRY', 'skipped', 'retry_limit');
      return;
    }

    this.retryAttempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation !== this.generation || this.failedSignature !== signature) return;
      void this.sync(session, 'RETRY', true);
    }, this.retryDelayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private writeLog(event: SyncEvent, status: 'synced' | 'failed' | 'skipped', reason?: string): void {
    // Never add a UUID, token, email, or display name to these lifecycle logs.
    this.log(`[PROFILE_SYNC] event=${event} status=${status}${reason ? ` reason=${reason}` : ''}`);
  }
}

/**
 * Keeps auth-event ordering explicit and testable. The root runner is its only
 * owner; this is not a general background-job framework.
 */
export class DisplayProfileSyncLifecycle {
  private receivedAuthEvent = false;

  constructor(private readonly controller: DisplayProfileSyncController) {}

  handleInitialSession(session: DisplayProfileSession, hasError = false): Promise<void> {
    if (hasError) {
      this.controller.reportSessionError();
      return Promise.resolve();
    }
    // Supabase can emit INITIAL_SESSION while getSession() is in flight. Once an
    // auth event has arrived, its session is newer and the stale read is ignored.
    if (this.receivedAuthEvent) return Promise.resolve();
    return this.controller.sync(session, 'INITIAL_SESSION');
  }

  handleAuthEvent(event: string, session: DisplayProfileSession): Promise<void> {
    this.receivedAuthEvent = true;
    if (event === 'SIGNED_OUT') {
      this.controller.reset();
      return Promise.resolve();
    }

    return this.controller.sync(
      session,
      event as SyncEvent,
      event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED'
    );
  }

  dispose(): void {
    this.controller.dispose();
  }
}
