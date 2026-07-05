// ─── Supabase row shape (japam_history table) ────────────────────────────────

export interface JapamHistoryRow {
  user_id: string;
  user_name: string | null;
  /** Number of mala rounds completed in this session. */
  malas: number;
  /** Total individual chant count = malas × 108. */
  count: number;
  created_at: string;
  completion_id: string;
  /** Optional — only present if `source` column exists in japam_history. */
  source?: 'timer' | 'tap' | 'manual' | string | null;
}

// ─── Auth user (from Supabase auth.users via admin API) ──────────────────────

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
}

// ─── Stats computed from history rows ─────────────────────────────────────────

export interface DailyStats {
  date: string;   // YYYY-MM-DD
  sessions: number;
  malas: number;
}

export interface SourceBreakdown {
  timer: number;
  tap: number;
  manual: number;
}

export interface SummaryStats {
  userId: string;
  email: string;
  userName: string;
  periodStart: string;  // YYYY-MM-DD
  periodEnd: string;    // YYYY-MM-DD
  /** Total practice sessions (row count). */
  totalSessions: number;
  /** Total mala rounds across all sessions. */
  totalMalas: number;
  /** Count of distinct dates with at least one session. */
  daysPracticed: number;
  /** Longest run of consecutive active days within the period. */
  longestStreak: number;
  /** Average mala rounds per active day. */
  averageMalasPerActiveDay: number;
  bestDay: DailyStats | null;
  /** Only populated when source column exists in japam_history. */
  breakdown: SourceBreakdown | null;
}

// ─── Email provider abstraction ───────────────────────────────────────────────

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  messageId: string;
}

// ─── Tracking table row (user_email_summaries) ────────────────────────────────

export type EmailStatus = 'pending' | 'sent' | 'failed' | 'dry_run';

export interface EmailSummaryRecord {
  id?: number;
  user_id: string;
  email_type: string;
  period_start: string;
  period_end: string;
  sent_at: string | null;
  status: EmailStatus;
  provider_message_id: string | null;
  error: string | null;
  created_at?: string;
}

// ─── Service I/O ──────────────────────────────────────────────────────────────

export interface SummaryRunOptions {
  dryRun: boolean;
  periodDays?: number;
  /** Skip the duplicate check and re-send regardless. */
  forceResend?: boolean;
}

export type ResultStatus =
  | 'sent'
  | 'dry_run'
  | 'skipped_no_activity'
  | 'skipped_duplicate'
  | 'skipped_too_new'
  | 'failed';

export interface SummaryRunResult {
  userId: string;
  email: string;
  status: ResultStatus;
  reason?: string;
  messageId?: string;
}
