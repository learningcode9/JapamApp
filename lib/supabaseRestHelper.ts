import { supabase } from './supabase';

/**
 * Single-flight + coalesced GET helper for japam_history. Multiple rapid calls within the
 * cooldown window (5 s) share one in-flight promise, and a completed fetch is reused for the
 * remainder of the window. This prevents the event cascade from launching a new Supabase
 * request on every japam-stats-updated / japam-history-updated emission.
 */
const COALESCE_WINDOW_MS = 5_000;
let lastFetchKey = '';
let lastFetchResolvedAt = 0;
let lastFetchResult: Record<string, unknown>[] | null = null;
let inFlightPromise: Promise<Record<string, unknown>[] | null> | null = null;

/** Reset the coalesce cache — exposed for tests only. */
export function resetFetchCoalesceCache() {
  lastFetchKey = '';
  lastFetchResolvedAt = 0;
  lastFetchResult = null;
  inFlightPromise = null;
}

export async function fetchJapamHistoryRows(options: {
  select: string;
  userId: string;
  order?: { column: string; ascending: boolean };
  limit?: number;
  sessionRequired?: boolean;
}): Promise<Record<string, unknown>[] | null> {
  const { select, userId, order, limit, sessionRequired = true } = options;

  const fetchKey = `${select}|${userId}|${order?.column ?? ''}|${order?.ascending ?? ''}|${limit ?? ''}`;
  const now = Date.now();

  if (fetchKey === lastFetchKey && now - lastFetchResolvedAt < COALESCE_WINDOW_MS) {
    return lastFetchResult;
  }
  if (fetchKey === lastFetchKey && inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = (async () => {
    if (sessionRequired) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        inFlightPromise = null;
        return null;
      }
    }

    let query = supabase
      .from('japam_history')
      .select(select)
      .eq('user_id', userId);

    if (order) {
      query = query.order(order.column, { ascending: order.ascending });
    }
    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error || !data) {
      if (error) {
        console.log(
          '[SUPABASE_REST_FAILED] code=%s message=%s',
          (error as { code?: string }).code ?? 'unknown',
          error.message,
        );
      }
      inFlightPromise = null;
      return null;
    }

    const result = data as unknown as Record<string, unknown>[];
    lastFetchKey = fetchKey;
    lastFetchResult = result;
    lastFetchResolvedAt = Date.now();
    inFlightPromise = null;
    return result;
  })();

  return inFlightPromise;
}
