import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import 'react-native-reanimated';

import { PaperProvider } from 'react-native-paper';

import { useColorScheme } from '@/hooks/use-color-scheme';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    const setMeta = (name: string, content: string) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = name;
        document.head.appendChild(meta);
      }
      meta.content = content;
    };

    setMeta('theme-color', '#05010c');
    setMeta('apple-mobile-web-app-capable', 'yes');
    setMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    setMeta('apple-mobile-web-app-title', 'Mantra Japam');

    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (viewport) {
      viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    }

    document.documentElement.style.height = '100%';
    document.documentElement.style.backgroundColor = '#05010c';
    document.body.style.height = '100%';
    document.body.style.minHeight = '100dvh';
    document.body.style.margin = '0';
    document.body.style.backgroundColor = '#05010c';
    document.body.style.overflow = 'hidden';

    const root = document.getElementById('root');
    if (root) {
      root.style.height = '100dvh';
      root.style.minHeight = '100dvh';
      root.style.backgroundColor = '#05010c';
      root.style.overflow = 'hidden';
    }
  }, []);

  return (
    <PaperProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        </Stack>
        <StatusBar style="auto" />
      </ThemeProvider>
    </PaperProvider>
  );
}
