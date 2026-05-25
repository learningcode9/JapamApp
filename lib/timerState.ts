// Shared singleton for timer state — readable by both React context and background task.
// All fields are plain values; no React state, no hooks.

export type SoundObject = {
  stopAsync: () => Promise<any>;
  setPositionAsync: (ms: number) => Promise<any>;
  setVolumeAsync: (v: number) => Promise<any>;
  setIsLoopingAsync: (loop: boolean) => Promise<any>;
  playAsync: () => Promise<any>;
  setOnPlaybackStatusUpdate: (cb: ((s: any) => void) | null) => void;
};

type TimerSharedState = {
  startedAt: number | null;       // wall-clock ms when the current mala started
  durationSeconds: number;         // seconds per mala
  completedLoops: number;          // how many malas done so far
  totalLoops: number;              // total malas requested
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  soundObject: SoundObject | null; // loaded expo-av Sound
  appIsActive: boolean;            // true when React Native app is foregrounded
  isCompleting: boolean;           // guards against double-processing a loop completion
  userId: string;
  lastSavedCompletedLoops: number; // how many loops have already been persisted to storage
};

const state: TimerSharedState = {
  startedAt: null,
  durationSeconds: 600,
  completedLoops: 0,
  totalLoops: 1,
  soundEnabled: true,
  vibrationEnabled: true,
  soundObject: null,
  appIsActive: true,
  isCompleting: false,
  userId: '',
  lastSavedCompletedLoops: 0,
};

export function getTimerState(): Readonly<TimerSharedState> {
  return state;
}

export function updateTimerState(patch: Partial<TimerSharedState>): void {
  Object.assign(state, patch);
}

export function computeTimeLeft(): number {
  if (!state.startedAt) return state.durationSeconds;
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  return Math.max(0, state.durationSeconds - elapsed);
}

export function computeMalaLabel(): string {
  const active = Math.min(state.totalLoops, state.completedLoops + 1);
  return `Mala ${active} / ${state.totalLoops}`;
}
