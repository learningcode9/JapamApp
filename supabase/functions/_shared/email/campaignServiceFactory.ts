import { createClient } from '@supabase/supabase-js';
import type { EmailProvider } from './emailProvider';
import type { CampaignDefinition } from './campaigns/types';
import { CampaignEmailService } from './campaignService';
import { loadEmailConfig } from './config';

/** Node/CLI factory kept separate so the Deno Edge bundle has no Node-only import. */
export function createCampaignService(
  campaign: CampaignDefinition,
  emailProvider: EmailProvider | null,
): CampaignEmailService {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) env var is required');
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY env var is required');

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return new CampaignEmailService(campaign, supabase, emailProvider, loadEmailConfig());
}
