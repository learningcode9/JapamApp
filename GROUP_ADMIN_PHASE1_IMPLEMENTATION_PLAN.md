# Group Admin Management Phase 1 Implementation Plan

Status: implementation planning only. No code, migration, Supabase change, commit, deploy, or release action is implied by this document.

## 1. Phase 1 Scope

Phase 1 includes only:

1. Leave Group
2. Remove Member
3. Promote Member To Admin
4. Last Admin Protection

Explicitly out of scope:

- Owner role
- Archive/delete group
- Transfer ownership
- Demote admin
- Rename group
- Regenerate invite code
- Audit log
- Ban/block list
- Historical roster tracking

Current role model remains:

- `admin`
- `member`

## 2. Current Schema Fit

Current tables already support Phase 1.

```text
groups
- id uuid primary key
- name text
- invite_code text unique
- created_by text
- created_at timestamptz
- is_active boolean

group_members
- id uuid primary key
- group_id uuid references groups(id) on delete cascade
- user_id text
- user_name text
- role text check ('admin', 'member')
- joined_at timestamptz
- unique (group_id, user_id)
```

No new columns are required for Phase 1.

Phase 1 actions can be implemented by:

- Deleting a row from `group_members` for leave/remove.
- Updating `group_members.role` from `member` to `admin` for promote.
- Checking admin count before any action that might remove the last admin.

Important: do not add direct client UPDATE/DELETE policies. All writes should be through SECURITY DEFINER RPCs.

## 3. Required RPCs

### 3.1 `leave_group`

Purpose:

- Let a user leave a group they belong to.

Signature:

```sql
leave_group(
  p_group_id uuid,
  p_current_user_id text
) returns boolean
```

Rules:

- Current user must be a member of the group.
- If current user is `member`, allow leave.
- If current user is `admin`, allow leave only if another admin remains.
- If current user is the last admin, reject.
- Personal history must not be deleted.

Server-side validation:

1. Group exists.
2. User has membership row.
3. If role is `admin`, count admins in group.
4. If admin count <= 1, raise `cannot leave as last admin`.
5. Delete membership row.

Expected outcomes:

- `true` on success.
- Error on not member.
- Error on last admin.

Recommended known error messages:

- `not a member of this group`
- `cannot leave group as last admin`

### 3.2 `remove_group_member`

Purpose:

- Let an admin remove another member from the group.

Signature:

```sql
remove_group_member(
  p_group_id uuid,
  p_acting_admin_user_id text,
  p_target_user_id text
) returns boolean
```

Rules:

- Acting user must be an admin in the same group.
- Target user must be a member of the same group.
- Acting admin cannot remove themselves through this RPC.
- If target is admin, removal is allowed only if another admin remains.
- Personal history must not be deleted.

Server-side validation:

1. Acting user has role `admin` in group.
2. Target user has membership row in group.
3. `p_acting_admin_user_id != p_target_user_id`.
4. If target role is `admin`, count admins.
5. If target is last admin, reject.
6. Delete target membership row.

Expected outcomes:

- `true` on success.
- Error on not admin.
- Error on target missing.
- Error on self removal.
- Error on last admin.

Recommended known error messages:

- `not a group admin`
- `member not found`
- `cannot remove yourself; use leave group`
- `cannot remove last admin`

### 3.3 `promote_group_admin`

Purpose:

- Let an admin promote a regular member to admin.

Signature:

```sql
promote_group_admin(
  p_group_id uuid,
  p_acting_admin_user_id text,
  p_target_user_id text
) returns boolean
```

Rules:

- Acting user must be an admin in the group.
- Target user must be a member in the group.
- Target must currently have role `member`.
- Promoting an existing admin should be idempotent or return success with no change.

Recommended behavior:

- If target is already admin, return `true`.
- If target is member, update role to `admin`.

Server-side validation:

1. Acting user has role `admin`.
2. Target user has membership row.
3. If target role is `admin`, return true.
4. Update target role to `admin`.

Expected outcomes:

- `true` on success.
- Error on not admin.
- Error on target missing.

Recommended known error messages:

- `not a group admin`
- `member not found`

## 4. Last Admin Protection

Last admin protection is required in:

- `leave_group`
- `remove_group_member`

Promotion does not need last-admin protection because it increases admin count.

### Rule

An active group must never be left with zero admins.

### Concurrency edge case

Two admins could attempt to leave/remove at the same time.

Recommended SQL implementation approach later:

- Run checks and mutation inside a SECURITY DEFINER function.
- Lock relevant `group_members` rows for the group while checking admin count.
- Re-count admin rows inside the same transaction/function before deleting.

Practical note:

- PL/pgSQL function execution is transactional. Use row locking where possible to prevent race conditions.

## 5. Required Repository/API Layer Changes

Add thin wrappers to the existing groups data-access layer.

Current file likely:

- `lib/groupsRepository.ts`

Suggested functions:

```ts
leaveGroup(groupId: string, currentUserId: string): Promise<{ kind: 'left' | 'lastAdmin' | 'notMember' | 'error'; message?: string }>

removeGroupMember(groupId: string, actingAdminUserId: string, targetUserId: string): Promise<{ kind: 'removed' | 'lastAdmin' | 'notAdmin' | 'notFound' | 'selfRemoval' | 'error'; message?: string }>

promoteGroupAdmin(groupId: string, actingAdminUserId: string, targetUserId: string): Promise<{ kind: 'promoted' | 'notAdmin' | 'notFound' | 'error'; message?: string }>
```

Keep wrappers small:

- Call RPC.
- Map known Postgres error messages to typed outcomes.
- Do not implement business rules only in TypeScript.

## 6. Required UI Changes

### 6.1 Group Dashboard

For all users:

- Continue showing group dashboard stats.

For members:

- Show `Leave Group` action.

For admins:

- Show `Manage Members` action.
- Show existing invite-code action.

Do not clutter dashboard with all admin actions inline. Use a separate Manage Members view or modal.

### 6.2 Manage Members Screen / Modal

Minimum viable UI:

List members:

- Name
- Role label: Admin / Member
- Today malas/count
- Lifetime malas/count
- Action menu

Actions:

For regular member row:

- Promote to Admin
- Remove Member

For admin row other than current user:

- Remove Member only if not last admin
- No demote in Phase 1

For current user row:

- Leave Group

Disabled cases:

- Last admin cannot leave.
- Last admin cannot be removed.
- Current admin cannot remove self through Remove Member.

### 6.3 Confirmation Dialogs

Leave group:

- Title: `Leave group?`
- Message: `You will no longer see this group's dashboard. Your personal Japam history will not be deleted.`
- Buttons: `Cancel`, `Leave`

Last admin leave blocked:

- Title: `Add another admin first`
- Message: `This group must have at least one admin. Promote another member before leaving.`
- Button: `OK`

Remove member:

- Title: `Remove member?`
- Message: `<Name> will no longer be part of this group. Their personal Japam history will not be deleted.`
- Buttons: `Cancel`, `Remove`

Promote member:

- Title: `Make admin?`
- Message: `<Name> will be able to invite members and manage this group.`
- Buttons: `Cancel`, `Make Admin`

### 6.4 After Successful Action

After leave:

- Refresh My Groups list.
- Navigate back to Groups list.
- Show success message: `You left the group.`

After remove:

- Refresh dashboard/member list.
- Show success message: `Member removed.`

After promote:

- Refresh dashboard/member list.
- Show success message: `Member is now an admin.`

If current user loses membership due to another device/admin action:

- Dashboard refresh should fail membership gate.
- Navigate back to Groups list with message: `You are no longer a member of this group.`

## 7. Required Validation Rules

### Server-side required

These must be enforced in RPCs:

- Acting admin is admin in group.
- Target is member of group.
- User leaving is member of group.
- No self-removal through remove RPC.
- Last admin cannot leave.
- Last admin cannot be removed.
- Promotion only applies to members of same group.

### Client-side helpful

These can improve UX but cannot be the only protection:

- Hide Promote for admins.
- Hide Remove for current user.
- Disable/remove actions if admin count is 1 and target is admin.
- Show role labels clearly.
- Show confirmation before destructive actions.

## 8. Edge Cases

### User is the only admin and only member

Allowed:

- Stay in group.

Blocked:

- Leave group.

Message:

- `This group must have at least one admin.`

Future:

- Archive group, but not Phase 1.

### User is only admin with other members

Blocked:

- Leave group.

Required flow:

- Promote another member to admin first.
- Then leave.

### Admin removes another admin

Allowed only if another admin remains.

Since demotion is not in Phase 1, removal is the only admin-role-reducing admin action besides leave.

### Member tries admin action

RPC rejects.

UI should not show admin actions.

### Removed user still has invite code

For Phase 1, they may rejoin if they still have a valid invite code.

This is acceptable for small family groups.

Invite rotation and ban list are not Phase 1.

### Offline behavior

Recommendation:

- Do not support offline group admin mutations in Phase 1.
- If offline, show: `Please connect to the internet to manage group members.`

Reason:

- Group admin actions affect other users and need server authority.
- Queuing remove/promote offline can create confusing conflict states.

### Dashboard auto-refresh

After admin action:

- Existing dashboard auto-refresh should eventually pick up changes.
- But local screen should also manually refresh immediately after RPC success.

## 9. User Experience Flow

### Leave Group Flow

1. User opens group dashboard.
2. Taps `Leave Group`.
3. Confirmation modal appears.
4. User confirms.
5. App calls `leave_group`.
6. If success:
   - return to Groups list
   - refresh groups
   - show success
7. If last admin:
   - show last-admin blocked message

### Remove Member Flow

1. Admin opens Manage Members.
2. Taps member row action.
3. Taps `Remove`.
4. Confirmation modal appears.
5. Admin confirms.
6. App calls `remove_group_member`.
7. If success:
   - refresh member list/dashboard
   - show success
8. If last admin/self/not admin:
   - show specific error

### Promote Admin Flow

1. Admin opens Manage Members.
2. Taps member row action.
3. Taps `Make Admin`.
4. Confirmation modal appears.
5. Admin confirms.
6. App calls `promote_group_admin`.
7. If success:
   - refresh member list/dashboard
   - role label changes to Admin
   - show success

## 10. Estimated Implementation Effort

### Database/RPC

Effort: Medium

Why:

- Three RPCs are straightforward.
- Last-admin protection and concurrency require careful SQL.
- Need staging verification with multiple users.

Estimated work:

- 0.5 to 1 day for SQL draft and review.
- 0.5 day for Supabase staging apply and manual checks.

### Repository Layer

Effort: Small

Why:

- Thin wrappers over RPCs.
- Error mapping only.

Estimated work:

- 0.25 to 0.5 day.

### UI

Effort: Medium

Why:

- Manage Members UI, menus, confirmations, refresh behavior.
- Must be clean on mobile.

Estimated work:

- 1 to 2 days.

### Tests / QA

Effort: Medium

Why:

- Requires at least two users to test member/admin behavior.
- Edge cases around last admin must be verified carefully.

Estimated work:

- 1 day.

### Total Phase 1 Estimate

Small team estimate:

- 3 to 5 focused days.

If keeping UI extremely minimal:

- 2 to 3 focused days.

## 11. Recommended Phase 1 Cut

Minimum viable Phase 1:

1. `leave_group`
2. `remove_group_member`
3. `promote_group_admin`
4. Manage Members screen/modal
5. Last-admin protection in RPCs

Do not include:

- demote admin
- archive group
- owner role
- invite regeneration
- audit fields
- offline admin action queue

This gives family groups and small spiritual groups the practical controls they need while keeping risk low.
