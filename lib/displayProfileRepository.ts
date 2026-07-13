import { supabase } from './supabase';

export type DisplayNameSource = 'provider' | 'manual';

export interface DisplayProfile {
  userId: string;
  displayName: string;
  nameSource: DisplayNameSource;
  updatedAt: string;
}

export type DisplayProfileUpdateOutcome =
  | { kind: 'updated'; profile: DisplayProfile }
  | { kind: 'error'; message: string };

/**
 * Low-level access to the canonical display-profile RPC.
 *
 * This repository intentionally has no user-id parameter. The database derives the
 * target identity from auth.uid(), and application code should call it only through
 * displayProfileService.
 */
export async function upsertMyDisplayProfile(
  displayName: string,
  nameSource: DisplayNameSource
): Promise<DisplayProfileUpdateOutcome> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session?.user?.id) {
    return { kind: 'error', message: 'Please sign in before updating your display name.' };
  }

  const { data, error } = await supabase.rpc('upsert_my_display_profile', {
    p_display_name: displayName,
    p_name_source: nameSource,
  });
  if (error) return { kind: 'error', message: error.message };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { kind: 'error', message: 'Could not update your display name.' };
  }

  return {
    kind: 'updated',
    profile: {
      userId: row.user_id,
      displayName: row.display_name,
      nameSource: row.name_source,
      updatedAt: row.updated_at,
    },
  };
}

/**
 * Explicitly gives provider ownership back to the current user. It is separate
 * from a routine provider refresh so automatic provider input can never replace
 * a manual choice.
 */
export async function resetMyDisplayProfileToProvider(
  displayName: string
): Promise<DisplayProfileUpdateOutcome> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session?.user?.id) {
    return { kind: 'error', message: 'Please sign in before updating your display name.' };
  }

  const { data, error } = await supabase.rpc('reset_my_display_profile_to_provider', {
    p_display_name: displayName,
  });
  if (error) return { kind: 'error', message: error.message };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { kind: 'error', message: 'Could not update your display name.' };
  }

  return {
    kind: 'updated',
    profile: {
      userId: row.user_id,
      displayName: row.display_name,
      nameSource: row.name_source,
      updatedAt: row.updated_at,
    },
  };
}
