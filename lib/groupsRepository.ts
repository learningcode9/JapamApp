/**
 * Groups / Family Japam — thin data-access layer over the live Supabase RPCs
 * (create_group, join_group_by_invite_code, get_my_groups, get_group_dashboard). No UI here.
 *
 * Membership writes derive the user ID from the active Supabase session inside the join RPC.
 */
import { supabase } from './supabase';

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

export async function getMyGroups(userId: string): Promise<MyGroup[]> {
  const { data, error } = await supabase.rpc('get_my_groups', { p_user_id: userId });
  if (error) throw error;
  return ((data ?? []) as any[]).map((row) => ({
    groupId: row.group_id,
    name: row.name,
    role: row.role,
    isActive: row.is_active,
    joinedAt: row.joined_at,
  }));
}

export async function createGroup(
  name: string,
  userId: string,
  userName: string
): Promise<CreateGroupResult> {
  const { data, error } = await supabase.rpc('create_group', {
    p_name: name,
    p_created_by: userId,
    p_user_name: userName,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { groupId: row.group_id, groupName: row.group_name, inviteCode: row.invite_code };
}

export async function joinGroupByInviteCode(
  inviteCode: string,
  userName: string
): Promise<JoinGroupOutcome> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session?.user?.id) {
    return { kind: 'error', message: 'Please sign in before joining a group.' };
  }

  const { data, error } = await supabase.rpc('join_group_by_invite_code', {
    p_invite_code: inviteCode,
    p_user_name: userName,
  });
  if (error) return { kind: 'error', message: error.message };

  const group = Array.isArray(data) && data.length > 0 ? (data[0] as any) : null;
  if (!group) return { kind: 'notFound' };
  if (!group.is_active) return { kind: 'inactive' };

  return { kind: 'joined', groupId: group.id, groupName: group.name };
}

export async function getGroupDashboard(
  groupId: string,
  currentUserId: string,
  todayStartIso: string,
  todayEndIso: string
): Promise<GroupDashboardRow[]> {
  const { data, error } = await supabase.rpc('get_group_dashboard', {
    p_group_id: groupId,
    p_current_user_id: currentUserId,
    p_today_start: todayStartIso,
    p_today_end: todayEndIso,
  });
  if (error) throw error;
  return ((data ?? []) as any[]).map((row) => ({
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
}

// Admin-only — reads back the invite_code already stored on the group at creation time (never
// generates a new one). get_group_invite_code raises if the caller isn't an admin member of this
// exact group_id, so a non-admin/non-member calling this directly gets nothing back either way;
// the UI only ever calls this once it already knows (from getGroupDashboard's own role field)
// that the current user is this group's admin.
export async function getGroupInviteCode(
  groupId: string,
  requestingUserId: string
): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_group_invite_code', {
    p_group_id: groupId,
    p_current_user_id: requestingUserId,
  });
  if (error) throw error;
  // The deployed function returns its result as [{ invite_code: "..." }] (a one-row/one-column
  // result set), not a bare scalar string — confirmed live via direct REST call. Unwrap that
  // shape; fall back to treating `data` as a bare string defensively, in case this ever changes.
  if (Array.isArray(data)) {
    const row = data[0] as { invite_code?: string } | undefined;
    return row?.invite_code ?? null;
  }
  return (data as string | null) ?? null;
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
