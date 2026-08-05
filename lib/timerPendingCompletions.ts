import AsyncStorage from '@react-native-async-storage/async-storage';
import { makeLoopCompletionId } from './historyStore';

export const TIMER_PENDING_COMPLETIONS_KEY = 'timerPendingCompletions:v1';
export const TIMER_PENDING_COMPLETION_VERSION = 1;

export type PendingTimerCompletion = {
  version: 1;
  userId: string;
  sessionId: string;
  loopNumber: number;
  totalLoops: number;
  japamId: string;
  japamName: string;
  durationSeconds: number;
  completedAt: string;
  completionId: string;
};

type PendingTimerCompletionInput = Omit<PendingTimerCompletion, 'version' | 'completionId'>;

const isValidPendingCompletion = (value: unknown): value is PendingTimerCompletion => {
  const item = value as Partial<PendingTimerCompletion> | null;
  return Boolean(
    item &&
      item.version === TIMER_PENDING_COMPLETION_VERSION &&
      item.userId &&
      item.sessionId &&
      Number.isFinite(Number(item.loopNumber)) &&
      Number(item.loopNumber) > 0 &&
      Number.isFinite(Number(item.totalLoops)) &&
      Number(item.totalLoops) > 0 &&
      item.japamId &&
      item.japamName &&
      Number.isFinite(Number(item.durationSeconds)) &&
      Number(item.durationSeconds) > 0 &&
      item.completedAt &&
      item.completionId,
  );
};

export const buildPendingTimerCompletion = (
  input: PendingTimerCompletionInput,
): PendingTimerCompletion => ({
  ...input,
  version: TIMER_PENDING_COMPLETION_VERSION,
  completionId: makeLoopCompletionId(input.userId, input.sessionId, input.loopNumber),
});

export const loadPendingTimerCompletions = async (): Promise<PendingTimerCompletion[]> => {
  const raw = await AsyncStorage.getItem(TIMER_PENDING_COMPLETIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const byId = new Map<string, PendingTimerCompletion>();
    parsed.filter(isValidPendingCompletion).forEach((item) => {
      byId.set(item.completionId, item);
    });
    return [...byId.values()].sort((a, b) => {
      if (a.completedAt !== b.completedAt) return a.completedAt.localeCompare(b.completedAt);
      return a.completionId.localeCompare(b.completionId);
    });
  } catch {
    return [];
  }
};

const savePendingTimerCompletions = async (items: PendingTimerCompletion[]): Promise<void> => {
  await AsyncStorage.setItem(TIMER_PENDING_COMPLETIONS_KEY, JSON.stringify(items));
};

let pendingQueueMutation: Promise<unknown> = Promise.resolve();

const mutatePendingTimerCompletions = async (
  mutation: (items: PendingTimerCompletion[]) => PendingTimerCompletion[],
): Promise<PendingTimerCompletion[]> => {
  const run = pendingQueueMutation.then(async () => {
    const next = mutation(await loadPendingTimerCompletions()).sort((a, b) => {
      if (a.completedAt !== b.completedAt) return a.completedAt.localeCompare(b.completedAt);
      return a.completionId.localeCompare(b.completionId);
    });
    await savePendingTimerCompletions(next);
    return next;
  });
  pendingQueueMutation = run.catch(() => undefined);
  return run;
};

export const enqueuePendingTimerCompletion = async (
  item: PendingTimerCompletion,
): Promise<PendingTimerCompletion[]> => {
  return mutatePendingTimerCompletions((current) => {
    const byId = new Map<string, PendingTimerCompletion>();
    [...current, item].forEach((entry) => byId.set(entry.completionId, entry));
    return [...byId.values()];
  });
};

export const removePendingTimerCompletion = async (
  completionId: string,
): Promise<PendingTimerCompletion[]> => {
  return mutatePendingTimerCompletions((current) =>
    current.filter((item) => item.completionId !== completionId),
  );
};
