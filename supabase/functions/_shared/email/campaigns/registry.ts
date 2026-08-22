// Central lookup for every campaign. Adding a new campaign is exactly two
// lines here (import + map entry) once its content module exists — nothing
// else in the system needs to change.

import type { CampaignDefinition } from './types';
import { fifteenDayInspirationCampaign } from './fifteenDayInspiration';

export const CAMPAIGN_REGISTRY: Record<string, CampaignDefinition> = {
  [fifteenDayInspirationCampaign.id]: fifteenDayInspirationCampaign,

  // Future campaigns (welcome, 7-day encouragement, 30-day milestone,
  // 108-day celebration, re-engagement, festival greetings) register here
  // the same way — see docs/CAMPAIGN_EMAIL_ARCHITECTURE.md.
};

export function getCampaign(id: string): CampaignDefinition {
  const campaign = CAMPAIGN_REGISTRY[id];
  if (!campaign) {
    throw new Error(
      `Unknown campaign id "${id}". Registered campaigns: ${Object.keys(CAMPAIGN_REGISTRY).join(', ')}`,
    );
  }
  return campaign;
}
