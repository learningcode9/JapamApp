// Clips the ScrollView's scroll viewport above the floating tab bar on web/PWA.
// Tab bar top on iPhone PWA: height 74 + bottom offset 12 + home-indicator safe area 34 = 120px.
// useSafeAreaInsets() returns 0 on web so the 34px safe area is baked in here.
// 128 = 120 + 8px buffer.
export const WEB_SCROLL_MARGIN_BOTTOM = 128;

// Padding for full-page layouts (Timer, Tap Japam appShell) where the content
// must clear the tab bar within an already-clipped scroll viewport.
export const WEB_BOTTOM_TAB_CLEARANCE = 160;
