/**
 * Pure planning logic for the one-time legacy history backfill (assigning existing null-japamId
 * history to the one default Japam an identity's pre-Japam-Workspaces history should belong to).
 * No AsyncStorage, no Supabase, no Context -- purely a function of its inputs. The caller (a
 * future orchestration layer) is responsible for: scoping `records` to one identity, deciding the
 * suggested japamId/japamName (e.g. creating a Japam via the existing repository and reading
 * user_profiles.japam_name for a suggested name), persisting updatedRecords, and marking a
 * per-identity "already backfilled" flag so this never runs a second time for the same identity.
 *
 * Never touches a record that already has ANY japamId, whatever value it happens to be -- existing
 * Japams are never guessed at or merged into. Only records with japamId == null/undefined (the
 * legacy/unassigned bucket, same convention as statsByJapam/filterByJapam/planHistoryDayAdjustment)
 * are reassigned to the one given (japamId, japamName).
 *
 * Idempotent: once every record in the input already has a japamId, a second call over that same
 * (already-updated) record set reports needsBackfill: false and returns the records completely
 * unchanged -- there is no separate "already ran" state to track at this layer, the record set
 * itself is the source of truth for whether there's anything left to do.
 */
import {
  dedupeByCompletionId,
  type HistoryRecord,
  type RawHistoryRecord,
} from './historyStore';

export type LegacyHistoryBackfillPlan = {
  /** True only if at least one record needed reassigning. */
  needsBackfill: boolean;
  /** The full record set, deduped, with any needed reassignments applied. Persist this as-is. */
  updatedRecords: HistoryRecord[];
  /** Just the records that were actually reassigned -- the delta, e.g. for syncing/logging. */
  reassignedRecords: HistoryRecord[];
};

export const planLegacyHistoryBackfill = (
  records: RawHistoryRecord[],
  japamId: string,
  japamName: string
): LegacyHistoryBackfillPlan => {
  const normalized = dedupeByCompletionId(records);
  const reassignedRecords: HistoryRecord[] = [];

  const updatedRecords = normalized.map((record) => {
    if (record.japamId != null) return record;

    const reassigned: HistoryRecord = {
      ...record,
      japamId,
      japamName,
      // Signed-in records need to sync this reassignment; guest records have nothing to sync to,
      // so their syncStatus is left exactly as it was -- same convention as
      // planHistoryDayAdjustment's own pendingStatusFor helper.
      syncStatus: record.userId ? 'pending' : record.syncStatus,
    };
    reassignedRecords.push(reassigned);
    return reassigned;
  });

  return {
    needsBackfill: reassignedRecords.length > 0,
    updatedRecords,
    reassignedRecords,
  };
};
