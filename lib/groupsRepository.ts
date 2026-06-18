/**
 * Groups / Family Japam — thin data-access layer over the live Supabase RPCs
 * (create_group, find_group_by_invite_code, get_my_groups, get_group_dashboard) plus the
 * direct group_members insert used by the Join flow. No UI here.
 *
 * user_id is always a plain opaque string (Google numeric ID today — see
 * GUEST_TO_ANON_AUTH_MIGRATION.md for why this isn't guaranteed to stay that way forever).
 */
import { supabase } from './supabase';

export type GroupRole = 'admin' | 'member';

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
  | { kind: 'joined'; groupId: string }
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
  userId: string,
  userName: string
): Promise<JoinGroupOutcome> {
  const { data: found, error: findError } = await supabase.rpc('find_group_by_invite_code', {
    p_invite_code: inviteCode,
  });
  if (findError) return { kind: 'error', message: findError.message };

  const group = Array.isArray(found) && found.length > 0 ? (found[0] as any) : null;
  if (!group) return { kind: 'notFound' };
  if (!group.is_active) return { kind: 'inactive' };

  const { error: insertError } = await supabase
    .from('group_members')
    .insert({ group_id: group.id, user_id: userId, user_name: userName, role: 'member' });

  if (insertError) {
    // 23505 = unique_violation on (group_id, user_id) -> already a member; treat as success.
    if ((insertError as any).code === '23505') {
      return { kind: 'joined', groupId: group.id };
    }
    return { kind: 'error', message: insertError.message };
  }

  return { kind: 'joined', groupId: group.id };
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
