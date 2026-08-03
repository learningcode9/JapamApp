/**
 * Contract test for db/consolidate_duplicate_my_japam_rpc.sql.
 *
 * Like the other db/__tests__/*.contract.test.ts files, this is a STATIC structural
 * check of the SQL FILE itself — it never connects to a database. It guards the
 * safety contract of the explicit duplicate-consolidation RPC:
 *   - it is a SEPARATE RPC and never weakens restore_owned_japam's fail-closed rule
 *   - it locks BOTH Japam rows (SELECT ... FOR UPDATE) before any mutation
 *   - it validates ownership (auth.uid() or legacy jwt user_metadata.sub), normalized
 *     "My Japam" names, canonical archived+tombstoned, duplicate active+not-tombstoned
 *   - it fails closed on duplicate group references, duplicate tombstones, duplicate
 *     adoption markers, foreign-owned History, and completion_id collisions
 *   - it preserves History (only japam_id changes), unarchives canonical before the
 *     move (write-guard ordering), tombstones the duplicate, and writes the marker
 *   - it re-verifies post-conditions inside the transaction (exactly one active
 *     normalized "My Japam", exactly one marker, consolidated totals) and raises on drift
 *   - EXECUTE is granted to authenticated only
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL_PATH = path.resolve(__dirname, '..', 'consolidate_duplicate_my_japam_rpc.sql');

const sql = fs.readFileSync(SQL_PATH, 'utf8');

describe('db/consolidate_duplicate_my_japam_rpc.sql contract', () => {
  it('defines a separate explicit RPC with two exact Japam ids', () => {
    expect(sql).toMatch(
      /create or replace function public\.consolidate_duplicate_my_japam\(\s*p_canonical_id uuid,\s*p_duplicate_id uuid\s*\)/i
    );
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
  });

  it('does NOT modify the generic restore_owned_japam behavior', () => {
    expect(sql).not.toMatch(/create or replace function public\.restore_owned_japam/i);
    expect(sql).toMatch(/does NOT modify db\/restore_owned_japam_rpc\.sql/i);
    expect(sql).toMatch(/restore_owned_japam/i);
  });

  it('authenticates via auth.uid() or the legacy jwt user_metadata.sub', () => {
    expect(sql).toMatch(/auth\.uid\(\)::text/i);
    expect(sql).toMatch(/auth\.jwt\(\)->'user_metadata'->>'sub'/i);
    expect(sql).toMatch(/authentication required/i);
  });

  it('locks BOTH Japam rows for update before any mutation', () => {
    // canonical row lock
    expect(sql).toMatch(/from public\.japams j\s+where j\.id = p_canonical_id\s+for update/i);
    // duplicate row lock
    expect(sql).toMatch(/from public\.japams j\s+where j\.id = p_duplicate_id\s+for update/i);
  });

  it('validates ownership and identical owners', () => {
    expect(sql).toMatch(/canonical Japam is not owned by the caller/i);
    expect(sql).toMatch(/duplicate Japam is not owned by the caller/i);
    expect(sql).toMatch(/canonical and duplicate Japams have different owners/i);
  });

  it('requires both names to normalize to "my japam"', () => {
    expect(sql).toMatch(/lower\(btrim\(regexp_replace\(v_canonical_name/);
    expect(sql).toMatch(/lower\(btrim\(regexp_replace\(v_duplicate_name/);
    expect(sql).toMatch(/canonical Japam is not named My Japam/i);
    expect(sql).toMatch(/duplicate Japam is not named My Japam/i);
  });

  it('enforces the state contract (canonical archived+tombstoned, duplicate active+not tombstoned)', () => {
    expect(sql).toMatch(/canonical Japam must be archived/i);
    expect(sql).toMatch(/duplicate Japam must be active/i);
    expect(sql).toMatch(/canonical Japam tombstone is missing/i);
    expect(sql).toMatch(/duplicate Japam is already tombstoned/i);
  });

  it('fails closed on duplicate group references, markers, foreign History and collisions', () => {
    expect(sql).toMatch(/duplicate Japam has group membership/i);
    expect(sql).toMatch(/duplicate Japam has a pending adoption marker/i);
    expect(sql).toMatch(/duplicate Japam has History rows owned by another user/i);
    expect(sql).toMatch(/canonical Japam has History rows owned by another user/i);
    expect(sql).toMatch(/completion_id collision between canonical and duplicate History/i);
  });

  it('moves History in place (only japam_id) and unarchives canonical BEFORE the move', () => {
    expect(sql).toMatch(/update public\.japam_history\s+set japam_id = p_canonical_id/i);
    expect(sql).toMatch(/update public\.japams\s+set archived_at = null,\s+updated_at = now\(\)\s+where id = p_canonical_id/i);
    // The comment ordering contract: unarchive before re-pointing History.
    expect(sql).toMatch(/Unarchive the canonical BEFORE re-pointing History/i);
    expect(sql).toMatch(/get diagnostics v_moved = row_count/i);
  });

  it('archives + tombstones the duplicate and removes the canonical tombstone', () => {
    expect(sql).toMatch(/update public\.japams\s+set archived_at = now\(\),/i);
    expect(sql).toMatch(/insert into public\.deleted_japams \(japam_id, user_id, deleted_at\)\s+values \(p_duplicate_id, v_owner, now\(\)\)\s+on conflict \(japam_id\) do nothing/i);
    expect(sql).toMatch(/delete from public\.deleted_japams\s+where japam_id = p_canonical_id\s+and user_id = v_owner/i);
  });

  it('writes exactly one pending adoption marker for the canonical', () => {
    expect(sql).toMatch(/insert into public\.pending_japam_adoption \(id, user_id, japam_id, created_at\)/i);
    expect(sql).toMatch(/on conflict \(user_id, japam_id\) do update\s+set created_at = now\(\)/i);
    expect(sql).toMatch(/expected exactly one adoption marker/i);
  });

  it('re-verifies post-conditions and totals inside the transaction', () => {
    expect(sql).toMatch(/expected exactly one active normalized My Japam/i);
    expect(sql).toMatch(/History row totals did not consolidate/i);
    expect(sql).toMatch(/malas totals did not consolidate/i);
    expect(sql).toMatch(/count totals did not consolidate/i);
    expect(sql).toMatch(/duplicate Japam still has History rows/i);
  });

  it('returns detailed before/after counts and totals', () => {
    expect(sql).toMatch(/returns table \(/i);
    for (const col of [
      'before_canonical_history bigint',
      'before_canonical_malas bigint',
      'before_canonical_count bigint',
      'before_duplicate_history bigint',
      'before_duplicate_malas bigint',
      'before_duplicate_count bigint',
      'moved_history bigint',
      'after_canonical_history bigint',
      'after_canonical_malas bigint',
      'after_canonical_count bigint',
      'after_duplicate_history bigint',
      'active_normalized_my_japam bigint',
      'adoption_markers bigint',
    ]) {
      expect(sql).toMatch(new RegExp(col.replace(/\s+/g, '\\s+')));
    }
  });

  it('grants execute only to authenticated and revokes other roles', () => {
    expect(sql).toMatch(/revoke all on function public\.consolidate_duplicate_my_japam\(uuid, uuid\) from public;/i);
    expect(sql).toMatch(/revoke all on function public\.consolidate_duplicate_my_japam\(uuid, uuid\) from anon;/i);
    expect(sql).toMatch(/revoke all on function public\.consolidate_duplicate_my_japam\(uuid, uuid\) from authenticated;/i);
    expect(sql).toMatch(/grant execute on function public\.consolidate_duplicate_my_japam\(uuid, uuid\) to authenticated;/i);
  });

  it('documents the deployment order (pending_japam_adoption first)', () => {
    expect(sql).toMatch(/db\/pending_japam_adoption\.sql/i);
    expect(sql).toMatch(/1\. db\/pending_japam_adoption\.sql/i);
  });
});
