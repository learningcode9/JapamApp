import { Ionicons } from '@expo/vector-icons';
import { Tabs, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Dimensions, Platform, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TimerProvider } from '../../contexts/timer-context';

// [LAYOUT_DIAG] Diagnostic-only instrumentation investigating why TimerProvider mounts twice
// on every cold start (GitHub Issues #19/#20). No behavior change — every call site is a plain
// console.log alongside existing render/effect logic. Safe to remove later: delete this block
// and grep for "[LAYOUT_DIAG]" to find and remove the remaining call sites.
const LAYOUT_DIAG_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logLayoutDiag = (event: string, data?: Record<string, unknown>) => {
  console.log('[LAYOUT_DIAG]', event, JSON.stringify({ instanceId: LAYOUT_DIAG_INSTANCE_ID, ts: Date.now(), ...data }));
};

// Anchor the tab navigator on the Timer tab so it is the initial route.
// Without this, the hidden `index` legacy "0/108 · Resume Japam" screen is the
// navigator's anchor/first route, and the hardware back button reveals it. This
// codebase's expo-router (v6) reads `anchor` (see app/_layout.tsx); paired with
// `backBehavior="initialRoute"` and declaring `timer` first below, back from
// Timer returns to Timer (already there) and exits/minimizes the app instead.
export const unstable_settings = { anchor: 'timer' };

const screenWidth = Dimensions.get('window').width;
const isMobile = screenWidth < 500;
const desktopTabWidth = 430;
const desktopTabLeft = Math.max(0, (screenWidth - desktopTabWidth) / 2);
const webTabBarStyle =
  Platform.OS === 'web'
    ? ({
        // No position:fixed — tab bar is a flex sibling to the screens container.
        // React Navigation's screens container has flex:1 and fills the remaining
        // height automatically. No per-screen bottom padding or margin hacks needed.
        alignSelf: 'center',
        width: 'calc(100% - 24px)',
        maxWidth: desktopTabWidth,
        marginBottom: 12,
        zIndex: 999,
        backdropFilter: 'blur(16px)',
      } as any)
    : null;

const tabLabel =
  (label: string) =>
  function TabBarLabel({ color, focused }: { color: string; focused: boolean }) {
    return (
      <Text
        numberOfLines={1}
        style={[styles.tabLabel, focused && styles.tabLabelActive, { color }]}
      >
        {label}
      </Text>
    );
  };

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  // [LAYOUT_DIAG] Per-mount ID, generated once per TabLayout mount via useRef's lazy
  // initializer — distinct from LAYOUT_DIAG_INSTANCE_ID, which only distinguishes JS engine
  // loads. If TabLayout mounts twice within the same JS load, this will show two different IDs.
  const layoutMountIdRef = useRef(`layout-mount-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  // [LAYOUT_DIAG] Fires on every render (not just mount), so a duplicate render without an
  // intervening mount can also be seen, not just a duplicate full mount/unmount cycle.
  logLayoutDiag('tab_layout_render', {
    mountId: layoutMountIdRef.current,
    pathname,
    anchor: 'timer',
    timerProviderRendered: true,
  });

  useEffect(() => {
    logLayoutDiag('tab_layout_mount', { mountId: layoutMountIdRef.current, pathname });
    return () => {
      logLayoutDiag('tab_layout_unmount', { mountId: layoutMountIdRef.current });
    };
  }, []);

  const nativeTabBarStyle = Platform.OS !== 'web'
    ? {
        position: 'absolute' as const,
        left: isMobile ? 16 : desktopTabLeft,
        right: isMobile ? 16 : undefined,
        bottom: isMobile ? Math.max(12, insets.bottom + 8) : Math.max(22, insets.bottom + 14),
        width: isMobile ? undefined : desktopTabWidth,
        zIndex: 999,
      }
    : null;

  const tabBarStyle = Platform.OS === 'web' ? webTabBarStyle : nativeTabBarStyle;

  return (
    <TimerProvider>
      <Tabs
        backBehavior="initialRoute"
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#0f766e',
          tabBarInactiveTintColor: '#5f7778',
          tabBarStyle: {
            ...tabBarStyle,
            backgroundColor: 'rgba(255,255,255,0.92)',
            borderTopColor: 'rgba(255,255,255,0.78)',
            borderTopWidth: 1,
            borderRadius: 28,
            height: 74,
            paddingTop: 6,
            paddingBottom: 6,
            paddingHorizontal: 6,
            overflow: 'visible',
            shadowColor: '#0f766e',
            shadowOpacity: 0.14,
            shadowRadius: 22,
            shadowOffset: { width: 0, height: 10 },
            elevation: 16,
          },
          tabBarItemStyle: {
            borderRadius: 20,
            marginHorizontal: 1,
            marginVertical: 0,
            minWidth: 58,
            paddingVertical: 4,
            paddingHorizontal: 4,
            alignItems: 'center',
            justifyContent: 'center',
          },
          tabBarActiveBackgroundColor: 'rgba(15, 143, 135, 0.12)',
        }}
      >
        <Tabs.Screen
          name="timer"
          options={{
            title: 'Timer',
            tabBarLabel: tabLabel('Timer'),
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? 'timer' : 'timer-outline'} size={focused ? 27 : 25} color={color} />
            ),
          }}
        />

        <Tabs.Screen
          name="index"
          options={{
            href: null,
          }}
        />

        <Tabs.Screen
          name="tap-japam"
          options={{
            title: 'Tap Japam',
            tabBarLabel: tabLabel('Tap Japam'),
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? 'radio-button-on' : 'radio-button-on-outline'} size={focused ? 27 : 25} color={color} />
            ),
          }}
        />

        <Tabs.Screen
          name="manual"
          options={{
            href: null,
            title: 'Manual',
            tabBarLabel: tabLabel('Manual'),
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name="create-outline" size={focused ? 30 : 28} color={color} />
            ),
          }}
        />

        <Tabs.Screen
          name="history"
          options={{
            title: 'History',
            tabBarLabel: tabLabel('History'),
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name="document-text-outline" size={focused ? 27 : 25} color={color} />
            ),
          }}
        />


        <Tabs.Screen
          name="groups"
          options={{
            title: 'Groups',
            tabBarLabel: tabLabel('Groups'),
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? 'people' : 'people-outline'} size={focused ? 27 : 25} color={color} />
            ),
          }}
        />

        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarLabel: tabLabel('Settings'),
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name="sparkles-outline" size={focused ? 27 : 25} color={color} />
            ),
          }}
        />

        <Tabs.Screen
          name="groups-dashboard"
          options={{
            href: null,
          }}
        />

        <Tabs.Screen
          name="faq"
          options={{
            href: null,
          }}
        />
      </Tabs>
    </TimerProvider>
  );
}

const styles = StyleSheet.create({
  tabLabel: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
    marginTop: 3,
  },
  tabLabelActive: {
    fontSize: 12,
    fontWeight: '800',
  },
});
