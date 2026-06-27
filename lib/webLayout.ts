// Bottom clearance for ScrollView contentContainerStyle on web/PWA.
// Covers the absolute-positioned tab bar (74px) + its bottom offset on web
// where useSafeAreaInsets() returns 0 (12px) + iOS home-indicator area (34px)
// + breathing room. Plain number — avoids React Native StyleSheet dropping
// CSS calc() strings for typed numeric properties.
export const WEB_BOTTOM_TAB_CLEARANCE = 160;
