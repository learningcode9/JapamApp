// The contract every campaign must satisfy. This is the only file a new
// campaign's content module needs to import types from — see
// `campaigns/fifteenDayInspiration.ts` for a full example, and `registry.ts`
// for how a finished campaign gets wired in (one import + one map entry).

import type { SummaryStats } from '../types.ts';
import type { EmailConfig } from '../config.ts';

export interface CampaignContext {
  stats: SummaryStats;
  /** All-time total malas for this user, independent of the campaign's period window. */
  lifetimeTotalMalas: number;
  config: EmailConfig;
}

export interface CampaignDefinition {
  /** Stable identifier — stored as `email_type` in `user_email_summaries` for dedup. */
  id: string;
  /** How often (in days) this campaign's sending window repeats. */
  periodDays: number;
  /** Default email subject line used when the campaign has no contextual subject. */
  subject: string;
  /** Optional subject selection based on the already-computed campaign context. */
  getSubject?(ctx: CampaignContext): string;
  buildHtml(ctx: CampaignContext): string;
  buildText(ctx: CampaignContext): string;
}
