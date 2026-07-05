// The contract every campaign must satisfy. This is the only file a new
// campaign's content module needs to import types from — see
// `campaigns/fifteenDayInspiration.ts` for a full example, and `registry.ts`
// for how a finished campaign gets wired in (one import + one map entry).

import type { SummaryStats } from '../types';
import type { EmailConfig } from '../config';

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
  /** Email subject line. Kept as a plain string (not a function of ctx) so every
   *  campaign's dedup/subject is predictable and greppable; personalize the
   *  greeting inside the body instead. */
  subject: string;
  buildHtml(ctx: CampaignContext): string;
  buildText(ctx: CampaignContext): string;
}
