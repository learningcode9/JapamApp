# Group Admin Management Design

Status: design proposal only. Do not treat this file as implementation approval. No code, migration, Supabase change, deploy, or release action is implied.

## 1. Goal

Design the future Group Admin Management model for Mantra Japam before implementation, so groups can safely support:

- Member removal
- Multiple admins
- Admin promotion/demotion
- Member leave
- Admin leave
- Group deletion/archive
- Invite-code lifecycle
- Future family, temple, mantra, and challenge groups

The design should preserve the current working model:

- Groups already exist.
- Invite codes already exist.
- Admin can retrieve invite code.
- Members can join groups.
- Dashboard auto-refresh exists.
- Group dashboard reads are gated through RPCs.
- Direct table UPDATE/DELETE from the client should remain blocked.

## 2. Current State Summary

Current schema, from `db/groups_migration.sql`:

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

Current RPC/data access:

- `create_group(name, created_by, user_name)`
- `find_group_by_invite_code(invite_code)`
- `get_my_groups(user_id)`
- `get_group_dashboard(group_id, current_user_id, today_start, today_end)`
- `get_group_invite_code(group_id, current_user_id)`

Current strengths:

- Create Group is atomic.
- Invite-code lookup does not expose the full groups table.
- Dashboard access checks membership.
- Invite-code read checks admin role.
- Client direct admin inserts are blocked.

Current limitation:

- `p_current_user_id` is still a client-supplied opaque string, not `auth.uid()`. This is already documented in the groups migration. Admin actions should still be RPC-gated now, but true identity security eventually needs auth.uid-based RLS/RPC checks.

## 3. Recommended Role Model

### Recommendation: keep `admin` and `member` for now

Do not introduce an `owner` role yet.

Use:

- `admin`
- `member`

Reason:

- The current schema already supports multiple admins.
- The product does not yet need ownership billing, legal ownership, public groups, or advanced permissions.
- Adding an owner role too early increases edge cases without immediate user value.

### Preserve `created_by` as historical creator only

`groups.created_by` should mean:

- "Who originally created this group."

It should not be treated as:

- the only admin
- mutable owner
- sole deletion authority

If ownership transfer becomes important later, add:

```text
groups.owner_user_id text nullable
```

But do not add this until a real owner-specific requirement exists.

### Future permission expansion

If group administration becomes complex, avoid adding many roles directly into `group_members.role`. Instead consider:

```text
group_permissions
- group_id
- user_id
- permission
```

or a role enum such as:

- `owner`
- `admin`
- `moderator`
- `member`

This is future-only. For now, `admin/member` is enough.

## 4. Core Invariants

Every admin-management RPC should enforce these rules server-side:

1. Every active group must have at least one admin.
2. A non-admin cannot remove, promote, demote, rename, archive, or regenerate invite code.
3. A member can leave their own group.
4. An admin can leave only if another admin remains, or they transfer/promote another admin first.
5. The last admin cannot be removed or demoted.
6. A user cannot promote/demote/remove themselves through admin actions unless the specific self-action is "leave group."
7. Inactive groups cannot accept new members.
8. Historical japam records must not be deleted when a member leaves or a group is archived.
9. Direct client UPDATE/DELETE policies should remain absent. Privileged writes should happen through SECURITY DEFINER RPCs.

These invariants matter more than UI checks. UI can help, but the database RPC must be the authority.

## 5. Member Removal

### Who can remove members?

Only admins of the same group.

Allowed:

- Admin removes a member.
- Admin removes another admin only if at least one admin remains after removal.

Not allowed:

- Member removes anyone.
- Admin removes themselves through "Remove member"; self-removal should use "Leave group."
- Admin removes the last admin.
- Anyone removes a member from an inactive/deleted group unless the action is part of archival cleanup.

### What happens to historical data?

Do not delete history.

When a member is removed:

- Remove or deactivate the `group_members` row.
- The user's `japam_history` remains intact.
- The user's personal stats remain intact.
- Past group dashboard views should stop showing that person as an active member.
- Future group totals should not include removed members unless historical group reporting is later designed.

Recommended first implementation:

- Hard-delete the membership row from `group_members`.
- Keep history untouched.

Future audit-friendly implementation:

```text
group_members.left_at timestamptz nullable
group_members.removed_by text nullable
group_members.removal_reason text nullable
group_members.status text default 'active'
```

With the current small app, hard-delete membership is simpler. If temple/challenge groups need historical rosters, use soft membership status later.

### RPC design

```text
remove_group_member(
  p_group_id uuid,
  p_acting_admin_user_id text,
  p_target_user_id text
) returns boolean
```

Server checks:

1. Acting user is admin in the group.
2. Target user is a member of the group.
3. Target user is not same as acting admin.
4. If target is admin, admin count after removal must be >= 1.
5. Delete/deactivate membership.

Expected errors:

- `not a group admin`
- `cannot remove yourself; use leave group`
- `cannot remove last admin`
- `member not found`

## 6. Multiple Admins

Current schema already supports multiple admins because `role` is a field per member.

### Promote member to admin

Who can promote:

- Any current admin.

Allowed:

- Admin promotes member to admin.

Not allowed:

- Member promotes self.
- Promoting a non-member.
- Promoting in inactive group.

RPC:

```text
promote_group_admin(
  p_group_id uuid,
  p_acting_admin_user_id text,
  p_target_user_id text
) returns boolean
```

Checks:

1. Acting user is admin.
2. Target user is existing member.
3. Target role is currently `member`.
4. Update target role to `admin`.

### Demote admin to member

Who can demote:

- Any current admin, except self-demotion should use the dedicated leave/demote-self flow if allowed.

Allowed:

- Admin demotes another admin if at least one admin remains.

Not allowed:

- Demoting the last admin.
- Demoting non-admin.
- Member demoting anyone.

RPC:

```text
demote_group_admin(
  p_group_id uuid,
  p_acting_admin_user_id text,
  p_target_user_id text
) returns boolean
```

Checks:

1. Acting user is admin.
2. Target is admin.
3. Target is not acting user for first version.
4. Admin count after demotion must be >= 1.
5. Update target role to `member`.

### Prevent group without admins

Every write path must preserve one admin:

- `remove_group_member`
- `demote_group_admin`
- `leave_group`
- `archive_group`, if archive requires admin

Implementation note for future SQL:

- Use a transaction within SECURITY DEFINER RPC.
- Count admins with `for update` locking or equivalent transactional guard to avoid two admins leaving/demoting at the same time and creating zero admins.

## 7. Leave Group

### Member leave flow

Member can leave any active group they belong to.

Behavior:

- Remove/deactivate their membership.
- Keep their japam history.
- Refresh My Groups list.
- Navigate away from dashboard if they were viewing that group.

RPC:

```text
leave_group(
  p_group_id uuid,
  p_current_user_id text
) returns boolean
```

Checks:

1. User is member of group.
2. If role is `member`, allow leave.
3. Delete/deactivate membership.

### Admin leave flow

Admin can leave only if another admin remains.

If group has multiple admins:

- Allow leave.

If admin is the last admin:

- Block leave.
- UI should show: "Add another admin before leaving this group."

Alternative future flow:

- "Choose new admin and leave" combined action.

For first implementation, keep it simple:

- Last admin cannot leave.
- They must promote someone first.

### Last admin edge cases

Cases:

1. Single admin, zero members

   Last admin cannot leave unless they archive/delete the group.

2. Single admin, several members

   Last admin must promote a member first.

3. Multiple admins

   Any admin can leave as long as at least one other admin remains.

4. Group inactive

   Leaving inactive group should probably be allowed for cleanup, but admin writes to inactive groups should be carefully scoped. For first version, allow self-leave even if inactive.

## 8. Delete Group

### Recommendation: soft delete / archive, not hard delete

Use `groups.is_active = false` for first version.

Do not hard-delete groups from client flows.

Why:

- Invite codes should stop working.
- Members should no longer see it as active.
- Historical user practice records should remain untouched.
- Future audit/reporting can still understand that a group existed.
- Hard delete plus cascade would delete membership rows and make debugging/support harder.

### Who can delete/archive?

Only admins.

For first version:

- Any admin can archive group.

Future stricter option:

- Only creator/owner can archive group.

Since there is no owner model today, "any admin" is consistent and simpler.

### What happens to historical data?

Do not touch:

- `japam_history`
- `japam_user_totals`
- user personal stats

Archive behavior:

- Set `groups.is_active = false`.
- Existing members may still see the group under archived/inactive groups if UI supports it.
- Join by invite code should return inactive and not allow join.
- Dashboard may show read-only archived state or be hidden from active list.

### Optional future fields

If archive/delete becomes real:

```text
groups.archived_at timestamptz nullable
groups.archived_by text nullable
groups.archive_reason text nullable
```

These are useful but not required for a first version if `is_active` already exists.

### RPC

```text
archive_group(
  p_group_id uuid,
  p_acting_admin_user_id text
) returns boolean
```

Checks:

1. Acting user is admin.
2. Group exists.
3. Group is active.
4. Set `is_active = false`.

Do not use `delete from groups` in first version.

## 9. Ownership Model

### Option A: admin/member only

Current model:

- `admin`
- `member`

Pros:

- Simple.
- Already supported.
- Multiple admins are easy.
- Good enough for family groups and small devotional groups.

Cons:

- No special creator/owner permissions.
- Any admin could archive/demote/remove if allowed.
- Ownership transfer is not explicit.

### Option B: owner/admin/member

Future model:

- `owner`
- `admin`
- `member`

Pros:

- Clear final authority.
- Better for temple groups, public groups, large groups.
- Ownership transfer becomes explicit.

Cons:

- More edge cases.
- More UI complexity.
- Requires schema/check constraint changes.
- Requires new RPC rules.

### Recommendation

Keep `admin/member` for now.

Do not add owner until one of these becomes true:

- Groups become public/large.
- Admin abuse/moderation becomes a concern.
- Temple/organization groups need accountable ownership.
- Billing or official group verification exists.

Near-term compromise:

- Keep `groups.created_by` as creator metadata.
- Let any admin perform admin actions.
- Prevent zero-admin state.

Future owner migration path:

1. Add `owner_user_id text nullable` to `groups`.
2. Backfill `owner_user_id = created_by`.
3. Ensure owner is also an admin/member.
4. Add owner-only RPCs if needed.

## 10. Database Impact

### No required fields for first management version

With the current schema, these can be implemented without new columns:

- Remove member: delete from `group_members`.
- Leave group: delete self from `group_members`.
- Promote admin: update `group_members.role`.
- Demote admin: update `group_members.role`.
- Archive group: update `groups.is_active = false`.
- Rename group: update `groups.name`.
- Regenerate invite code: update `groups.invite_code`.

All should be done through SECURITY DEFINER RPCs.

### Recommended RPCs

First version:

```text
leave_group(p_group_id uuid, p_current_user_id text)
remove_group_member(p_group_id uuid, p_acting_admin_user_id text, p_target_user_id text)
promote_group_admin(p_group_id uuid, p_acting_admin_user_id text, p_target_user_id text)
demote_group_admin(p_group_id uuid, p_acting_admin_user_id text, p_target_user_id text)
rename_group(p_group_id uuid, p_acting_admin_user_id text, p_new_name text)
regenerate_group_invite_code(p_group_id uuid, p_acting_admin_user_id text)
archive_group(p_group_id uuid, p_acting_admin_user_id text)
```

Optional:

```text
get_group_admin_summary(p_group_id uuid, p_current_user_id text)
```

This can return member/admin counts, current user's role, and whether actions are allowed.

### Recommended fields later

Only add these when needed:

```text
groups.archived_at timestamptz nullable
groups.archived_by text nullable
groups.owner_user_id text nullable
group_members.status text default 'active'
group_members.left_at timestamptz nullable
group_members.removed_by text nullable
```

### Index considerations

Current useful indexes:

- unique `(group_id, user_id)`
- `group_members(user_id)`
- unique `groups(invite_code)`

Possible future index:

```text
create index group_members_group_role_idx on group_members (group_id, role);
```

This helps admin-count checks and dashboards. It can wait until admin actions are implemented.

### RLS / security impact

Do not add direct anon UPDATE/DELETE policies.

Keep:

- no direct client UPDATE on `groups`
- no direct client DELETE on `groups`
- no direct client UPDATE/DELETE on `group_members`

Use SECURITY DEFINER RPCs with:

- membership checks
- admin checks
- last-admin checks
- `search_path = public`
- revoke execute from public
- grant execute only to anon, matching current model

Long-term:

- Replace client-supplied user id checks with `auth.uid()` once identity migration is ready.

## 11. UI Flow Design

### Entry points

Group dashboard should have a simple admin area if current user is admin:

- View invite code
- Manage members
- Group settings

Members see:

- Leave group
- View members/read-only dashboard

### Manage Members screen

Rows:

- Member name
- Role pill: Admin / Member
- Today malas/count
- Lifetime malas/count
- Overflow menu for actions

Admin actions per row:

For member:

- Promote to admin
- Remove from group

For another admin:

- Demote to member
- Remove from group

For self:

- Leave group

Disabled/action hidden:

- Remove/demote last admin.
- Remove self from overflow; use Leave Group.

### Confirmation modals

Promote:

- Title: "Make admin?"
- Message: "`Name` will be able to invite members and manage this group."
- Buttons: Cancel / Make Admin

Demote:

- Title: "Remove admin access?"
- Message: "`Name` will remain in the group as a member."
- Buttons: Cancel / Demote

Remove:

- Title: "Remove member?"
- Message: "`Name` will no longer be part of this group. Their personal Japam history will not be deleted."
- Buttons: Cancel / Remove

Leave:

- Title: "Leave group?"
- Message: "You will no longer see this group's dashboard."
- Buttons: Cancel / Leave

Last admin blocked:

- Title: "Add another admin first"
- Message: "This group must have at least one admin. Promote another member before leaving."

Archive group:

- Title: "Archive group?"
- Message: "The invite code will stop working and members will no longer use this group. Personal Japam history will not be deleted."
- Buttons: Cancel / Archive

### Group Settings screen

Admin-only sections:

- Group name
- Invite code
- Regenerate invite code
- Manage members
- Archive group

Member-only sections:

- Leave group

### Invite code flow

Current:

- Admin can retrieve invite code.

Future:

- Admin can regenerate invite code.
- Regeneration invalidates old code immediately.
- Show confirmation: "Old invite code will stop working."

RPC:

```text
regenerate_group_invite_code(...)
```

### After action behavior

After promote/demote/remove/leave/archive:

- Refresh group dashboard.
- Refresh My Groups list.
- Show calm toast/alert.
- If user left or was removed, navigate back to Groups list.
- If group archived, navigate back to Groups list.

## 12. Edge Cases

### Two admins act at same time

Risk:

- Both admins attempt to demote/remove each other or leave simultaneously.

Solution:

- Last-admin checks must happen inside a single database transaction.
- Ideally lock relevant `group_members` admin rows during mutation.

### User changes name

Current `group_members.user_name` is denormalized. It may become stale.

Acceptable for now.

Future:

- Add "refresh display name" on login/profile update.
- Or move to canonical `profiles` after identity migration.

### Removed member with invite code

If removed member still has invite code, they could rejoin.

Options:

1. Allow rejoin if they have code.
2. Rotate invite code when removing someone.
3. Add banned/blocked membership table.

Recommendation:

- First version: allow rejoin if they still have valid invite code.
- If abuse occurs, add invite rotation prompt after removal.
- Avoid ban list until needed.

### Inactive group invite code

`find_group_by_invite_code` already returns `is_active`.

Join flow should block inactive groups.

### Last member is last admin

If the only person in a group wants to leave:

- They cannot leave directly.
- They can archive the group.

This avoids an active group with zero admins.

## 13. Recommended Implementation Order Later

No implementation now, but when approved, build in this order:

1. Add SQL/RPC migration only
   - leave group
   - remove member
   - promote admin
   - demote admin
   - rename group
   - regenerate invite code
   - archive group

2. Add repository functions
   - thin wrappers in `lib/groupsRepository.ts`
   - typed outcomes for known errors

3. Add UI
   - Manage Members screen
   - Group Settings screen
   - confirmation modals

4. Add tests
   - last admin cannot leave
   - admin can promote
   - admin can demote another admin if another remains
   - member cannot remove
   - archive blocks invite join

5. QA on staging
   - create group
   - join with invite
   - promote/demote
   - remove
   - leave
   - archive
   - dashboard refresh

## 14. Final Recommendation

For the next version, keep the role model simple:

- `admin`
- `member`

Do not add `owner` yet.

Implement all privileged group management through SECURITY DEFINER RPCs. Do not add direct table update/delete permissions to the client. Enforce last-admin protection in the database, not just UI. Use soft delete/archive for groups. Keep user history independent from group membership so removing or archiving a group never deletes personal Japam records.

This gives the app enough group management power for family, devotional, and early temple-style groups without forcing a heavy ownership/permission system before the product needs it.
