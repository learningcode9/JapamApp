import { useEffect, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  DisplayProfileSyncController,
  DisplayProfileSyncLifecycle,
  type DisplayProfileSession,
} from '@/lib/displayProfileSync';
import { supabase } from '@/lib/supabase';

const toSyncSession = (session: Session | null): DisplayProfileSession => session;

/**
 * The only Phase 2 application integration point for canonical profile sync.
 * It renders nothing and intentionally leaves every legacy name cache and screen
 * data path unchanged.
 */
export function DisplayProfileSyncRunner() {
  const lifecycleRef = useRef<DisplayProfileSyncLifecycle | null>(null);
  const disposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = new DisplayProfileSyncLifecycle(new DisplayProfileSyncController());
  }

  useEffect(() => {
    const lifecycle = lifecycleRef.current!;
    if (disposeTimerRef.current) {
      clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = null;
    }
    let active = true;

    const scheduleAuthEvent = (session: Session | null, event: string) => {
      if (!active) return;
      // Do not await Supabase work in this callback. The SDK warns that doing so
      // can deadlock its auth lock; the lifecycle/controller own dedupe and retry.
      void lifecycle.handleAuthEvent(event, toSyncSession(session));
    };

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      void lifecycle.handleInitialSession(toSyncSession(data.session), !!error);
    }).catch(() => {
      if (active) void lifecycle.handleInitialSession(null, true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      scheduleAuthEvent(session, event);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
      // Strict Mode replays effects in development. Deferring disposal by one
      // task lets the replay retain its in-flight guard while a true unmount
      // still cancels timers/subscription state promptly.
      disposeTimerRef.current = setTimeout(() => lifecycle.dispose(), 0);
    };
  }, []);

  return null;
}
