# READ_PHONE_STATE Permission — Purpose and Disclosure

This document is the justification reference for the Play Console Permissions
Declaration Form, and the source of truth for what this permission is (and
is not) used for in Mantra Japam.

## Why the app requests this permission

The Japam timer runs as an Android foreground service so a session can keep
counting down with the screen off or the app backgrounded. Without this
permission, an incoming phone call has no effect on the running timer — the
countdown keeps going while the user is on the call, so the session can
finish (or show far less remaining time than expected) by the time they
return. `READ_PHONE_STATE` lets the app detect that a call is ringing or
active and automatically pause the timer at that exact moment, preserving
the remaining time so the user can resume manually once the call ends.

This is the only Android API that can observe call state. There is no
alternative, lighter-weight, or non-sensitive permission that provides this
signal reliably (an `AudioManager`-based approach was evaluated and rejected
— see the investigation history on `feature/timer-pause-on-interruption` —
because it requires holding audio focus for the session's whole duration,
which risks ducking/pausing the user's own music or other audio, and is
documented as unreliable for detecting another app's call state while
backgrounded).

## What is read

Only the call **state** — ringing, active/off-hook, or idle — via
`TelephonyManager`/`TelephonyCallback` (Android 12+) or the legacy
`PhoneStateListener` (Android 7–11). The legacy listener's callback
signature includes a `phoneNumber` parameter; **it is explicitly ignored and
never read, logged, or stored** (see the comment at its declaration in
`android-native/JapamTimerService.kt`).

## What is explicitly NOT read, stored, or shared

- No phone numbers (incoming, outgoing, or otherwise).
- No call logs or call history.
- No contacts.
- No device identifiers (IMEI, subscriber ID, SIM serial, etc.) — the app
  never calls any of the identifier-returning `TelephonyManager` methods.
- Nothing about calls is ever written to disk, `AsyncStorage`, analytics,
  or any backend. The only observable effect is the timer pausing.

## When the listener is active

Only while a Japam timer session is actually running (registered on session
start/resume, unregistered immediately on pause — whether that pause was
manual or the automatic call-triggered pause — and on stop/completion). The
app never listens to call state when no timer session is active, and never
requests this permission at app launch.

## User-facing disclosure

Shown as an in-app dialog *before* the system permission prompt, the first
time a user starts a timer session (never at launch, never repeated once
answered):

> **Pause automatically during calls**
> Japam App can pause your timer the moment a call comes in, so you never
> lose track of your session. Your call details are never stored, viewed,
> or shared — only whether a call is active.

## Graceful degradation

If the permission is denied (or the user picks "Not now" on the in-app
rationale before ever seeing the system dialog), the app is fully
functional: manual pause via the in-app button and the persistent
notification's Pause action both work exactly as they do today. The native
service independently checks its own permission grant before attempting to
register any listener, so a missing/denied permission cannot crash or block
starting, pausing, or resuming a session.
