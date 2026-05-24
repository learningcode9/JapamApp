# Mantra Japam — Play Store Release Checklist

## Pre-release testing

### Core functionality
- [ ] Timer starts, pauses, and resumes correctly
- [ ] Timer completion triggers sound + vibration
- [ ] Timer loop (auto-repeat) works for up to 5 malas
- [ ] Timer state persists across app kills (close app, reopen — timer picks up where it left off)
- [ ] Tap Japam counts correctly (increments by 1 each tap)
- [ ] Tap Japam mala completion fires sound + vibration at 108
- [ ] Tap count resets to 0 after each mala

### Persistence
- [ ] Today's mala count survives app restart (logged in)
- [ ] Timer seconds survive app restart (logged in)
- [ ] History shows correct sessions after restart
- [ ] Day streak calculates correctly

### Auth & sync
- [ ] Google Sign-In opens correctly on Android
- [ ] After sign-in, history syncs from server
- [ ] Logging out clears local state and counters
- [ ] Signing in again restores history from server
- [ ] Multiple sign-in/sign-out cycles work without data bleed

### Notifications
- [ ] Timer running notification appears in notification bar
- [ ] Timer completion notification fires (foreground and background)
- [ ] Notification permission prompt appears once (first timer use)
- [ ] Dismissing notifications doesn't break timer

### Responsive layout
- [ ] Small Android phones (e.g., 5" screen, 360dp width) — no overlap, no clipping
- [ ] Large Android phones (e.g., 6.7" screen) — layout centered and correct
- [ ] Phones with gesture navigation — tab bar not hidden behind gesture area
- [ ] Phones with 3-button navigation — tab bar visible above buttons
- [ ] Notch/punch-hole phones — no content hidden behind notch

### UX
- [ ] Bottom tab bar not overlapping screen content
- [ ] Sign-in modal opens and closes cleanly
- [ ] Settings toggles (sound, vibration) save correctly and survive restart
- [ ] History tab loads and shows correct sessions

---

## Play Store submission checklist

### App identity
- [ ] `app.json` — `name: "Mantra Japam"` (correct)
- [ ] `app.json` — `android.package: "com.japamapp.mantrajapam"` (correct)
- [ ] `app.json` — `android.versionCode` bumped for each release
- [ ] `app.json` — `version` string updated (semver: 1.0.0, 1.0.1, ...)

### Icons & assets
- [ ] Launcher icon (1024×1024 PNG, no transparency) — `assets/images/icon.png`
- [ ] Adaptive icon foreground — `assets/images/android-icon-foreground.png`
- [ ] Adaptive icon background — `assets/images/android-icon-background.png`
- [ ] Monochrome icon for themed icons (Android 13+) — `assets/images/android-icon-monochrome.png`
- [ ] Splash screen looks good (centered, correct background color `#f5fafa`)
- [ ] Play Store feature graphic (1024×500 PNG) — **TODO: create**
- [ ] Play Store screenshots (min 2, portrait) — **TODO: capture**

### Store listing
- [ ] App title: "Mantra Japam" (30 chars max)
- [ ] Short description (80 chars max) — **TODO: write**
- [ ] Full description (4000 chars max) — **TODO: write**
- [ ] App category: Health & Fitness or Lifestyle
- [ ] Content rating: Everyone
- [ ] Privacy Policy URL — **TODO: create and host**
- [ ] Contact email set in Play Console

### Permissions declared
- [ ] `VIBRATE` — for tap and timer feedback
- [ ] `POST_NOTIFICATIONS` — for timer progress and completion (Android 13+)
- [ ] `RECEIVE_BOOT_COMPLETED` — for notification scheduling reliability
- [ ] No camera, microphone, or contacts permissions

### Build
- [ ] Production build created: `eas build --platform android --profile production`
- [ ] APK or AAB tested on physical Android device
- [ ] No debug logs in production build
- [ ] ProGuard / R8 minification passes without errors

### Privacy
- [ ] Privacy Policy published at a stable URL
- [ ] Data safety form completed in Play Console:
  - Data collected: Google account (name, email, Google ID)
  - Data shared: none (stored in Supabase only)
  - Data encrypted in transit: yes (HTTPS)
  - Users can request deletion: yes (logout clears local; add email contact for server deletion)

---

## Post-release

- [ ] Monitor crash reports in Play Console
- [ ] Verify Play Store listing renders correctly
- [ ] Test install from Play Store on clean device
- [ ] Note `versionCode` used for this release
