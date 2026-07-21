import { createDefaultJapamCreationCoordinator } from './defaultJapamCreationCoordinator';
import { loadJapams, createJapam as createJapamInRepo } from './japamsRepository';
import { activeJapams, type Japam } from './japams';

const coordinator = createDefaultJapamCreationCoordinator();

export async function ensureDefaultJapam(
  userId: string,
  suggestedName: string,
): Promise<Japam | null> {
  return coordinator.ensureCreation(userId, async () => {
    const existing = await loadJapams(userId);
    const active = activeJapams(existing);
    if (active.length > 0) {
      return active[0];
    }
    const result = await createJapamInRepo(userId, suggestedName);
    return result?.created ?? null;
  });
}
