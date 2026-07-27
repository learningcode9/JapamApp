import { supabase } from './supabase';

/**
 * Shared helper for authenticated japam_history REST GET queries.
 *
 * Every raw `fetch()` to japam_history in the app duplicates the same header-construction
 * pattern (apikey + Authorization). A single helper means:
 *  - the apikey header is always present (no file ever constructs it incorrectly)
 *  - the session guard is centralized (caller never needs to call supabase.auth.getSession())
 *  - the response shape is consistent (null on failure, rows on success)
 *
 * Callers retain full control over column selection, filtering, ordering, and limit.
 * POST/PATCH/DELETE paths (which also include custom body, Prefer header, etc.) are
 * intentionally NOT routed through this helper — they continue using raw fetch() with
 * explicit headers specific to each write operation.
 */
export async function fetchJapamHistoryRows(options: {
  select: string;
  userId: string;
  order?: { column: string; ascending: boolean };
  limit?: number;
  sessionRequired?: boolean;
}): Promise<Record<string, unknown>[] | null> {
  const { select, userId, order, limit, sessionRequired = true } = options;

  if (sessionRequired) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
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
    return null;
  }

  return data as unknown as Record<string, unknown>[];
}
