/**
 * Groups / Family Japam — thin data-access layer over the live Supabase RPCs
 * (create_group, join_group_by_invite_code, get_my_groups, get_my_unassigned_groups,
 * attach_group_membership_to_japam, get_group_dashboard) plus the admin/read RPCs. No UI here.
 *
 * Workspace isolation (Issue 3): every group is tied to the member's OWN selected Japam
 * (workspace) via group_members.japam_id. Create, join, list, attach, and dashboard calls all
 * take the caller's current japamId so the server scopes everything to that workspace. A Japam
 * UUID from one member is never used to read another member's History — the server aggregates
 * each member by their own membership mapping.
 *
 * user_id is always a plain opaque string (Google numeric ID today — see
 * GUEST_TO_ANON_AUTH_MIGRATION.md for why this isn't guaranteed to stay that way forever).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const GROUPS_CACHE_PREFIX = 'japamGroupsCache:';

/**
 * True only for transport-level failures (no network / request aborted by the OS) — NEVER for a
 * server-rejected RPC (a real PostgrestError carries an HTTP status, e.g. RLS 403 or 404). Only
 * transport failures may fall back to the offline cache; a real RLS/authorization/data error must
 * surface exactly as before, so the user is never shown stale groups while being denied access
 * server-side.
 */
export const isNetworkFailure = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  if (error !== null && typeof error === 'object' && (error as { status?: unknown }).status === 0) {
    return true;
  }
  const message = typeof error === 'string'
    ? error
    : String((error as { message?: unknown })?.message ?? error ?? '');
  return /network request failed|fetch failed|networkerror|failed to fetch/i.test(message);
};

const readCached = async <T,>(scope: string): Promise<T | null> => {
  try {
    const raw = await AsyncStorage.getItem(GROUPS_CACHE_PREFIX + scope);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const readCachedArray = async <T,>(scope: string): Promise<T[] | null> => {
  const parsed = await readCached<T[]>(scope);
  return Array.isArray(parsed) ? parsed : null;
};

const writeCached = (scope: string, value: unknown): void => {
  AsyncStorage.setItem(GROUPS_CACHE_PREFIX + scope, JSON.stringify(value)).catch(() => {});
};

const getCachedGroupsScopeUserId = async (): Promise<string> => {
  try {
    return (await AsyncStorage.getItem('userId')) || 'anon';
  } catch {
    return 'anon';
  }
};

export type GroupRole = 'admin' | 'member';
export type GroupAdminActionOutcome =
  | { kind: 'success' }
  | { kind: 'notAdmin'; message?: string }
  | { kind: 'notFound'; message?: string }
  | { kind: 'lastAdmin'; message?: string }
  | { kind: 'selfRemoval'; message?: string }
  | { kind: 'error'; message?: string };

export interface MyGroup {
  groupId: string;
  name: string;
  role: GroupRole;
  isActive: boolean;
  joinedAt: string;
}

export interface CreateGroupResult {
  groupId: string;
  groupName: string;
  inviteCode: string;
}

export type JoinGroupOutcome =
  | { kind: 'joined'; groupId: string; groupName: string }
  | { kind: 'notFound' }
  | { kind: 'inactive' }
  | { kind: 'error'; message: string };

export interface GroupDashboardRow {
  userId: string;
  userName: string | null;
  role: GroupRole;
  joinedAt: string;
  todayMalas: number;
  todayCount: number;
  totalMalas: number;
  totalCount: number;
  lastUpdated: string | null;
}

/**
 * Local-first cached reads for the Groups screen — pure AsyncStorage reads that NEVER touch the
 * network. The screen renders these immediately on mount so an offline cold start opens instantly
 * (the remote RPCs below stall offline while supabase's getSession() triggers a network token
 * refresh for a near-expiry session, so waiting on them would hang the list). The screen then
 * reconciles in the background via getMyGroups / getMyUnassignedGroups, which write these same
 * scoped caches through on every success.
 */
export const getCachedMyGroups = async (userId: string, japamId: string): Promise<MyGroup[] | null> =>
  readCachedArray<MyGroup>(`groups:${userId}:${japamId}`);

export const getCachedMyUnassignedGroups = async (): Promise<MyGroup[] | null> =>
  readCachedArray<MyGroup>(`unassigned:${await getCachedGroupsScopeUserId()}`);

export async function getMyGroups(userId: string, japamId: string): Promise<MyGroup[]> {
  const scope = `groups:${userId}:${japamId}`;
  try {
    const { data, error } = await supabase.rpc('get_my_groups', { p_user_id: userId, p_japam_id: japamId });
    if (error) throw error;
    const groups = ((data ?? []) as any[]).map((row) => ({
      groupId: row.group_id,
      name: row.name,
      role: row.role,
      isActive: row.is_active,
      joinedAt: row.joined_at,
    }));
    writeCached(scope, groups);
    return groups;
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    const cached = await readCachedArray<MyGroup>(scope);
    if (cached !== null) return cached;
    throw err;
  }
}

export async function getMyUnassignedGroups(): Promise<MyGroup[]> {
  const scope = `unassigned:${await getCachedGroupsScopeUserId()}`;
  try {
    const { data, error } = await supabase.rpc('get_my_unassigned_groups', {});
    if (error) throw error;
    const groups = ((data ?? []) as any[]).map((row) => ({
      groupId: row.group_id,
      name: row.name,
      role: row.role,
      isActive: row.is_active,
      joinedAt: row.joined_at,
    }));
    writeCached(scope, groups);
    return groups;
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    const cached = await readCachedArray<MyGroup>(scope);
    if (cached !== null) return cached;
    throw err;
  }
}

export async function createGroup(
  name: string,
  userId: string,
  userName: string,
  japamId: string
): Promise<CreateGroupResult> {
  const { data, error } = await supabase.rpc('create_group', {
    p_name: name,
    p_created_by: userId,
    p_user_name: userName,
    p_japam_id: japamId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { groupId: row.group_id, groupName: row.group_name, inviteCode: row.invite_code };
}

export async function joinGroupByInviteCode(
  inviteCode: string,
  userId: string,
  userName: string,
  japamId: string
): Promise<JoinGroupOutcome> {
  const { data, error } = await supabase.rpc('join_group_by_invite_code', {
    p_invite_code: inviteCode,
    p_user_name: userName,
    p_japam_id: japamId,
  });
  if (error) return { kind: 'error', message: error.message };

  const row = Array.isArray(data) && data.length > 0 ? (data[0] as any) : null;
  if (!row) return { kind: 'notFound' };
  if (!row.is_active) return { kind: 'inactive' };

  // already_member is true only when the server confirmed the existing membership is already
  // attached to this workspace (or safely attached an unassigned legacy membership). A different
  // workspace is returned by the RPC as an error and never reaches this success path.
  return { kind: 'joined', groupId: row.id, groupName: row.name };
}

export async function attachGroupMembershipToJapam(
  groupId: string,
  japamId: string
): Promise<{ kind: 'success' } | { kind: 'alreadyAttached' } | { kind: 'error'; message: string }> {
  const { error } = await supabase.rpc('attach_group_membership_to_japam', {
    p_group_id: groupId,
    p_japam_id: japamId,
  });
  if (!error) return { kind: 'success' };
  if (String(error.message).toLowerCase().includes('already attached')) {
    return { kind: 'alreadyAttached' };
  }
  return { kind: 'error', message: error.message };
}

export async function getGroupDashboard(
  groupId: string,
  currentUserId: string,
  todayStartIso: string,
  todayEndIso: string,
  japamId: string
): Promise<GroupDashboardRow[]> {
  const scope = `dashboard:${groupId}:${currentUserId}:${japamId}`;
  try {
    const { data, error } = await supabase.rpc('get_group_dashboard', {
      p_group_id: groupId,
      p_current_user_id: currentUserId,
      p_today_start: todayStartIso,
      p_today_end: todayEndIso,
      p_japam_id: japamId,
    });
    if (error) throw error;
    const rows = ((data ?? []) as any[]).map((row) => ({
      userId: row.user_id,
      userName: row.user_name,
      role: row.role,
      joinedAt: row.joined_at,
      todayMalas: Number(row.today_malas) || 0,
      todayCount: Number(row.today_count) || 0,
      totalMalas: Number(row.total_malas) || 0,
      totalCount: Number(row.total_count) || 0,
      lastUpdated: row.last_updated,
    }));
    writeCached(scope, rows);
    return rows;
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    const cached = await readCachedArray<GroupDashboardRow>(scope);
    if (cached !== null) return cached;
    throw err;
  }
}

export const getCachedGroupDashboard = async (
  groupId: string,
  currentUserId: string,
  japamId: string,
): Promise<GroupDashboardRow[] | null> =>
  readCachedArray<GroupDashboardRow>(`dashboard:${groupId}:${currentUserId}:${japamId}`);

// Admin-only — reads back the invite_code already stored on the group at creation time (never
// generates a new one). get_group_invite_code raises if the caller isn't an admin member of this
// exact group_id, so a non-admin/non-member calling this directly gets nothing back either way;
// the UI only ever calls this once it already knows (from getGroupDashboard's own role field)
// that the current user is this group's admin.
export async function getGroupInviteCode(
  groupId: string,
  requestingUserId: string
): Promise<string | null> {
  const scope = `inviteCode:${groupId}:${requestingUserId}`;
  try {
    const { data, error } = await supabase.rpc('get_group_invite_code', {
      p_group_id: groupId,
      p_current_user_id: requestingUserId,
    });
    if (error) throw error;
    // The deployed function returns its result as [{ invite_code: "..." }] (a one-row/one-column
    // result set), not a bare scalar string — confirmed live via direct REST call. Unwrap that
    // shape; fall back to treating `data` as a bare string defensively, in case this ever changes.
    let code: string | null;
    if (Array.isArray(data)) {
      const row = data[0] as { invite_code?: string } | undefined;
      code = row?.invite_code ?? null;
    } else {
      code = (data as string | null) ?? null;
    }
    if (code !== null) writeCached(scope, code);
    return code;
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    const cached = await readCached<string>(scope);
    if (cached !== null) return cached;
    throw err;
  }
}

function mapGroupAdminError(error: any): Exclude<GroupAdminActionOutcome, { kind: 'success' }> {
  const message = error?.message || 'Something went wrong. Please try again.';
  const normalized = String(message).toLowerCase();
  if (normalized.includes('not a group admin') || normalized.includes('only group admin')) {
    return { kind: 'notAdmin', message };
  }
  if (normalized.includes('group not found') || normalized.includes('member not found')) {
    return { kind: 'notFound', message };
  }
  if (normalized.includes('last admin')) {
    return { kind: 'lastAdmin', message };
  }
  if (normalized.includes('cannot remove yourself')) {
    return { kind: 'selfRemoval', message };
  }
  return { kind: 'error', message };
}

export async function renameGroup(
  groupId: string,
  actingAdminUserId: string,
  newName: string
): Promise<{ kind: 'success'; name: string } | Exclude<GroupAdminActionOutcome, { kind: 'success' }>> {
  const { data, error } = await supabase.rpc('rename_group', {
    p_group_id: groupId,
    p_acting_admin_user_id: actingAdminUserId,
    p_new_name: newName,
  });
  if (error) return mapGroupAdminError(error);
  if (Array.isArray(data)) {
    const row = data[0] as { name?: string } | undefined;
    return { kind: 'success', name: row?.name ?? newName };
  }
  return { kind: 'success', name: (data as string | null) ?? newName };
}

export async function removeGroupMember(
  groupId: string,
  actingAdminUserId: string,
  targetUserId: string
): Promise<GroupAdminActionOutcome> {
  const { error } = await supabase.rpc('remove_group_member', {
    p_group_id: groupId,
    p_acting_admin_user_id: actingAdminUserId,
    p_target_user_id: targetUserId,
  });
  if (error) return mapGroupAdminError(error);
  return { kind: 'success' };
}

export async function deleteGroup(
  groupId: string,
  actingAdminUserId: string
): Promise<GroupAdminActionOutcome> {
  const { error } = await supabase.rpc('delete_group', {
    p_group_id: groupId,
    p_acting_admin_user_id: actingAdminUserId,
  });
  if (error) return mapGroupAdminError(error);
  return { kind: 'success' };
}

export async function leaveGroup(
  groupId: string,
  currentUserId: string
): Promise<GroupAdminActionOutcome> {
  const { error } = await supabase.rpc('leave_group', {
    p_group_id: groupId,
    p_current_user_id: currentUserId,
  });
  if (error) return mapGroupAdminError(error);
  return { kind: 'success' };
}
