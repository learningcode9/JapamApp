import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  appendCompletion,
  buildSupabaseHistoryPayload,
  dedupeByCompletionId,
  mapSupabaseHistoryRow,
  markSynced,
  mergeHistories,
  mergeTombstones,
  normalizeAll,
  planHistoryDayAdjustment,
  reconcileWithServer,
  toLocalDayKey,
  type HistoryRecord,
} from '../../lib/historyStore';
import * as historyRepository from '../../lib/historyRepository';
import * as japamsRepository from '../../lib/japamsRepository';
import { useCurrentJapam } from '../../contexts/current-japam-context';
import CurrentJapamHeaderButton from '../../components/CurrentJapamHeaderButton';
import { repairLegacyStoredUserId, LEGACY_USER_ID_KEY } from '../../lib/anonymousAuth';
import { supabase } from '../../lib/supabase';
import * as FileSystem from 'expo-file-system/legacy';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    DeviceEventEmitter,
    Dimensions,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';

// Same breakpoint convention already used elsewhere in this app (see timer.tsx's
// isMobile/isShortMobile) — width-based, not a device-class guess. isNarrowPhone covers small
// Android phones (~360dp and below); isTablet covers the same >=768dp cutoff timer.tsx already
// uses for "not a phone."
const { width: HISTORY_SCREEN_WIDTH } = Dimensions.get('window');
const isNarrowPhone = HISTORY_SCREEN_WIDTH < 380;
const isTablet = HISTORY_SCREEN_WIDTH >= 768;

// Every header (Date/Malas/Count/Total) and every row value shares the exact same font size
// and weight (TABLE_HEADER_FONT_SIZE / TABLE_VALUE_FONT_SIZE + cellText's fontWeight) — no
// per-column size differences.
// Cell padding is kept tight on phone widths so numeric columns have enough room for both
// the header label and the data value below it. minimumFontScale is a last-resort safety net
// (only for genuinely long values, e.g. a 6-digit running Total) so numeric text is never
// forced tiny in the common case; on web text wrapping/overflow is prevented by column widths.
const TABLE_HEADER_FONT_SIZE = isTablet ? 20 : isNarrowPhone ? 15 : 17;
const TABLE_VALUE_FONT_SIZE = isTablet ? 19 : isNarrowPhone ? 14 : 16;
const IS_ANDROID = Platform.OS === 'android';
const TABLE_CELL_PADDING_H = IS_ANDROID ? 0 : isNarrowPhone ? 1 : isTablet ? 8 : 2;
// Web/iOS keep the existing proportional (flex-ratio) column sizing below — reported as working
// fine. Android gets its own deterministic, fixed-dp column widths instead (see the Android
// block further down): measured-glyph-width math for "Malas" kept under-predicting the real
// truncation point on a real device (this one has a custom system font — Samsung's
// FlipFont — that renders wider than the standard font used to estimate these), so rather than
// keep guessing a precise number, Android gives Malas a deliberately large fixed allowance.
const DATE_CELL_FLEX = isNarrowPhone ? 1.4 : isTablet ? 1.8 : 1.6;
const MALAS_CELL_FLEX = isNarrowPhone ? 0.85 : isTablet ? 1.05 : 1.0;
const COUNT_CELL_FLEX = isNarrowPhone ? 0.95 : isTablet ? 1.15 : 1.05;
const TOTAL_CELL_FLEX = isNarrowPhone ? 0.9 : isTablet ? 1.1 : 1.0;
const DATE_MIN_WIDTH = isNarrowPhone ? 84 : isTablet ? 156 : 98;
// Android-only fixed widths (dp). Date is sized just for "30 Jun 2026" (tight, not huge, per
// request). Malas gets the single largest numeric-column allowance — deliberately more than
// Count/Total — because it's the one that's repeatedly truncated in practice.
const ANDROID_DATE_WIDTH = isNarrowPhone ? 78 : isTablet ? 130 : 92;
const ANDROID_MALAS_WIDTH = isNarrowPhone ? 72 : isTablet ? 100 : 85;
const ANDROID_COUNT_WIDTH = isNarrowPhone ? 50 : isTablet ? 70 : 58;
const ANDROID_TOTAL_WIDTH = isNarrowPhone ? 48 : isTablet ? 68 : 56;
// Edit + Delete both stay visible on every platform. Android's buttons are a bit more compact
// (still a safe tap size) with a trimmed gap, to help free room for the header columns above.
const ROW_ACTION_BUTTON_SIZE = IS_ANDROID
  ? (isNarrowPhone ? 36 : isTablet ? 44 : 40)
  : (isNarrowPhone ? 40 : 44);
const ROW_ACTIONS_GAP = IS_ANDROID ? 2 : (isNarrowPhone ? 4 : 8);
const ACTIONS_COLUMN_WIDTH = ROW_ACTION_BUTTON_SIZE * 2 + ROW_ACTIONS_GAP;

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string | null;
  userName?: string;
  userEmail?: string;
  remoteId?: string | number;
  completionId?: string;
  syncStatus?: 'pending' | 'synced';
  japamId?: string | null;
  japamName?: string | null;
};

type DailyRow = {
  dateKey: string;
  dateLabel: string;
  malas: number;
  totalCount: number;
  accumulated: number;
  duration: number;
  manualCount: number;
  autoCount: number;
  completionIds: string[];
};

type RemoteHistoryRow = {
  id?: number | string;
  created_at?: string;
  malas?: number | string;
  count?: number | string;
  user_name?: string;
  user_email?: string;
  japam_id?: string | null;
  japam_name?: string | null;
  completion_id?: string;
};

type ManualSyncInput = {
  userId: string;
  userName: string;
  malas: number;
  totalCount: number;
  createdAt: string;
  completionId: string;
  japamId: string | null;
  japamName: string | null;
};

type AddDateMode = 'today' | 'yesterday' | 'custom';
type AddEntryMode = 'malas' | 'count';

const MALAS_TO_COUNT = 108;

// Pure validation for Total Count entry mode. Count must be a positive multiple of 108; if not,
// returns the friendly "add N more counts" message instead of allowing save.
function validateCountEntry(countText: string): { valid: boolean; malas?: number; message?: string } {
  const parsed = parseInt(countText, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { valid: false };
  }
  if (parsed % MALAS_TO_COUNT === 0) {
    return { valid: true, malas: parsed / MALAS_TO_COUNT };
  }
  const nextMultiple = Math.ceil(parsed / MALAS_TO_COUNT) * MALAS_TO_COUNT;
  const shortfall = nextMultiple - parsed;
  const malas = nextMultiple / MALAS_TO_COUNT;
  return {
    valid: false,
    message: `Add ${shortfall} more counts to make ${malas} malas (${nextMultiple} total).`,
  };
}

const HISTORY_KEY = 'history';
const DELETED_COMPLETIONS_KEY = 'deletedCompletions';
const USER_ID_KEY = 'userId';
const USER_NAME_KEY = 'userName';
const USER_EMAIL_KEY = 'userEmail';

const getStoredUserMeta = async () => {
  const [storedName, storedEmail] = await Promise.all([
    AsyncStorage.getItem(USER_NAME_KEY),
    AsyncStorage.getItem(USER_EMAIL_KEY),
  ]);
  const userName = (storedName || storedEmail || 'Unknown User').trim() || 'Unknown User';
  return { userName, userEmail: storedEmail || undefined };
};

const backfillMissingUserNames = async (userId: string, userName: string) => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || !userId || !userName) return;

  // Require a real session JWT. Without one the request would run as `anon` role, which has
  // no UPDATE policy — guaranteed 403 (mirrors syncHistoryEditsToSupabase below).
  const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
  if (!sessionToken) return;

  try {
    const query = new URLSearchParams({ user_id: `eq.${userId}` });
    query.append('or', '(user_name.is.null,user_name.eq."")');
    const response = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${sessionToken}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_name: userName }),
    });

    if (!response.ok) {
      console.log('Supabase user_name backfill error:', await response.text());
    }
  } catch (error) {
    console.log('Supabase user_name backfill error:', error);
  }
};

const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}-${m}-${d}`;
};

const toDayKey = (rawDate: string) => {
  return toLocalDayKey(rawDate);
};

const SHORT_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Built manually (not toLocaleDateString) so the format is exact and deterministic across
// locales/platforms: "19 Jun 2026" — day-month-year, no comma, narrower than the previous
// "Jun 19, 2026" at the same font size, which combined with the larger header font size below
// is what keeps the Date column from wrapping or forcing the table to scroll horizontally.
// Narrow phones drop the year ("19 Jun") — there's truly no room left for it once the header
// font is large enough to be readable.
const toDayLabel = (dayKey: string) => {
  if (dayKey === 'unknown') return 'Unknown Date';

  const [year, month, day] = dayKey.split('-').map(Number);
  const monthName = SHORT_MONTH_NAMES[month - 1];

  // The year must always be visible, on every row, on every screen size — no narrow-phone
  // shorthand that drops it.
  return `${day} ${monthName} ${year}`;
};

const toEditDateLabel = (dayKey: string) => {
  if (dayKey === getLocalDateKey()) return 'Today';
  const [year, month, day] = dayKey.split('-').map(Number);
  return `${SHORT_MONTH_NAMES[month - 1]} ${day}, ${year}`;
};

const parseHistory = (raw: string | null): Session[] => {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Dedup by stable completionId only (no time-window collapse). Distinct malas are never merged;
// only invalid/zero-count rows are dropped. See lib/historyStore.ts.
const dedupeSessions = (sessions: Session[]): Session[] =>
  dedupeByCompletionId(sessions).filter(
    (item) => item.totalCount > 0 && toDayKey(item.date) !== 'unknown'
  );

const buildDailyRows = (sessions: Session[]) => {
  const grouped = new Map<string, DailyRow>();

  dedupeSessions(sessions).forEach((item) => {
    const dayKey = toDayKey(item.date);
    const existing = grouped.get(dayKey);

    const itemMalas = Number(item.malas) || 0;
    const itemTotalCount = Number(item.totalCount) || itemMalas * 108;
    const malas = itemMalas || Math.floor(itemTotalCount / 108);
    const totalCount = itemTotalCount;
    const duration = Number(item.duration) || 0;
    const isManual = !!item.manual;

    if (existing) {
      existing.malas += malas;
      existing.totalCount += totalCount;
      existing.duration += duration;
      if (item.completionId) existing.completionIds.push(item.completionId);

      if (isManual) existing.manualCount += 1;
      else existing.autoCount += 1;
      return;
    }

    grouped.set(dayKey, {
      dateKey: dayKey,
      dateLabel: toDayLabel(dayKey),
      malas,
      totalCount,
      accumulated: 0,
      duration,
      manualCount: isManual ? 1 : 0,
      autoCount: isManual ? 0 : 1,
      completionIds: item.completionId ? [item.completionId] : [],
    });
  });

  console.log('[HistoryDate] deviceLocalTime=%s todayKey=%s rows=%o',
    new Date().toString(),
    getLocalDateKey(),
    [...grouped.values()].map((row) => ({
      dateKey: row.dateKey,
      displayLabel: row.dateLabel,
      totalCount: row.totalCount,
    }))
  );

  const oldestFirstRows = [...grouped.values()].sort((a, b) => {
    if (a.dateKey === 'unknown') return 1;
    if (b.dateKey === 'unknown') return -1;
    return a.dateKey.localeCompare(b.dateKey);
  });

  let runningTotal = 0;
  const rowsWithAccumulated = oldestFirstRows.map((row) => {
    runningTotal += row.totalCount;
    return { ...row, accumulated: runningTotal };
  });

  return rowsWithAccumulated.reverse();
};

// TEMPORARY BRIDGE — the legacyUserId parameter and the second fetchBy call below exist only to
// bridge users whose old numeric-Google-ID rows haven't been migrated to their Supabase UUID yet.
// Remove legacyUserId support here (and its call site in loadHistory) once
// db/migrate_numeric_user_ids_to_uuid.sql has been run and its post-verification query confirms
// zero mappable numeric-id rows remain.
const fetchRemoteSessions = async (userId: string, legacyUserId?: string | null): Promise<Session[] | null> => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || !userId) return null;

  // Require a real session JWT — an anon-key request has no SELECT policy for this user's rows
  // once RLS is tightened (mirrors syncPendingHistory's session-token preference). No session
  // returns null here, same as any other fetch failure below (caller keeps local history as-is).
  const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
  if (!sessionToken) return null;

  try {
    // taggedUserId lets a legacy-id query's rows be tagged as belonging to the canonical UUID, so
    // they merge/display/reconcile identically to rows fetched by the UUID itself.
    const fetchBy = async (field: 'user_id' | 'user_name', value: string, taggedUserId: string) => {
      const query = new URLSearchParams({
        select: 'id,created_at,malas,count,user_name,user_email,completion_id,japam_id,japam_name',
        [field]: `eq.${value}`,
        order: 'created_at.asc',
        limit: '10000',
      });

      const response = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) {
        console.log('Supabase history fetch error:', await response.text());
        return null;
      }

      const rows: RemoteHistoryRow[] = await response.json();

      return rows.map((row) => mapSupabaseHistoryRow(row, taggedUserId));
    };

    const primary = await fetchBy('user_id', userId, userId);
    if (primary === null) return null;

    if (legacyUserId && legacyUserId !== userId) {
      const legacyRows = await fetchBy('user_id', legacyUserId, userId);
      console.log(
        '[DUAL_FETCH_BRIDGE] canonicalUserId=%s legacyUserId=%s primaryCount=%d legacyCount=%d',
        userId, legacyUserId, primary.length, legacyRows?.length ?? 0
      );
      if (legacyRows && legacyRows.length > 0) return [...primary, ...legacyRows];
    }

    return primary;
  } catch (error) {
    console.log('Supabase history fetch error:', error);
    return null;
  }
};

const saveToSupabase = async (
  userId: string,
  userName: string,
  malas: number,
  totalCount: number,
  createdAt: string,
  completionId: string,
  japamId: string | null,
  japamName: string | null,
): Promise<boolean> => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return false;

  // Require a real session JWT — an anon-key request has no INSERT policy for this user's own
  // rows once RLS is tightened. Fail closed (stays 'pending' for retry) rather than falling back
  // to the anon key.
  const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
  if (!accessToken) return false;

  if (japamId && !(await japamsRepository.ensureRemoteJapamExists(userId, japamId))) {
    console.log('[SYNC_FAILED] source=history-manual completionId=%s reason=missing-remote-japam', completionId);
    return false;
  }

  try {
    const body = buildSupabaseHistoryPayload({
      date: createdAt,
      malas,
      totalCount,
      duration: 0,
      manual: true,
      userId,
      userName,
      completionId,
      syncStatus: 'pending',
      japamId,
      japamName,
    }, userId, userName);
    console.log(
      '[SYNC_PAYLOAD_CREATED_AT] source=history-manual completionId=%s created_at=%s localDay=%s',
      body.completion_id,
      body.created_at,
      toDayKey(body.created_at)
    );
    const res = await fetch(`${url}/rest/v1/japam_history?on_conflict=completion_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) console.log('[SYNC_SUCCESS] source=history-manual completionId=%s', completionId);
    else console.log('[SYNC_FAILED] source=history-manual completionId=%s status=%d', completionId, res.status);
    return res.ok;
  } catch (err) {
    console.log('[SYNC_FAILED] source=history-manual completionId=%s reason=network', completionId);
    console.log('Supabase manual entry save error:', err);
    return false;
  }
};

const syncManualEntryToSupabase = async ({
  userId,
  userName,
  malas,
  totalCount,
  createdAt,
  completionId,
  japamId,
  japamName,
}: ManualSyncInput) => {
  try {
    const supabaseOk = await saveToSupabase(
      userId,
      userName,
      malas,
      totalCount,
      createdAt,
      completionId,
      japamId,
      japamName
    );

    if (!supabaseOk) return false;

    await backfillMissingUserNames(userId, userName);
    const latestRaw = await AsyncStorage.getItem(HISTORY_KEY);
    const latest = parseHistory(latestRaw);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(markSynced(latest, [completionId])));
    console.log('[MARK_SYNCED] source=history-manual completionId=%s', completionId);
    return true;
  } catch (error) {
    console.log('Supabase manual entry background sync error:', error);
    return false;
  }
};

const syncHistoryEditsToSupabase = async (
  records: HistoryRecord[],
  userId: string,
  fallbackUserName: string,
): Promise<{ syncedIds: string[]; rlsBlocked: boolean; inconclusive: boolean }> => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || records.length === 0) return { syncedIds: [], rlsBlocked: false, inconclusive: false };

  // Require a real session JWT. Without one the request would run as `anon` role, which has
  // no UPDATE policy — guaranteed 403. Leave records as `pending` for retry on next sign-in.
  const sessionToken = (await supabase.auth.getSession()).data.session?.access_token;
  if (!sessionToken) return { syncedIds: [], rlsBlocked: false, inconclusive: false };
  const accessToken = sessionToken;
  const syncedIds: string[] = [];
  let rlsBlocked = false;
  let inconclusive = false;
  const runVerify = async (token: string, remoteId: string | number | null | undefined, completionId: string) => {
    const verifyUrl = remoteId != null
      ? `${url}/rest/v1/japam_history?id=eq.${encodeURIComponent(String(remoteId))}&select=id,completion_id,malas,count,created_at,user_id,user_name,japam_id,japam_name`
      : `${url}/rest/v1/japam_history?completion_id=eq.${encodeURIComponent(completionId)}&select=id,completion_id,malas,count,created_at,user_id,user_name,japam_id,japam_name`;
    return fetch(verifyUrl, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  };
  const ensuredJapams = new Map<string, boolean>();
  for (const record of records) {
    const japamId = record.japamId ?? null;
    if (japamId) {
      const ensured = ensuredJapams.get(japamId)
        ?? await japamsRepository.ensureRemoteJapamExists(userId, japamId);
      ensuredJapams.set(japamId, ensured);
      if (!ensured) {
        console.log('[HISTORY_EDIT_SYNC_FAILED] completionId=%s reason=missing-remote-japam japamId=%s', record.completionId, japamId);
        continue;
      }
    }
    const payload = buildSupabaseHistoryPayload(record, userId, fallbackUserName);
    try {
      const remoteId = record.remoteId;
      const requestUrl = remoteId != null
        ? `${url}/rest/v1/japam_history?id=eq.${encodeURIComponent(String(remoteId))}`
        : `${url}/rest/v1/japam_history?on_conflict=completion_id`;
      const requestMethod = remoteId != null ? 'PATCH' : 'POST';
      const requestBody = remoteId != null
        ? {
            malas: payload.malas,
            count: payload.count,
            user_name: payload.user_name,
            created_at: payload.created_at,
            completion_id: payload.completion_id,
            japam_id: payload.japam_id,
            japam_name: payload.japam_name,
          }
        : payload;
      console.log(
        '[HISTORY_EDIT_REQUEST] method=%s remoteId=%s completionId=%s url=%s body=%s',
        requestMethod,
        remoteId != null ? String(remoteId) : 'none',
        record.completionId,
        requestUrl,
        JSON.stringify(requestBody),
      );
      const response = remoteId != null
        ? await fetch(requestUrl, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              apikey: key,
              Authorization: `Bearer ${accessToken}`,
              Prefer: 'return=representation',
            },
            body: JSON.stringify(requestBody),
          })
        : await fetch(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: key,
              Authorization: `Bearer ${accessToken}`,
              Prefer: 'return=representation,resolution=merge-duplicates',
            },
            body: JSON.stringify(requestBody),
          });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) rlsBlocked = true;
        console.log(
          '[HISTORY_EDIT_SYNC_FAILED] completionId=%s status=%d',
          record.completionId,
          response.status
        );
        continue;
      }

      // The write itself succeeded (2xx). Trust the returned row (Prefer: return=representation)
      // as the primary evidence of success — if it already reflects the values we sent, there's
      // no need for a separate verify GET (whose own failure previously caused a false "not
      // saved" alert even though the write had gone through).
      const writeText = await response.text().catch(() => '');
      let writeRows: Array<{ completion_id?: string; malas?: number | string; count?: number | string }> = [];
      try {
        const parsed = writeText ? JSON.parse(writeText) : [];
        writeRows = Array.isArray(parsed) ? parsed : [];
      } catch { writeRows = []; }
      const writtenRow = writeRows.find((r) => r.completion_id === payload.completion_id) ?? writeRows[0];
      if (
        writtenRow &&
        Number(writtenRow.malas) === payload.malas &&
        Number(writtenRow.count) === payload.count
      ) {
        syncedIds.push(record.completionId);
        console.log(
          '[HISTORY_EDIT_SYNC_SUCCESS] completionId=%s source=write-response malas=%d count=%d',
          record.completionId,
          payload.malas,
          payload.count,
        );
        continue;
      }

      // Write response didn't already confirm it (e.g. RLS blocks SELECT-back on the write, so
      // return=representation comes back empty) — fall back to a separate verify GET, retrying
      // once with a freshly-fetched session token if the first attempt 400s (a stale/near-expiry
      // token failing auth validation, not an RLS permission block).
      let verifyResponse = await runVerify(accessToken, remoteId, payload.completion_id);
      if (verifyResponse.status === 400) {
        const freshToken = (await supabase.auth.getSession()).data.session?.access_token;
        if (freshToken) {
          verifyResponse = await runVerify(freshToken, remoteId, payload.completion_id);
        }
      }
      if (!verifyResponse.ok) {
        if (verifyResponse.status === 401 || verifyResponse.status === 403) {
          rlsBlocked = true;
        } else {
          // The write already returned 2xx — a failed verify-read is inconclusive, not proof
          // the edit didn't save.
          inconclusive = true;
        }
        console.log(
          '[HISTORY_EDIT_SYNC_FAILED] completionId=%s reason=verify-read-failed remoteId=%s status=%d',
          record.completionId,
          remoteId != null ? String(remoteId) : 'none',
          verifyResponse.status,
        );
        continue;
      }
      const verifyText = await verifyResponse.text().catch(() => '');
      let verifyBody: unknown = [];
      try { verifyBody = verifyText ? JSON.parse(verifyText) : []; } catch { verifyBody = []; }
      const verifyRows = Array.isArray(verifyBody) ? verifyBody as Array<{
        id?: number | string;
        completion_id?: string;
        malas?: number | string;
        count?: number | string;
      }> : [];
      if (verifyRows.length === 0) {
        console.log(
          '[HISTORY_EDIT_SYNC_FAILED] completionId=%s reason=verify-zero-rows remoteId=%s',
          record.completionId,
          remoteId != null ? String(remoteId) : 'none',
        );
        inconclusive = true;
        continue;
      }
      const verified = verifyRows[0];
      const verifiedId = verified?.id ?? remoteId;
      const verifiedMalas = Number(verified?.malas) || 0;
      const verifiedCount = Number(verified?.count) || 0;
      if (verifiedMalas !== payload.malas || verifiedCount !== payload.count) {
        console.log(
          '[HISTORY_EDIT_SYNC_FAILED] completionId=%s reason=verify-mismatch remoteId=%s expectedMalas=%d expectedCount=%d dbMalas=%d dbCount=%d',
          record.completionId,
          remoteId != null ? String(remoteId) : 'none',
          payload.malas,
          payload.count,
          verifiedMalas,
          verifiedCount,
        );
        continue;
      }
      syncedIds.push(record.completionId);
      console.log(
        '[HISTORY_EDIT_SYNC_SUCCESS] completionId=%s remoteId=%s malas=%d count=%d',
        record.completionId,
        verifiedId != null ? String(verifiedId) : 'none',
        payload.malas,
        payload.count,
      );
    } catch {
      console.log('[HISTORY_EDIT_SYNC_FAILED] completionId=%s reason=network', record.completionId);
      break;
    }
  }
  return { syncedIds, rlsBlocked, inconclusive };
};

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentJapam, currentJapamId, isLoading: isJapamContextLoading } = useCurrentJapam();
  const tabBarSpaceFromBottom = 74 + Math.max(12, insets.bottom + 8);

  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addDateMode, setAddDateMode] = useState<AddDateMode>('today');
  const [addDate, setAddDate] = useState('');
  const [addMalas, setAddMalas] = useState(1);
  const [addEntryMode, setAddEntryMode] = useState<AddEntryMode>('malas');
  const [addCountText, setAddCountText] = useState('108');
  const [editingRow, setEditingRow] = useState<DailyRow | null>(null);
  const [editMalas, setEditMalas] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const getYesterdayDateKey = () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return getLocalDateKey(yesterday);
  };

  const openAddModal = () => {
    setAddDateMode('today');
    setAddDate(getLocalDateKey());
    setAddMalas(1);
    setAddEntryMode('malas');
    setAddCountText('108');
    setShowAddModal(true);
  };

  const selectAddDateMode = (mode: AddDateMode) => {
    setAddDateMode(mode);
    if (mode === 'today') setAddDate(getLocalDateKey());
    if (mode === 'yesterday') setAddDate(getYesterdayDateKey());
  };

  const openEditModal = (row: DailyRow) => {
    console.log('[EDIT_MODAL_OPEN] dateKey=%s malas=%d', row.dateKey, row.malas);
    setEditingRow(row);
    setEditMalas(row.malas);
  };

  const saveAddJapam = async () => {
    await repairLegacyStoredUserId();
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    // Guests (currentUserId === null) are allowed — records saved locally with syncStatus 'synced'

    if (!addDate || !/^\d{4}-\d{2}-\d{2}$/.test(addDate)) {
      Alert.alert('Invalid date', 'Please enter a valid date in YYYY-MM-DD format.');
      return;
    }

    if (addDate > getLocalDateKey()) {
      Alert.alert('Invalid date', 'Future dates are not allowed. Please select today or a past date.');
      return;
    }

    let finalMalas: number;
    let finalCount: number;
    if (addEntryMode === 'count') {
      const countValidation = validateCountEntry(addCountText);
      if (!countValidation.valid || countValidation.malas === undefined) {
        Alert.alert('Invalid entry', countValidation.message || 'Please enter a valid total count.');
        return;
      }
      finalMalas = countValidation.malas;
      finalCount = finalMalas * MALAS_TO_COUNT;
    } else {
      if (addMalas <= 0) {
        Alert.alert('Invalid entry', 'Please add at least one mala.');
        return;
      }
      finalMalas = Math.floor(addMalas);
      finalCount = finalMalas * MALAS_TO_COUNT;
    }

    setIsSaving(true);
    try {
      const { userName, userEmail } = await getStoredUserMeta();
      // Unique timestamp per entry (selected day + current time-of-day) so multiple manual entries
      // on the SAME date don't share a completion_id (= userId:epochMs). The old fixed noon made
      // every same-date manual entry collide -> dedup/upsert collapsed them ("Saved" but no change).
      const [mY, mM, mD] = addDate.split('-').map(Number);
      const nowParts = new Date();
      const createdAt = new Date(
        mY, mM - 1, mD,
        nowParts.getHours(), nowParts.getMinutes(), nowParts.getSeconds(), nowParts.getMilliseconds()
      ).toISOString();
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const existing = parseHistory(raw);
      // Tagged with whichever Japam is current -- otherwise this entry would be saved untagged
      // and immediately vanish from view, since History now only ever displays the current
      // Japam's records.
      const updated = appendCompletion(existing, {
        date: createdAt,
        malas: finalMalas,
        totalCount: finalCount,
        duration: 0,
        manual: true,
        userId: currentUserId ?? null,
        userName,
        userEmail,
        japamId: currentJapamId,
        japamName: currentJapam?.name ?? null,
      });
      const newCompletionId = updated[0].completionId;
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      console.log(
        '[OFFLINE_SAVE_ACCEPTED] source=history-manual completionId=%s created_at=%s localDay=%s syncStatus=%s',
        newCompletionId,
        createdAt,
        toDayKey(createdAt),
        updated[0].syncStatus
      );

      // Only sync to Supabase for signed-in Google users
      let remoteOk = true; // guests: nothing to sync, not a failure
      if (currentUserId) {
        remoteOk = await syncManualEntryToSupabase({
          userId: currentUserId,
          userName,
          malas: finalMalas,
          totalCount: finalCount,
          createdAt,
          completionId: newCompletionId,
          japamId: currentJapamId,
          japamName: currentJapam?.name ?? null,
        });
      }

      setShowAddModal(false);
      await loadHistory();

      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: currentUserId });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
        window.dispatchEvent(new Event('japam-history-updated'));
      }

      Alert.alert(
        remoteOk ? 'Added' : 'Saved locally',
        remoteOk
          ? 'Japam added to history.'
          : 'Japam saved on this device but could not be synced yet. It will sync automatically later.'
      );
    } catch (err) {
      console.log('Add Japam error:', err);
      Alert.alert('Could not add Japam', 'Something went wrong. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };
  const loadHistory = useCallback(async () => {
    console.log('[LOCAL_FIX_BUILD_MARKER] history-table-v3 edit-confirm-v1');
    await repairLegacyStoredUserId();
    const todayKey = getLocalDateKey();
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const raw = await AsyncStorage.getItem('history');
    const allSessions = parseHistory(raw);

    // Guest mode: currentUserId is null — show local records with null userId
    if (currentUserId) {
      const { userName } = await getStoredUserMeta();
      void backfillMissingUserNames(currentUserId, userName);
    }

    // Local tombstones (deleted completionIds). These are honored here so a delete is reflected
    // immediately even if the remote row hasn't been removed yet — otherwise a same-tick remote
    // fetch would merge the just-deleted row back in (the "needs two clicks to delete" bug).
    const rawTomb = await AsyncStorage.getItem(DELETED_COMPLETIONS_KEY);
    const tombSet = new Set<string>(rawTomb ? JSON.parse(rawTomb) : []);
    const isTombstoned = (item: Session) => tombSet.has(item.completionId as string);

    const cleanedSessions = allSessions.filter((item) => {
      const dayKey = toDayKey(item.date);
      return dayKey === 'unknown' || dayKey <= todayKey;
    });

    if (cleanedSessions.length !== allSessions.length) {
      await AsyncStorage.setItem('history', JSON.stringify(cleanedSessions));
    }

    // Normalize userId comparison: undefined and null both represent "guest/no user"
    const matchesUser = (item: Session) =>
      (item.userId || null) === (currentUserId || null) && !isTombstoned(item);

    let sessions = dedupeSessions(cleanedSessions.filter(matchesUser));
    // TEMPORARY BRIDGE: dual-fetch by legacy numeric id too — see fetchRemoteSessions's header
    // comment and db/migrate_numeric_user_ids_to_uuid.sql for the removal trigger.
    const legacyUserId = await AsyncStorage.getItem(LEGACY_USER_ID_KEY);
    const remoteSessions = currentUserId ? await fetchRemoteSessions(currentUserId, legacyUserId) : null;

    if (remoteSessions !== null) {
      const filteredRemoteSessions = remoteSessions.filter((item) => {
        const dayKey = toDayKey(item.date);
        return dayKey === 'unknown' || dayKey <= todayKey;
      });

      const latestRaw = await AsyncStorage.getItem('history');
      const latestSessions = parseHistory(latestRaw);
      const latestCleanedSessions = latestSessions.filter((item) => {
        const dayKey = toDayKey(item.date);
        return dayKey === 'unknown' || dayKey <= todayKey;
      });
      const mergedHistory = mergeHistories(latestCleanedSessions, filteredRemoteSessions);
      // Honor tombstones on the merged result so a remote row that hasn't been deleted yet (or a
      // remote delete still in flight) does NOT resurrect a locally-deleted record.
      const tombFiltered = mergedHistory.filter((item) => !isTombstoned(item as Session));
      const removedByTomb = mergedHistory.length - tombFiltered.length;
      if (removedByTomb > 0) {
        console.log('[TOMBSTONE_APPLIED] screen=history removed=%d', removedByTomb);
      }
      const remoteCount = remoteSessions.length;
      const localSynced = latestCleanedSessions.filter(
        (r) => (r.userId || null) === currentUserId && r.syncStatus === 'synced'
      ).length;
      const localPending = latestCleanedSessions.filter(
        (r) => (r.userId || null) === currentUserId && r.syncStatus === 'pending'
      ).length;
      console.log(
        '[RECONCILE_PRE] screen=history remote_count=%d local_synced=%d local_pending=%d',
        remoteCount, localSynced, localPending
      );
      const remoteIds = new Set(normalizeAll(filteredRemoteSessions).map((r) => r.completionId));
      let mergedForStorage = tombFiltered;
      if (!currentUserId || remoteCount >= 10000) {
        console.log('[RECONCILE_SKIPPED] screen=history reason=%s count=%d',
          !currentUserId ? 'no-user' : 'possible-truncation', remoteCount);
      } else {
        const before = tombFiltered.length;
        mergedForStorage = reconcileWithServer(tombFiltered, remoteIds, currentUserId);
        console.log('[RECONCILE_APPLIED] screen=history removed=%d', before - mergedForStorage.length);
      }
      sessions = dedupeSessions(mergedForStorage.filter((item) => (item.userId || null) === (currentUserId || null))).sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      await AsyncStorage.setItem('history', JSON.stringify(mergedForStorage));
      console.log('[RESTORE_REMOTE_COUNT] screen=history count=%d', filteredRemoteSessions.length);
      console.log(
        '[MERGE_LOCAL_COUNT_BEFORE] screen=history count=%d pending=%d',
        latestCleanedSessions.length,
        latestCleanedSessions.filter((item) => (item.userId || null) === (currentUserId || null) && item.syncStatus === 'pending').length
      );
      console.log('[MERGE_LOCAL_COUNT_AFTER] screen=history count=%d', mergedForStorage.length);
      console.log('[LOCAL_DAY_BUCKET] screen=history todayKey=%s buckets=%o',
        todayKey,
        sessions.map((s) => ({ completionId: s.completionId, day: toDayKey(s.date) }))
      );

      // Notify Home screen to re-sync stats from the updated local history
      DeviceEventEmitter.emit('japam-stats-updated');
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
      }
    }

    // History does not decide which selector to call or how records get scoped -- it asks
    // HistoryRepository for this Japam's records (already deduped/filtered) and hands the result
    // straight to buildDailyRows. No current Japam selected/none exist yet -> show nothing (the
    // render below shows a distinct help state for this) rather than calling the repository with
    // no Japam to scope to.
    if (!currentJapamId) {
      setDailyRows([]);
      return;
    }
    const japamScopedSessions = await historyRepository.loadHistoryForJapam(currentUserId, currentJapamId);
    setDailyRows(buildDailyRows(japamScopedSessions));
  }, [currentJapamId]);

  // Tombstone-based delete: remove the records locally, record a tombstone (so self-heal never
  // re-uploads them and other devices delete their copy on sync), and best-effort delete remote
  // now. If offline, the local tombstone is pushed by syncPendingHistory on the next sync.
  const performDelete = useCallback(async (completionIds: string[], options?: { day?: string }) => {
    if (!completionIds.length) {
      console.log('[DELETE_SKIPPED_REASON] reason=no-completion-ids');
      return;
    }
    console.log(
      '[HISTORY_DELETE_START] day=%s ids=%s',
      options?.day || 'unknown',
      completionIds.join(',')
    );
    await repairLegacyStoredUserId();
    const ids = new Set(completionIds);
    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const local = parseHistory(raw);

    // 1) Write the tombstone FIRST. loadHistory honors this set, so even a same-tick remote
    //    fetch can never resurrect the record while the remote delete is still in flight.
    const rawTomb = await AsyncStorage.getItem(DELETED_COMPLETIONS_KEY);
    const localTomb: string[] = rawTomb ? JSON.parse(rawTomb) : [];
    await AsyncStorage.setItem(
      DELETED_COMPLETIONS_KEY,
      JSON.stringify(mergeTombstones(localTomb, completionIds))
    );
    console.log('[DELETE_TOMBSTONE_CREATED] count=%d ids=%s', completionIds.length, completionIds.join(','));

    // 2) Remove the records from local history.
    const filtered = local.filter((item) => !ids.has((item as Session).completionId as string));
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(filtered));
    console.log('[DELETE_LOCAL_REMOVED] removed=%d remaining=%d', local.length - filtered.length, filtered.length);

    // 3) Notify Main/History to recompute counts. This screen's own 'japam-history-updated'
    // listener calls loadHistory() in response, which re-fetches through
    // historyRepository.loadHistoryForJapam and is correctly scoped to the current Japam --
    // deliberately not duplicated here as an inline optimistic update (that used to filter by
    // userId only, momentarily showing every Japam's rows mixed together after a delete).
    DeviceEventEmitter.emit('japam-stats-updated');
    DeviceEventEmitter.emit('japam-history-updated', { userId: currentUserId || 'guest' });
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('japam-stats-updated'));
      window.dispatchEvent(new Event('japam-history-updated'));
    }
    console.log('[DELETE_UI_REFRESHED] ids=%s', completionIds.join(','));

    // 4) Atomic remote delete: a single SECURITY DEFINER RPC writes the tombstone(s) AND deletes
    //    the japam_history row(s) in one transaction, so a tombstone can never exist without the
    //    row actually being deleted (or vice versa) — see db/atomic_delete_history_rpc.sql. If
    //    offline / failed, the tombstone is pushed by syncPendingHistory on the next sync.
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key && currentUserId) {
      const deleteToken = (await supabase.auth.getSession()).data.session?.access_token;
      if (!deleteToken) {
        console.log('[DELETE_REMOTE_FAILED] reason=no-session-jwt queued=via-tombstone');
        return;
      }
      try {
        const { error } = await supabase.rpc('delete_history_completions', {
          p_completion_ids: completionIds,
        });
        if (error) {
          console.log(
            '[DELETE_REMOTE_FAILED] reason=rpc-error message=%s queued=via-tombstone',
            error.message
          );
        } else {
          console.log('[HISTORY_DELETE_SUCCESS] ids=%s', completionIds.join(','));
        }
      } catch {
        console.log('[DELETE_REMOTE_FAILED] reason=network (queued via tombstone)');
      }
    } else {
      console.log('[DELETE_REMOTE_FAILED] reason=offline-or-guest queued=via-tombstone');
    }
  }, []);

  const confirmDeleteDay = useCallback((row: DailyRow) => {
    if (!row.completionIds.length) return;
    const title = 'Delete these records?';
    const message = 'This will permanently delete these records from all your devices and cannot be undone.';
    // react-native-web does not render Alert.alert, so use the browser's confirm dialog on web.
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
        void performDelete(row.completionIds, { day: row.dateKey });
      }
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void performDelete(row.completionIds, { day: row.dateKey }) },
    ]);
  }, [performDelete]);

  const saveEditJapam = useCallback(async () => {
    const row = editingRow;
    if (!row || isSaving) return;
    if (editMalas === row.malas) {
      setEditingRow(null);
      return;
    }
    if (editMalas === 0) {
      setEditingRow(null);
      confirmDeleteDay(row);
      return;
    }

    setIsSaving(true);
    try {
      await repairLegacyStoredUserId();
      const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const currentHistory = parseHistory(raw);
      // japamId scoped explicitly: row.malas only ever reflects the current Japam's count (rows
      // are built from already-filtered data), but currentHistory here is the FULL, unfiltered
      // history read fresh from storage -- without this, editing "day X" would aggregate and
      // mutate every Japam's same-day records together instead of only this one's.
      const plan = planHistoryDayAdjustment(
        currentHistory,
        currentUserId,
        row.dateKey,
        editMalas,
        currentJapamId
      );
      if (!plan.changed) {
        setEditingRow(null);
        return;
      }

      // Reuse the existing tombstone/delete path for only the individual completions that the
      // adjustment reduced to zero. Every other completion for the day remains untouched.
      if (plan.recordsToDelete.length > 0) {
        await performDelete(
          plan.recordsToDelete.map((record) => record.completionId),
          { day: row.dateKey }
        );
      }

      if (plan.recordsToUpdate.length > 0) {
        const latestRaw = await AsyncStorage.getItem(HISTORY_KEY);
        const latest = normalizeAll(parseHistory(latestRaw));
        const updatesById = new Map(
          plan.recordsToUpdate.map((update) => [update.after.completionId, update.after])
        );
        const locallyUpdated = latest.map(
          (record) => updatesById.get(record.completionId) || record
        );
        await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(locallyUpdated));
        console.log(
          '[HISTORY_EDIT_LOCAL_ACCEPTED] day=%s targetMalas=%d updates=%d deletes=%d',
          row.dateKey,
          editMalas,
          plan.recordsToUpdate.length,
          plan.recordsToDelete.length
        );
        if (currentUserId) {
          const { userName } = await getStoredUserMeta();
          // Close modal immediately so the user sees the local update while sync runs.
          setEditingRow(null);
          const result = await syncHistoryEditsToSupabase(
            plan.recordsToUpdate.map((update) => update.after),
            currentUserId,
            userName
          );
          if (result.syncedIds.length > 0) {
            const newestRaw = await AsyncStorage.getItem(HISTORY_KEY);
            const newest = parseHistory(newestRaw);
            await AsyncStorage.setItem(
              HISTORY_KEY,
              JSON.stringify(markSynced(newest, result.syncedIds))
            );
          } else if (result.rlsBlocked) {
            Alert.alert(
              'Could not sync edit',
              'Permission denied. Your correction is saved on this device and will retry when you reload.'
            );
          } else if (result.inconclusive) {
            Alert.alert(
              'Edit saved, but confirmation failed',
              'Please refresh to verify.'
            );
          } else {
            Alert.alert(
              'Edit not saved to database',
              'The update reached the server but the row was not changed. This may be a temporary issue — please try again or reload.'
            );
          }
        } else {
          setEditingRow(null);
        }
      } else {
        setEditingRow(null);
      }

      await loadHistory();
      DeviceEventEmitter.emit('japam-stats-updated');
      DeviceEventEmitter.emit('japam-history-updated', { userId: currentUserId || 'guest' });
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('japam-stats-updated'));
        window.dispatchEvent(new Event('japam-history-updated'));
      }
    } catch (error) {
      console.log('History edit error:', error);
      Alert.alert('Could not edit Japam', 'Something went wrong. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [confirmDeleteDay, currentJapamId, editMalas, editingRow, isSaving, loadHistory, performDelete]);

  useFocusEffect(
    useCallback(() => {
      void loadHistory();
    }, [loadHistory])
  );

  useEffect(() => {
    const onHistoryUpdated = () => {
      void loadHistory();
    };

    const subscription = DeviceEventEmitter.addListener('japam-history-updated', onHistoryUpdated);

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('japam-history-updated', onHistoryUpdated as EventListener);
    }

    return () => {
      subscription.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('japam-history-updated', onHistoryUpdated as EventListener);
      }
    };
  }, [loadHistory]);

  const totalMalas = useMemo(
    () => dailyRows.reduce((sum, row) => sum + row.malas, 0),
    [dailyRows]
  );

  const totalCount = useMemo(
    () => dailyRows.reduce((sum, row) => sum + row.totalCount, 0),
    [dailyRows]
  );

  const exportHistory = async () => {
    try {
      if (dailyRows.length === 0) {
        Alert.alert('No history', 'There is no history to export yet.');
        return;
      }

      const lines = ['Date,Malas,Count,Accumulated'];

      dailyRows.forEach((row) => {
        lines.push(
          `${row.dateKey},${row.malas},${row.totalCount},${row.accumulated}`
        );
      });

      const csvContent = lines.join('\n');

      if (Platform.OS === 'web') {
        const blob = new Blob([csvContent], {
          type: 'text/csv;charset=utf-8;',
        });

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = 'japam-history.csv';
        document.body.appendChild(link);
        link.click();

        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        return;
      }

      const fileUri = FileSystem.documentDirectory + 'japam-history.csv';

      await FileSystem.writeAsStringAsync(fileUri, csvContent, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      const available = await Sharing.isAvailableAsync();

      if (!available) {
        Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
        return;
      }

      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: 'Export Japam History',
        UTI: 'public.comma-separated-values-text',
      });
    } catch (error) {
      console.log('Export error:', error);
      Alert.alert('Export failed', 'Something went wrong while exporting history.');
    }
  };

  return (
    <LinearGradient colors={['#e7f5f5', '#c7e2e0', '#eef8f5']} style={styles.container}>
    {[...Array(30)].map((_, i) => (
      <View
        key={i}
        pointerEvents="none"
        style={[
          styles.star,
          {
            left: `${(i * 37 + 11) % 100}%`,
            top: `${(i * 53 + 7) % 100}%`,
            opacity: i % 3 === 0 ? 0.72 : 0.28,
          },
        ]}
      />
    ))}
    <ScrollView
      style={[
        styles.scroll,
        Platform.OS !== 'web' && { marginBottom: tabBarSpaceFromBottom },
      ]}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: 16 },
      ]}
      bounces={Platform.OS !== 'ios'}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await loadHistory();
            setRefreshing(false);
          }}
          tintColor="#0f766e"
          colors={['#0f766e']}
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <CurrentJapamHeaderButton variant="history" />
      </View>

      {!currentJapamId && !isJapamContextLoading ? (
        <View style={[styles.emptyRow, { alignItems: 'center' }]}>
          <Text style={[styles.emptyText, { textAlign: 'center' }]}>
            No Japam selected. Create or select a Japam to see its history.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.headerAddButton, pressed && { opacity: 0.7 }, { marginTop: 16 }]}
            onPress={() => router.push('/my-japams')}
            accessibilityRole="button"
            accessibilityLabel="Open My Japams"
          >
            <Text style={styles.headerAddButtonText}>My Japams</Text>
          </Pressable>
        </View>
      ) : (
      <>
      <View style={styles.simpleSummary}>
        <Text style={styles.summaryText}>📿 Total Malas: {totalMalas}</Text>
        <Text style={styles.summaryText}>🔢 Total Count: {totalCount}</Text>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={({ pressed }) => [styles.headerAddButton, pressed && { opacity: 0.7 }]}
          onPress={openAddModal}
          accessibilityLabel="Add Japam Count"
          accessibilityRole="button"
          hitSlop={8}
        >
          <Ionicons name="add" size={20} color="#ffffff" />
          <Text style={styles.headerAddButtonText}>Add Japam Count</Text>
        </Pressable>
        <Pressable style={styles.exportBtn} onPress={exportHistory}>
          <Text style={styles.exportBtnText}>⬇ Export</Text>
        </Pressable>
      </View>

      <Modal
        visible={showAddModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAddModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add Japam</Text>

            <Text style={styles.modalLabel}>Date</Text>
            <View style={styles.dateChoiceRow}>
              {(['today', 'yesterday', 'custom'] as AddDateMode[]).map((mode) => (
                <Pressable
                  key={mode}
                  style={[
                    styles.dateChoice,
                    addDateMode === mode && styles.dateChoiceSelected,
                  ]}
                  onPress={() => selectAddDateMode(mode)}
                >
                  <Text
                    style={[
                      styles.dateChoiceText,
                      addDateMode === mode && styles.dateChoiceTextSelected,
                    ]}
                  >
                    {mode === 'today' ? 'Today' : mode === 'yesterday' ? 'Yesterday' : 'Custom Date'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {addDateMode === 'custom' && (
              <TextInput
                style={styles.modalInput}
                value={addDate}
                onChangeText={setAddDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#8aacae"
                maxLength={10}
              />
            )}

            <Text style={styles.modalLabel}>Entry Mode</Text>
            <View style={styles.dateChoiceRow}>
              {(['malas', 'count'] as AddEntryMode[]).map((mode) => (
                <Pressable
                  key={mode}
                  style={[
                    styles.dateChoice,
                    addEntryMode === mode && styles.dateChoiceSelected,
                  ]}
                  onPress={() => setAddEntryMode(mode)}
                >
                  <Text
                    style={[
                      styles.dateChoiceText,
                      addEntryMode === mode && styles.dateChoiceTextSelected,
                    ]}
                  >
                    {mode === 'malas' ? 'Malas' : 'Total Count'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {addEntryMode === 'malas' ? (
              <>
                <Text style={styles.modalLabel}>Malas</Text>
                <View style={styles.stepperRow}>
                  <Pressable
                    style={styles.stepperButton}
                    onPress={() => setAddMalas((value) => Math.max(1, value - 1))}
                    accessibilityLabel="Decrease malas"
                  >
                    <Ionicons name="remove" size={24} color="#0f766e" />
                  </Pressable>
                  <Text style={styles.stepperValue}>{addMalas}</Text>
                  <Pressable
                    style={styles.stepperButton}
                    onPress={() => setAddMalas((value) => value + 1)}
                    accessibilityLabel="Increase malas"
                  >
                    <Ionicons name="add" size={24} color="#0f766e" />
                  </Pressable>
                </View>

                <Text style={styles.countPreview}>Total Count: {addMalas * MALAS_TO_COUNT}</Text>
              </>
            ) : (
              <>
                <Text style={styles.modalLabel}>Total Count</Text>
                <TextInput
                  style={styles.modalInput}
                  value={addCountText}
                  onChangeText={setAddCountText}
                  placeholder="e.g. 216"
                  placeholderTextColor="#8aacae"
                  keyboardType="numeric"
                />
                {(() => {
                  const countValidation = validateCountEntry(addCountText);
                  return countValidation.valid ? (
                    <Text style={styles.countPreview}>Malas: {countValidation.malas}</Text>
                  ) : countValidation.message ? (
                    <Text style={styles.validationErrorText}>{countValidation.message}</Text>
                  ) : null;
                })()}
              </>
            )}

            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setShowAddModal(false)} disabled={isSaving}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalSave, isSaving && { opacity: 0.6 }]}
                onPress={saveAddJapam}
                disabled={isSaving || (addEntryMode === 'count' && !validateCountEntry(addCountText).valid)}
              >
                <Text style={styles.modalSaveText}>{isSaving ? 'Adding…' : 'Add'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={Boolean(editingRow)}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingRow(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit Japam</Text>
            <Text style={styles.modalLabel}>Date</Text>
            <Text style={styles.readOnlyDate}>
              {editingRow ? toEditDateLabel(editingRow.dateKey) : ''}
            </Text>

            <Text style={styles.modalLabel}>Malas</Text>
            <View style={styles.stepperRow}>
              <Pressable
                style={styles.stepperButton}
                onPress={() => setEditMalas((value) => Math.max(0, value - 1))}
                accessibilityLabel="Decrease malas"
              >
                <Ionicons name="remove" size={24} color="#0f766e" />
              </Pressable>
              <Text style={styles.stepperValue}>{editMalas}</Text>
              <Pressable
                style={styles.stepperButton}
                onPress={() => setEditMalas((value) => value + 1)}
                accessibilityLabel="Increase malas"
              >
                <Ionicons name="add" size={24} color="#0f766e" />
              </Pressable>
            </View>

            <Text style={styles.countPreview}>Total Count: {editMalas * 108}</Text>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setEditingRow(null)} disabled={isSaving}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.modalSave, isSaving && { opacity: 0.6 }]} onPress={saveEditJapam} disabled={isSaving}>
                <Text style={styles.modalSaveText}>{isSaving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <View style={styles.tableCard}>
        <View style={[styles.tableRow, styles.tableHeader]}>
          <View style={[styles.columnCell, styles.dateColumn]}>
            <Text style={[styles.cellText, styles.tableHeaderText]} numberOfLines={1}>Date</Text>
          </View>
          <View style={[styles.columnCell, styles.numColumn]}>
            <Text style={[styles.cellText, styles.numericText, styles.tableHeaderText]} numberOfLines={1}>Malas</Text>
          </View>
          <View style={[styles.columnCell, styles.countColumn]}>
            <Text style={[styles.cellText, styles.numericText, styles.tableHeaderText]} numberOfLines={1}>Count</Text>
          </View>
          <View style={[styles.columnCell, styles.totalColumn]}>
            <Text style={[styles.cellText, styles.numericText, styles.tableHeaderText]} numberOfLines={1}>Total</Text>
          </View>
          <View style={[styles.columnCell, styles.actionsColumn]}>
            {/* intentionally blank — column alignment maintained by actionsColumn width */}
          </View>
        </View>

        {dailyRows.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.emptyText}>No Japam history yet</Text>
          </View>
        ) : (
          dailyRows.map((row, index) => {
            const rowStyle = [styles.tableRow, index % 2 === 1 && styles.altTableRow];
            const rowContent = (
              <>
                <View style={[styles.columnCell, styles.dateColumn]}>
                  <Text style={styles.cellText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.9}>
                    {row.dateLabel}
                  </Text>
                </View>
                <View style={[styles.columnCell, styles.numColumn]}>
                  <Text style={[styles.cellText, styles.numericText]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.92}>{row.malas}</Text>
                </View>
                <View style={[styles.columnCell, styles.countColumn]}>
                  <Text style={[styles.cellText, styles.numericText]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.92}>{row.totalCount}</Text>
                </View>
                <View style={[styles.columnCell, styles.totalColumn]}>
                  <Text style={[styles.cellText, styles.numericText]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.92}>{row.accumulated}</Text>
                </View>
                <View style={[styles.columnCell, styles.actionsColumn]}>
                  <View style={styles.rowActions}>
                    <Pressable
                      style={({ pressed }) => [
                        styles.rowActionButton,
                        styles.rowActionEditButton,
                        pressed && { opacity: 0.5 },
                      ]}
                      onPress={() => {
                        console.log('[EDIT_ICON_PRESS] dateKey=%s malas=%d', row.dateKey, row.malas);
                        openEditModal(row);
                      }}
                      accessibilityLabel={`Edit ${row.dateLabel}`}
                      accessibilityHint="Opens this day's malas for editing"
                      accessibilityRole="button"
                      hitSlop={4}
                    >
                      <Ionicons name="pencil-outline" size={19} color="#0f766e" />
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [
                        styles.rowActionButton,
                        styles.rowActionDeleteButton,
                        pressed && { opacity: 0.5 },
                      ]}
                      onPress={() => confirmDeleteDay(row)}
                      accessibilityLabel={`Delete ${row.dateLabel}`}
                      accessibilityHint="Deletes this day's history rows"
                      accessibilityRole="button"
                      hitSlop={4}
                    >
                      <Ionicons name="trash-outline" size={20} color="#6b7280" />
                    </Pressable>
                  </View>
                </View>
              </>
            );
            // On web the outer Pressable's pointer-event handling blocks nested Pressable onPress.
            // Long-press delete is not used on web (the hint text already says "Use row actions").
            if (Platform.OS === 'web') {
              return (
                <View key={`${row.dateKey}-${index}`} style={rowStyle}>
                  {rowContent}
                </View>
              );
            }
            return (
              <Pressable
                key={`${row.dateKey}-${index}`}
                onLongPress={() => confirmDeleteDay(row)}
                delayLongPress={500}
                style={rowStyle}
              >
                {rowContent}
              </Pressable>
            );
          })
        )}
      </View>

      {dailyRows.length > 0 && (
        <Text style={{ textAlign: 'center', color: '#5f7778', fontSize: 12, marginTop: 10 }}>
          {Platform.OS === 'web'
            ? 'Use the row actions to edit or delete a day.'
            : 'Use the row actions to edit, or long-press to delete a day.'}
        </Text>
      )}
      </>
      )}

    </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  scroll: {
    flex: 1,
  },

  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 99,
    backgroundColor: '#0f766e',
  },

  content: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 28,
    // paddingBottom is applied inline on the ScrollView (see JSX / tabBarSpaceFromBottom).
  },

  header: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
    minHeight: 52,
  },

  headerAddButton: {
    flexShrink: 0,
    minHeight: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f8a87',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: isNarrowPhone ? 16 : 18,
    minWidth: isNarrowPhone ? 176 : 0,
  },

  headerAddButtonText: {
    color: '#ffffff',
    fontSize: isNarrowPhone ? 14 : 15,
    fontWeight: '800',
  },

  title: {
    color: '#102f34',
    flexShrink: 1,
    fontSize: isNarrowPhone ? 32 : 36,
    fontWeight: '900',
    marginBottom: 0,
    paddingBottom: 2,
    textAlign: 'center',
    width: '100%',
  },


  // Previously flexDirection:'row' + flexWrap:'wrap'. When "Total Count: 124607" grew wide enough
  // to wrap onto a second flex row inside ScrollView, RN miscalculated the container height as
  // only one row tall — so actionRow rendered at the same Y position as the second summary line,
  // producing a visual overlap. Switching to column eliminates wrapping entirely: each stat always
  // gets its own dedicated row, regardless of value length or font scale.
  simpleSummary: {
    flexDirection: 'column',
    gap: 6,
    marginBottom: 20,
    alignItems: 'center',
  },

  summaryText: {
    color: '#12383c',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },

  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 18,
  },

  exportBtn: {
    backgroundColor: '#0f8a87',
    minHeight: 44,
    paddingHorizontal: 18,
    minWidth: isNarrowPhone ? 132 : 120,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },

  exportBtnText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '800',
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },

  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 380,
  },

  modalTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#102f34',
    marginBottom: 18,
    textAlign: 'center',
  },

  modalLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#365f61',
    marginBottom: 6,
    marginTop: 10,
  },

  modalInput: {
    borderWidth: 1.5,
    borderColor: 'rgba(15,118,110,0.3)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#102f34',
    backgroundColor: '#f5fafa',
  },

  dateChoiceRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },

  dateChoice: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(15,118,110,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    backgroundColor: '#f5fafa',
  },

  dateChoiceSelected: {
    borderColor: '#0f8a87',
    backgroundColor: 'rgba(15,138,135,0.12)',
  },

  dateChoiceText: {
    color: '#365f61',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },

  dateChoiceTextSelected: {
    color: '#0f766e',
    fontWeight: '900',
  },

  readOnlyDate: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: '#f5fafa',
    color: '#12383c',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
    textAlignVertical: 'center',
    paddingVertical: 12,
  },

  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    marginTop: 4,
  },

  stepperButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    borderColor: 'rgba(15,118,110,0.35)',
    backgroundColor: '#f5fafa',
    alignItems: 'center',
    justifyContent: 'center',
  },

  stepperValue: {
    minWidth: 70,
    color: '#102f34',
    fontSize: 34,
    fontWeight: '900',
    textAlign: 'center',
  },

  countPreview: {
    color: '#365f61',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 16,
  },

  validationErrorText: {
    color: '#c0392b',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 16,
  },

  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 22,
    justifyContent: 'flex-end',
  },

  modalCancel: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 999,
    backgroundColor: 'rgba(15,118,110,0.1)',
  },

  modalCancelText: {
    color: '#0f766e',
    fontSize: 15,
    fontWeight: '700',
  },

  modalSave: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 999,
    backgroundColor: '#0f8a87',
  },

  modalSaveText: {
    color: 'white',
    fontSize: 15,
    fontWeight: '800',
  },

  tableCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.52)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.16)',
    overflow: 'hidden',
  },

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    borderTopWidth: 1,
    borderTopColor: 'rgba(15, 118, 110, 0.16)',
  },

  tableHeader: {
    backgroundColor: 'rgba(15, 118, 110, 0.18)',
    borderTopWidth: 0,
  },

  altTableRow: {
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
  },

  columnCell: {
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: TABLE_CELL_PADDING_H,
  },
  cellText: {
    color: '#12383c',
    fontSize: TABLE_VALUE_FONT_SIZE,
    fontWeight: '700',
  },
  dateColumn: IS_ANDROID
    ? { width: ANDROID_DATE_WIDTH, flexGrow: 0, flexShrink: 0 }
    : { flexBasis: 0, flexGrow: DATE_CELL_FLEX, flexShrink: 1, minWidth: DATE_MIN_WIDTH },
  // Same fontSize/letterSpacing for every header cell (Date/Malas/Count/Total) — no per-column
  // size difference. Small negative letterSpacing shaves a few px off bold header text width
  // without shrinking fontSize.
  tableHeaderText: { fontSize: TABLE_HEADER_FONT_SIZE, letterSpacing: isNarrowPhone ? -0.1 : -0.2 },
  // Centered per requirement — Date stays left-aligned (its default), these three numeric
  // columns are explicitly centered.
  // width: '100%' forces the Text to occupy the column's full width before centering — without
  // it, numberOfLines={1}+adjustsFontSizeToFit can shrink-wrap short values (e.g. a single-digit
  // "1") to their own tight intrinsic width on Android, so textAlign:'center' centers within that
  // tiny box instead of the real column, drifting short values toward the left of wider ones.
  numericText: { textAlign: 'center', width: '100%' },
  actionsHeaderText: { textAlign: 'center' },
  // On Android this is deliberately the single largest numeric-column width (see
  // ANDROID_MALAS_WIDTH) — not "small" — because the "Malas" header word is the one that's
  // repeatedly truncated in practice. On web/iOS it keeps the original small flex share.
  numColumn: IS_ANDROID
    ? { width: ANDROID_MALAS_WIDTH, flexGrow: 0, flexShrink: 0 }
    : { flexBasis: 0, flexGrow: MALAS_CELL_FLEX, flexShrink: 1 },
  countColumn: IS_ANDROID
    ? { width: ANDROID_COUNT_WIDTH, flexGrow: 0, flexShrink: 0 }
    : { flexBasis: 0, flexGrow: COUNT_CELL_FLEX, flexShrink: 1 },
  // Total is the one column left with a little elasticity on Android (flexGrow/flexShrink, not
  // a strict fixed width like the others) — it's never been the one that truncates, so it's the
  // safest place to absorb any leftover/short space if the other columns' exact dp totals don't
  // add up perfectly to the real device width.
  totalColumn: IS_ANDROID
    ? { flexBasis: ANDROID_TOTAL_WIDTH, flexGrow: 1, flexShrink: 1 }
    : { flexBasis: 0, flexGrow: TOTAL_CELL_FLEX, flexShrink: 1 },
  actionsColumn: {
    width: ACTIONS_COLUMN_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    // No horizontal padding here (unlike other columns) — the column width is already sized to
    // exactly fit the two buttons plus their gap, so padding on top would force an overflow.
    paddingHorizontal: 0,
  },

  rowActions: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ROW_ACTIONS_GAP,
  },

  rowActionButton: {
    width: ROW_ACTION_BUTTON_SIZE,
    height: ROW_ACTION_BUTTON_SIZE,
    borderRadius: ROW_ACTION_BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  rowActionEditButton: {
    backgroundColor: 'rgba(15, 138, 135, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(15, 118, 110, 0.22)',
  },

  rowActionDeleteButton: {
    backgroundColor: 'rgba(107, 114, 128, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(107, 114, 128, 0.18)',
  },

  emptyRow: {
    padding: 18,
  },

  emptyText: {
    color: '#547071',
    fontSize: 18,
  },
});
