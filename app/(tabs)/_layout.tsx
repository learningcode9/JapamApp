import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { Dimensions, Platform } from 'react-native';

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
        zIndex: 100,
      } as any)
    : {
        position: 'absolute' as const,
        left: isMobile ? 16 : desktopTabLeft,
        right: isMobile ? 16 : undefined,
        bottom: isMobile ? 12 : 22,
        width: isMobile ? undefined : desktopTabWidth,
        zIndex: 100,
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
          backgroundColor: 'rgba(255,255,255,0.82)',
          borderTopColor: 'rgba(255,255,255,0.78)',
          borderTopWidth: 1,
          borderRadius: 28,
          height: isMobile ? 66 : 72,
          paddingTop: 8,
          paddingBottom: 8,
          paddingHorizontal: 8,
          shadowColor: '#0f766e',
          shadowOpacity: 0.14,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 10 },
          elevation: 16,
        },
        tabBarItemStyle: {
          borderRadius: 22,
          marginHorizontal: 2,
          paddingVertical: 2,
        },
        tabBarActiveBackgroundColor: 'rgba(15, 143, 135, 0.12)',
        tabBarLabelStyle: {
          fontSize: isMobile ? 12 : 13,
          fontWeight: '800',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />

<Tabs.Screen
  name="manual"
  options={{
    href: null,
    title: 'Manual',
    tabBarIcon: ({ color, size }) => (
      <Ionicons name="create-outline" size={size} color={color} />
    ),
  }}
/>

<Tabs.Screen
  name="history"
  options={{
    title: 'History',
    tabBarIcon: ({ color, size }) => (
      <Ionicons
        name="document-text-outline"
        size={size}
        color={color}
      />
    ),
  }}
/>

<Tabs.Screen
  name="faq"
  options={{
    title: 'Learn',
    tabBarIcon: ({ color, size }) => (
      <Ionicons name="book-outline" size={size} color={color} />
    ),
  }}
/>

<Tabs.Screen
  name="settings"
  options={{
    title: 'Settings',
    tabBarIcon: ({ color, size }) => (
      <Ionicons name="sparkles-outline" size={size} color={color} />
    ),
  }}
/>
    </Tabs>
  );
}
