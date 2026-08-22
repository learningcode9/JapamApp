/**
 * Supabase Edge Function: send-campaign-email
 *
 * The handler preserves the deployed operator gate and delegates all
 * eligibility, stats, deduplication, rendering, and delivery behavior to the
 * merged shared campaign service.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { CampaignEmailService } from '../_shared/email/campaignService.ts';
import type { EmailProvider } from '../_shared/email/emailProvider.ts';
import type { EmailConfig } from '../_shared/email/config.ts';
import type { CampaignDefinition } from '../_shared/email/campaigns/types.ts';
import {
  assertCampaignUnsubscribeReady,
  loadEmailConfig,
  validateProductionEnv,
} from '../_shared/email/config.ts';
import { getEnv } from '../_shared/email/env.ts';
import { ResendProvider } from '../_shared/email/emailProvider.ts';
import { getCampaign } from '../_shared/email/campaigns/registry.ts';
import { isOperatorAuthorization } from '../_shared/email/operatorAuth.ts';
import { handleCampaignRequest } from './handler.ts';

Deno.serve(request =>
  handleCampaignRequest(request, {
    getEnv,
    isOperatorAuthorization,
    getCampaign,
    validateProductionEnv,
    assertCampaignUnsubscribeReady,
    loadEmailConfig,
    createSupabaseClient: (url, serviceRoleKey) =>
      createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    createEmailProvider: apiKey => new ResendProvider(apiKey),
    createCampaignService: (campaign, supabase, provider, config) =>
      new CampaignEmailService(
        campaign as CampaignDefinition,
        supabase as SupabaseClient,
        provider as EmailProvider | null,
        config as EmailConfig,
      ),
  }),
);
