import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import { Asset } from 'expo-asset';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Platform, View } from 'react-native';
import 'react-native-reanimated';
import { PaperProvider } from 'react-native-paper';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { ZEN_BACKGROUND } from '@/constants/assets';
import { repairLegacyStoredUserId } from '@/lib/anonymousAuth';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // Startup identity canonicalization: if a valid Supabase session already exists but the cached
  // USER_ID_KEY is still a legacy numeric Google subject id, repair it to the session's UUID. A
  // no-op when there's no session, the id is already a UUID, or the user is a guest — see
  // lib/anonymousAuth.ts's repairLegacyStoredUserId for the exact gating conditions.
  useEffect(() => {
    void repairLegacyStoredUserId();
  }, []);

  // Warm the background image cache in the background only. This must NEVER gate app render:
  // gating on downloadAsync() froze startup when offline (the call can hang without network and
  // never reject). The app renders immediately; the image appears once cached, over the solid bg.
  useEffect(() => {
    Asset.fromModule(ZEN_BACKGROUND).downloadAsync().catch(() => {});
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const content = notification.request.content as any;
        const isCompletion =
          content.channelId === 'japam-complete' ||
          String(content.title ?? '').toLowerCase().includes('complete');
        return {
          shouldShowAlert: isCompletion,
          shouldShowBanner: isCompletion,
          shouldShowList: true,
          shouldPlaySound: isCompletion,
          shouldSetBadge: false,
        };
      },
    });
  }, []);

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

    const setLink = (
      rel: string,
      href: string,
      options?: { sizes?: string; type?: string }
    ) => {
      let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
      }

      link.href = href;
      if (options?.sizes) link.sizes = options.sizes;
      if (options?.type) link.type = options.type;
    };

    setMeta('theme-color', '#f5fafa');
    setMeta('app-version', Constants.expoConfig?.version || '1.0.0');
    setMeta('apple-mobile-web-app-capable', 'yes');
    setMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    setMeta('apple-mobile-web-app-title', 'Mantra Japam');
    setLink('manifest', '/manifest.json');
    setLink('apple-touch-icon', '/apple-touch-icon.png', {
      sizes: '180x180',
      type: 'image/png',
    });
    setLink('icon', '/favicon-48.png', {
      sizes: '48x48',
      type: 'image/png',
    });

    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (viewport) {
      viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    }

    document.documentElement.style.height = '100%';
    document.documentElement.style.backgroundColor = '#f5fafa';
    document.body.style.height = '100%';
    document.body.style.minHeight = '100dvh';
    document.body.style.margin = '0';
    document.body.style.backgroundColor = '#f5fafa';
    document.body.style.overflow = 'hidden';

    const root = document.getElementById('root');
    if (root) {
      root.style.height = '100dvh';
      root.style.minHeight = '100dvh';
      root.style.backgroundColor = '#f5fafa';
      root.style.overflow = 'hidden';
    }

    const launchScreen = document.getElementById('launch-screen');
    if (launchScreen) {
      window.setTimeout(() => {
        launchScreen.classList.add('is-hidden');
        window.setTimeout(() => launchScreen.remove(), 460);
      }, 180);
    }

    const versionKey = 'japam-web-version';
    const currentVersion = Constants.expoConfig?.version || '1.0.0';
    const storedVersion = window.localStorage.getItem(versionKey);

    const clearWebCaches = async () => {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => /japam|expo|workbox|pwa/i.test(key))
            .map((key) => caches.delete(key))
        );
      }
    };

    const syncWebVersion = async () => {
      if (!storedVersion) {
        window.localStorage.setItem(versionKey, currentVersion);
        return;
      }

      if (storedVersion !== currentVersion) {
        await clearWebCaches();
        window.localStorage.setItem(versionKey, currentVersion);
        window.location.reload();
      }
    };

    void syncWebVersion();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!Updates.isEnabled) return;

    let mounted = true;

    const checkForNativeUpdate = async () => {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (!mounted || !update.isAvailable) return;

        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      } catch (error) {
        console.log('Update check error:', error);
      }
    };

    void checkForNativeUpdate();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void checkForNativeUpdate();
      }
    });

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#edf7f4' }}>
      <PaperProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="privacy" options={{ headerShown: false }} />
            <Stack.Screen name="delete-account" options={{ headerShown: false }} />
            <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
          </Stack>
          <StatusBar style="auto" />
        </ThemeProvider>
      </PaperProvider>
    </View>
  );
}
