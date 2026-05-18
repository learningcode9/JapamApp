import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { Dimensions, Platform, StyleSheet, Text } from 'react-native';

const screenWidth = Dimensions.get('window').width;
const isMobile = screenWidth < 500;
const desktopTabWidth = 430;
const desktopTabLeft = Math.max(0, (screenWidth - desktopTabWidth) / 2);
const fixedWebTabBarStyle =
  Platform.OS === 'web'
    ? ({
        position: 'fixed',
        bottom: 'calc(12px + env(safe-area-inset-bottom))',
        left: '50%',
        right: undefined,
        width: 'calc(100% - 24px)',
        maxWidth: desktopTabWidth,
        transform: 'translateX(-50%)',
        zIndex: 999,
        backdropFilter: 'blur(16px)',
      } as any)
    : {
        position: 'absolute' as const,
        left: isMobile ? 16 : desktopTabLeft,
        right: isMobile ? 16 : undefined,
        bottom: isMobile ? 12 : 22,
        width: isMobile ? undefined : desktopTabWidth,
        zIndex: 999,
      };

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
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#0f766e',
        tabBarInactiveTintColor: '#5f7778',
        tabBarStyle: {
          ...fixedWebTabBarStyle,
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
        name="index"
        options={{
          title: 'Home',
          tabBarLabel: tabLabel('Home'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name="home-outline" size={focused ? 27 : 25} color={color} />
          ),
        }}
      />

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
  name="faq"
  options={{
    title: 'Learn',
    tabBarLabel: tabLabel('Learn'),
    tabBarIcon: ({ color, focused }) => (
      <Ionicons name="book-outline" size={focused ? 27 : 25} color={color} />
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
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 14,
    marginTop: 3,
  },
  tabLabelActive: {
    fontWeight: '700',
  },
});
