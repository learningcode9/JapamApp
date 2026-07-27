/**
 * DIAGNOSTIC TRACE — temporary instrumentation for fetch-loop diagnosis.
 * DO NOT MERGE TO MAIN. Revert after diagnosis.
 */

let nextId = 1;
let startMark = 0;

const getNow = (): number => {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
};

export const resetTrace = () => {
  nextId = 1;
  startMark = getNow();
};

export const newRequestId = (): number => {
  const id = nextId++;
  return id;
};

export const msSinceStart = (): number => {
  if (!startMark) startMark = getNow();
  return Math.round(getNow() - startMark);
};

const pad = (n: number) => String(n).padStart(4, '0');

export type TraceEntry = {
  rid: number;
  ts: number;
  fn: string;
  caller: string;
  phase: 'ENTER' | 'EXIT' | 'EVENT' | 'FETCH_START' | 'FETCH_END';
  deps?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

const entries: TraceEntry[] = [];
const MAX_ENTRIES = 10000;

const flushEntry = (e: TraceEntry) => {
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries.shift();
  const ts = `${e.ts.toString().padStart(7)}ms`;
  const rid = `#${pad(e.rid)}`;
  const phase = `[${e.phase}]`.padEnd(14);
  const head = `${ts} ${rid} ${phase} ${e.fn}.${e.caller}`;
  const parts: string[] = [head];
  if (e.deps) parts.push(`deps=${JSON.stringify(e.deps)}`);
  if (e.extra) parts.push(JSON.stringify(e.extra));
  console.log('[DIAG]', parts.join(' '));
};

export const trace = (
  rid: number,
  fn: string,
  caller: string,
  phase: TraceEntry['phase'],
  deps?: Record<string, unknown>,
  extra?: Record<string, unknown>
) => {
  const ts = msSinceStart();
  flushEntry({ rid, ts, fn, caller, phase, deps, extra });
};

export const getTraceEntries = (): ReadonlyArray<TraceEntry> => entries;

export const dumpTraceTimeline = () => {
  console.log(`\n=== DIAGNOSTIC TIMELINE (${entries.length} entries) ===`);
  for (const e of entries) {
    const ts = `${e.ts.toString().padStart(7)}ms`;
    const rid = `#${pad(e.rid)}`;
    const phase = `[${e.phase}]`.padEnd(14);
    console.log(`${ts} ${rid} ${phase} ${e.fn}.${e.caller}`, e.extra ? JSON.stringify(e.extra) : '');
  }
  console.log('=== END TIMELINE ===\n');
};

// Flag to enable/disable tracing at runtime
export let traceEnabled = true;
export const setTraceEnabled = (v: boolean) => { traceEnabled = v; };

// Auto-register window helpers for runtime timeline dump
if (typeof window !== 'undefined') {
  (window as any).__DIAG_DUMP__ = () => {
    dumpTraceTimeline();
    console.log('\nAccess structured timeline: window.__DIAG_ENTRIES__');
    (window as any).__DIAG_ENTRIES__ = getTraceEntries();
  };
  (window as any).__DIAG_RESET__ = resetTrace;
}
