import {
  type DisplayNameSource,
  type DisplayProfileUpdateOutcome,
  resetMyDisplayProfileToProvider as resetProfileRepositoryToProvider,
  upsertMyDisplayProfile,
} from './displayProfileRepository';

export const MAX_DISPLAY_NAME_LENGTH = 80;

export type SaveDisplayProfileInput = {
  displayName: string;
  nameSource: DisplayNameSource;
};

/**
 * The sole application service permitted to mutate the canonical current display
 * profile. Phase 1 intentionally has no screen callers; integration follows in a
 * later phase after the database foundation has been validated.
 */
export async function saveMyDisplayProfile(
  input: SaveDisplayProfileInput
): Promise<DisplayProfileUpdateOutcome> {
  const displayName = input.displayName.trim();
  if (!displayName) {
    return { kind: 'error', message: 'Display name must not be empty.' };
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      kind: 'error',
      message: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
    };
  }
  if (input.nameSource !== 'provider' && input.nameSource !== 'manual') {
    return { kind: 'error', message: 'Display name source must be provider or manual.' };
  }

  return upsertMyDisplayProfile(displayName, input.nameSource);
}

/** A deliberate user action to resume provider-controlled naming. */
export async function resetMyDisplayProfileToProvider(
  providerDisplayName: string
): Promise<DisplayProfileUpdateOutcome> {
  const displayName = providerDisplayName.trim();
  if (!displayName) {
    return { kind: 'error', message: 'Display name must not be empty.' };
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      kind: 'error',
      message: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
    };
  }

  return resetProfileRepositoryToProvider(displayName);
}
