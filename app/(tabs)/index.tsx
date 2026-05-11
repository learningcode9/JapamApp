import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Google from 'expo-auth-session/providers/google';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';


import {
  Alert,
  Animated,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';

import { getRandomQuote } from '@/constants/quotes';

WebBrowser.maybeCompleteAuthSession();

type Session = {
  date: string;
  malas: number;
  totalCount: number;
  duration: number;
  manual?: boolean;
  userId?: string;
};

const COUNT_KEY = 'count';
const MALAS_KEY = 'malas';
const TOTAL_KEY = 'totalCount';
const HISTORY_KEY = 'history';
const JAPAM_NAME_KEY = 'japamName';
const LAST_OPEN_DATE_KEY = 'lastOpenDate';
const SOUND_ENABLED_KEY = 'soundEnabled';
const VIBRATION_ENABLED_KEY = 'vibrationEnabled';
const USER_NAME_KEY = 'userName';
const USER_ID_KEY = 'userId';
const AUTH_PENDING_KEY = 'authPending';
const AUTH_PENDING_MAX_MS = 2 * 60 * 1000;
const particleAnim = useRef(new Animated.Value(0)).current;
const omPulseAnim = useRef(new Animated.Value(1)).current;

const screenWidth = Dimensions.get('window').width;
const isMobile = screenWidth < 500;


const getLocalDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const isSameLocalDay = (dateValue: string, dayKey = getLocalDateKey()) => {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return getLocalDateKey(d) === dayKey;
};

const getTodayRange = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
};

const getUserStorageKey = (key: string, userId: string) => `${key}:${userId}`;

const isAuthPending = async () => {
  const raw = await AsyncStorage.getItem(AUTH_PENDING_KEY);
  const startedAt = Number(raw || 0);

  if (!startedAt) return false;

  if (Date.now() - startedAt > AUTH_PENDING_MAX_MS) {
    await AsyncStorage.removeItem(AUTH_PENDING_KEY);
    return false;
  }

  return true;
};

export default function JapamMain() {
  const [showUserMenu, setShowUserMenu] = useState(false);

  const [count, setCount] = useState(0);
  const [malas, setMalas] = useState(0);
  const [total, setTotal] = useState(0);

  const [seconds, setSeconds] = useState(0);
  const [minutesInput, setMinutesInput] = useState('1');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [isRunning, setIsRunning] = useState(false);
  const [loopTimer, setLoopTimer] = useState(false);
  const [, setAutoCompletedMalas] = useState(0);

  const [japamName, setJapamName] = useState('Japam');
  const [nameInput, setNameInput] = useState('');
  const [showNameEditor, setShowNameEditor] = useState(false);

  const [userName, setUserName] = useState('');
  const [showUserModal, setShowUserModal] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const googleRedirectUri =
  Platform.OS === 'web' && typeof window !== 'undefined'
    ? window.location.origin
    : undefined;

const [request, response, promptAsync] = Google.useAuthRequest({
  clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
  scopes: ['profile', 'email'],
  redirectUri: googleRedirectUri,
});

  const [quote, setQuote] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

const totalRef = useRef(0);
const isSavingSessionRef = useRef(false);
const lastTapRef = useRef(0);

const pressAnim = useRef(new Animated.Value(0)).current;
const fade = useRef(new Animated.Value(0)).current;
const glowAnim = useRef(new Animated.Value(0)).current;

  const restoreTotal = useCallback(
    async (
      nextTotal: number,
      options?: {
        userId?: string | null;
      }
    ) => {
    const safeTotal = Math.max(0, Math.floor(Number(nextTotal) || 0));
    const nextMalas = Math.floor(safeTotal / 108);
    const nextCount = safeTotal % 108;
    const activeUserId =
      options?.userId === undefined
        ? await AsyncStorage.getItem(USER_ID_KEY)
        : options.userId;

    totalRef.current = safeTotal;
    setTotal(safeTotal);
    setMalas(nextMalas);
    setCount(nextCount);

    await AsyncStorage.setItem(TOTAL_KEY, String(safeTotal));
    await AsyncStorage.setItem(MALAS_KEY, String(nextMalas));
    await AsyncStorage.setItem(COUNT_KEY, String(nextCount));

    if (activeUserId) {
      await AsyncStorage.setItem(
        getUserStorageKey(TOTAL_KEY, activeUserId),
        String(safeTotal)
      );
      await AsyncStorage.setItem(
        getUserStorageKey(MALAS_KEY, activeUserId),
        String(nextMalas)
      );
      await AsyncStorage.setItem(
        getUserStorageKey(COUNT_KEY, activeUserId),
        String(nextCount)
      );
    }
  },
    []
  );

  const getLocalTodayTotal = useCallback(async (userIdOverride?: string | null) => {
    const today = getLocalDateKey();
    const savedUserId =
      userIdOverride === undefined
        ? await AsyncStorage.getItem(USER_ID_KEY)
        : userIdOverride;

    if (!savedUserId) return 0;

    const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
    const history: Session[] = rawHistory ? JSON.parse(rawHistory) : [];

    const todayHistoryTotal = history
      .filter((item) => {
        if (!savedUserId || item.userId !== savedUserId) return false;
        return isSameLocalDay(item.date, today);
      })
      .reduce((sum, item) => sum + (Number(item.totalCount) || 0), 0);

    const savedCount = Number(
      (await AsyncStorage.getItem(getUserStorageKey(COUNT_KEY, savedUserId))) ||
        '0'
    );
    const savedMalas = Number(
      (await AsyncStorage.getItem(getUserStorageKey(MALAS_KEY, savedUserId))) ||
        '0'
    );
    const savedTotal = Number(
      (await AsyncStorage.getItem(getUserStorageKey(TOTAL_KEY, savedUserId))) ||
        '0'
    );

    return Math.max(savedTotal, todayHistoryTotal, savedMalas * 108 + savedCount);
  }, []);

  const fetchTodayTotalFromSupabase = useCallback(
    async (userId: string, userNameForFallback?: string | null) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key || !userId) return null;

    try {
      const { start, end } = getTodayRange();

      const fetchBy = async (field: 'user_id' | 'user_name', value: string) => {
        const query = new URLSearchParams({
          select: 'count',
          [field]: `eq.${value}`,
          created_at: `gte.${start}`,
        });

        query.append('created_at', `lt.${end}`);

        const result = await fetch(`${url}/rest/v1/japam_history?${query.toString()}`, {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
          },
        });

        if (!result.ok) {
          console.log('Supabase fetch error:', await result.text());
          return null;
        }

        const rows: { count?: number | string }[] = await result.json();
        return rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
      };

      const byUserId = await fetchBy('user_id', userId);
      const byUserName = userNameForFallback
        ? await fetchBy('user_name', userNameForFallback)
        : null;

      if (byUserId === null) return byUserName;
      if (byUserName === null) return byUserId;

      return Math.max(byUserId, byUserName);
    } catch (error) {
      console.log('Supabase today total error:', error);
      return null;
    }
  },
    []
  );

  const restoreTodayTotal = useCallback(async () => {
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
    const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
    const localTodayTotal = await getLocalTodayTotal(savedUserId);

    if (savedUserId) {
      const remoteTodayTotal = await fetchTodayTotalFromSupabase(
        savedUserId,
        savedUserName
      );

      if (remoteTodayTotal !== null) {
        await restoreTotal(Math.max(localTodayTotal, remoteTodayTotal), {
          userId: savedUserId,
        });
        return;
      }
    }

    await restoreTotal(localTodayTotal, { userId: savedUserId });
  }, [fetchTodayTotalFromSupabase, getLocalTodayTotal, restoreTotal]);

  useFocusEffect(
    useCallback(() => {
      const loadSettingsAndRestoreToday = async () => {
        const savedSound = await AsyncStorage.getItem(SOUND_ENABLED_KEY);
        const savedVibration = await AsyncStorage.getItem(VIBRATION_ENABLED_KEY);

        setSoundEnabled(savedSound !== 'false');
        setVibrationEnabled(savedVibration !== 'false');

        await restoreTodayTotal();
      };

      void loadSettingsAndRestoreToday();
    }, [restoreTodayTotal])
  );

  useEffect(() => {
    setQuote(getRandomQuote());

    Animated.timing(fade, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, [fade]);

  useEffect(() => {
    const loadData = async () => {
      const today = getLocalDateKey();
      
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
      const authPending = await isAuthPending();

      if (savedUserId) {
        const userJapamName = await AsyncStorage.getItem(
          getUserStorageKey(JAPAM_NAME_KEY, savedUserId)
        );
      
        if (userJapamName) {
          setJapamName(userJapamName);
          setNameInput(userJapamName);
        } else {
          setJapamName('Japam');
          setNameInput('Japam');
        }
      }

      if (savedUserName && savedUserId) {
        setUserName(savedUserName);
        setShowUserModal(false);
        await restoreTodayTotal();
      } else {
        setUserName('');
        setIsSigningIn(authPending);
        setShowUserModal(false);
        await restoreTotal(0);
      }

      await AsyncStorage.setItem(LAST_OPEN_DATE_KEY, today);
    };

    void loadData();
  }, [restoreTodayTotal, restoreTotal]);
  const loadJapamNameFromSupabase = async (googleUserId: string) => {
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  
      if (!supabaseUrl || !supabaseKey) return;
  
      const encodedUserId = encodeURIComponent(googleUserId);
  
      const profileResponse = await fetch(
        `${supabaseUrl}/rest/v1/user_profiles?user_id=eq.${encodedUserId}&select=japam_name`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        }
      );
  
      const rows = await profileResponse.json();
  
      if (rows?.length > 0 && rows[0]?.japam_name) {
        setJapamName(rows[0].japam_name);
        setNameInput(rows[0].japam_name);
      
        await AsyncStorage.setItem(
          getUserStorageKey(JAPAM_NAME_KEY, googleUserId),
          rows[0].japam_name
        );
      
        return;
      }
      
      const localName = await AsyncStorage.getItem(
        getUserStorageKey(JAPAM_NAME_KEY, googleUserId)
      );
      
      if (localName) {
        setJapamName(localName);
        setNameInput(localName);
      }
    } catch (error) {
      console.log('Profile fetch error:', error);
    }
  };
  const restoreHistoryFromSupabase = async (googleUserId: string) => {
    try {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  
      if (!supabaseUrl || !supabaseKey) return;
  
      const encodedUserId = encodeURIComponent(googleUserId);
  
      const response = await fetch(
        `${supabaseUrl}/rest/v1/japam_history?user_id=eq.${encodedUserId}&select=*&order=created_at.asc`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        }
      );
  
      if (!response.ok) {
        console.log('History restore error:', await response.text());
        return;
      }
  
      const rows = await response.json();
  
      const remoteHistory: Session[] = rows.map((item: any) => ({
        date: item.created_at,
        malas: Number(item.malas) || 0,
        totalCount: Number(item.count) || 0,
        duration: 0,
        manual: false,
        userId: googleUserId,
      }));
  
      const rawLocal = await AsyncStorage.getItem(HISTORY_KEY);
      const localHistory: Session[] = rawLocal ? JSON.parse(rawLocal) : [];
  
      const sameUserLocalHistory = localHistory.filter(
        (item) => item.userId === googleUserId
      );
  
      const mergedMap = new Map<string, Session>();
  
      [...remoteHistory, ...sameUserLocalHistory].forEach((item) => {
        const key = `${item.date}-${item.totalCount}-${item.malas}-${item.manual ? 'manual' : 'auto'}`;
        mergedMap.set(key, item);
      });
  
      const mergedHistory = [...mergedMap.values()].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
  
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));
  
      await restoreTodayTotal();
    } catch (error) {
      console.log('History restore error:', error);
    }
  };
  useEffect(() => {
    const handleGoogleLogin = async () => {
      if (!response) return;

      if (response.type !== 'success') {
        setIsSigningIn(false);
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);

        if (!savedUserId) {
          setShowUserModal(true);
        }

        return;
      }

      setIsSigningIn(true);
      setShowUserModal(false);

      const { authentication } = response;
      const accessToken =
        authentication?.accessToken ||
        ('params' in response ? response.params?.access_token : undefined);

      if (!accessToken) {
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        setIsSigningIn(false);
        setShowUserModal(true);
        return;
      }

      try {
        const userInfoResponse = await fetch(
          'https://www.googleapis.com/userinfo/v2/me',
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        const userInfo = await userInfoResponse.json();

        const googleName =
          userInfo?.given_name || userInfo?.name || userInfo?.email || 'User';
          const googleUserId = String(userInfo?.id || '').trim();

        
        if (!googleUserId) {
          setShowUserModal(true);
          return;
        }

        setUserName(googleName);
        setShowUserModal(false);
        setShowUserMenu(false);

        await AsyncStorage.setItem(USER_NAME_KEY, googleName);
        await AsyncStorage.setItem(USER_ID_KEY, googleUserId);
        await loadJapamNameFromSupabase(googleUserId);
        await restoreHistoryFromSupabase(googleUserId);
        } catch (error) {
        console.log('Google login error:', error);
        setShowUserModal(true);
      } finally {
        await AsyncStorage.removeItem(AUTH_PENDING_KEY);
        setIsSigningIn(false);
      }
    };

    void handleGoogleLogin();
  }, [response]);

  useEffect(() => {
    totalRef.current = total;

    void (async () => {
      await AsyncStorage.setItem(COUNT_KEY, String(count));
      await AsyncStorage.setItem(MALAS_KEY, String(malas));
      await AsyncStorage.setItem(TOTAL_KEY, String(total));

      const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);

      if (savedUserId) {
        await AsyncStorage.setItem(
          getUserStorageKey(COUNT_KEY, savedUserId),
          String(count)
        );
        await AsyncStorage.setItem(
          getUserStorageKey(MALAS_KEY, savedUserId),
          String(malas)
        );
        await AsyncStorage.setItem(
          getUserStorageKey(TOTAL_KEY, savedUserId),
          String(total)
        );
      }
    })();
  }, [count, malas, total]);

  useEffect(() => {
    if (!isRunning) return;
  
    const interval = setInterval(() => {
      setSeconds((prev) => prev + 1);
    }, 1000);
  
    return () => clearInterval(interval);
  }, [isRunning]);
  
  useEffect(() => {
    if (!isRunning) return;
    if (seconds < targetSeconds) return;
  
    completeTimerSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, isRunning, targetSeconds, loopTimer]);
  
  useEffect(() => {
    Animated.loop(
      Animated.timing(particleAnim, {
        toValue: 1,
        duration: 6000,
        useNativeDriver: true,
      })
    ).start();
  }, []);
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(omPulseAnim, {
          toValue: 1.03,
          duration: 1800,
          useNativeDriver: true,
        }),
        Animated.timing(omPulseAnim, {
          toValue: 1,
          duration: 1800,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [omPulseAnim]);
  const playCompleteSound = async () => {
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('../../assets/om_complete.mp3'),
        {
          shouldPlay: true,
          volume: 1.0,
        }
      );
  
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.setOnPlaybackStatusUpdate(null);
          sound.unloadAsync().catch(console.log);
        }
      });
  
      await sound.playAsync();
      setTimeout(() => {
        sound.stopAsync().catch(console.log);
        sound.unloadAsync().catch(console.log);
      }, 3000);
    } catch (error) {
      console.log('Sound error:', error);
    }
  };


  const saveSession = useCallback(async (
    duration: number,
    sessionMalas: number,
    sessionTotal: number,
    accumulatedTotal: number
  ) => {
    if (isSavingSessionRef.current) return;
  
    isSavingSessionRef.current = true;
  
    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      const history: Session[] = raw ? JSON.parse(raw) : [];
      const userId = await AsyncStorage.getItem(USER_ID_KEY);
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
  
      const session: Session = {
        date: new Date().toISOString(),
        malas: sessionMalas,
        totalCount: sessionTotal,
        duration,
        manual: false,
        userId: userId || undefined,
      };
  
      await AsyncStorage.setItem(
        HISTORY_KEY,
        JSON.stringify([session, ...history])
      );
  
      if (!userId) return;
  
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  
      if (url && key) {
        const baseBody = {
          user_name: savedUserName || userName,
          malas: sessionMalas,
          count: sessionTotal,
        };
  
        const postHistory = async (body: Record<string, unknown>) => {
          const response = await fetch(`${url}/rest/v1/japam_history`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: key,
              Authorization: `Bearer ${key}`,
              Prefer: 'return=minimal',
            },
            body: JSON.stringify(body),
          });
  
          if (!response.ok) {
            console.log('Supabase save error:', await response.text());
            return false;
          }
  
          return true;
        };
  
        const savedWithUserId = await postHistory({
          user_id: userId,
          ...baseBody,
        });
  
        if (!savedWithUserId) {
          await postHistory(baseBody);
        }
      }
    } catch (error) {
      console.log('Supabase save error:', error);
    } finally {
      isSavingSessionRef.current = false;
    }
  },[userName]);
  

  const playCompletionAnimation = () => {
    glowAnim.setValue(0);

    Animated.sequence([
      Animated.timing(glowAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: false,
      }),
      Animated.timing(glowAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: false,
      }),
      Animated.timing(glowAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: false,
      }),
      Animated.timing(glowAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: false,
      }),
    ]).start();
  };

  const tapFeedback = () => {
    if (Platform.OS !== 'web' && vibrationEnabled) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const completeFeedback = useCallback(async () => {
    if (soundEnabled) {
      await playCompleteSound();
    }
  
    if (vibrationEnabled) {
      Vibration.vibrate(700);
    }
  }, [soundEnabled, vibrationEnabled]);

  const setCountersFromTotal = (nextTotal: number) => {
    const safeTotal = Math.max(0, Math.floor(Number(nextTotal) || 0));

    totalRef.current = safeTotal;
    setTotal(safeTotal);
    setMalas(Math.floor(safeTotal / 108));
    setCount(safeTotal % 108);

    return safeTotal;
  };

  const handleUndo = () => {
    setCountersFromTotal(Math.max(0, totalRef.current - 1));
  };

  const playPressAnimation = () => {
    pressAnim.setValue(0);

    Animated.sequence([
      Animated.timing(pressAnim, {
        toValue: 1,
        duration: 120,
        useNativeDriver: true,
      }),
      Animated.timing(pressAnim, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }),
    ]).start();
  };
  const requireLogin = () => {
    if (!userName) {
      setShowUserModal(true);
      return false;
    }
  
    return true;
  };
  const handleTap = () => {
    const canContinue = requireLogin();
  
    if (!canContinue) return;
  
    const now = Date.now();
  
    if (now - lastTapRef.current < 100) return;
  
    lastTapRef.current = now;
  
    playPressAnimation();
    tapFeedback();
  
    const newTotal = setCountersFromTotal(totalRef.current + 1);
    const newCount = newTotal % 108;
  
    if (newCount === 0) {
      void saveSession(0, 1, 108, newTotal);
      void completeFeedback();
    }
  };

  const handleStart = () => {
    const canContinue = requireLogin();
  
    if (!canContinue) return;
  
    const mins = Math.max(1, Math.floor(Number(minutesInput) || 1));
  
    setMinutesInput(String(mins));
    setTargetSeconds(mins * 60);
    setSeconds(0);
    setAutoCompletedMalas(0);
    setIsRunning(true);
  };

  const handlePause = () => {
    setIsRunning(false);
  };

  const handleStop = () => {
    setIsRunning(false);
    setSeconds(0);
    setAutoCompletedMalas(0);
  };

  const completeTimerSession = useCallback(() => {
    const newTotal = setCountersFromTotal(totalRef.current + 108);

    void saveSession(targetSeconds, 1, 108, newTotal);
    void completeFeedback();

    if (loopTimer) {
      setAutoCompletedMalas((prev) => {
        const next = prev + 1;

        if (next >= 5) {
          setSeconds(0);
          setIsRunning(false);
          setLoopTimer(false);
        } else {
          setSeconds(0);
          setIsRunning(true);
        }

        return next;
      });
    } else {
      setSeconds(0);
      setIsRunning(false);
    }
  }, [loopTimer, targetSeconds, saveSession, completeFeedback]);
  const saveJapamNameToSupabase = async (
    userId: string,
    userNameValue: string,
    japamNameValue: string
  ) => {
    try {
      const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  
      if (!url || !key) return;
  
      const encodedUserId = encodeURIComponent(userId);
  
      const checkResponse = await fetch(
        `${url}/rest/v1/user_profiles?user_id=eq.${encodedUserId}&select=id`,
        {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
          },
        }
      );
  
      const rows = await checkResponse.json();
  
      if (rows.length > 0) {
        await fetch(`${url}/rest/v1/user_profiles?user_id=eq.${encodedUserId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            user_name: userNameValue,
            japam_name: japamNameValue,
            updated_at: new Date().toISOString(),
          }),
        });
      } else {
        await fetch(`${url}/rest/v1/user_profiles`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            user_id: userId,
            user_name: userNameValue,
            japam_name: japamNameValue,
          }),
        });
      }
    } catch (error) {
      console.log('Profile save error:', error);
    }
  };

  const saveJapamName = async () => {
    const name = nameInput.trim();
  
    if (!name) return;
  
    setJapamName(name);
    setNameInput(name);
    setShowNameEditor(false);
  
    const savedUserId = await AsyncStorage.getItem(USER_ID_KEY);
  
    if (savedUserId) {
      await AsyncStorage.setItem(
        getUserStorageKey(JAPAM_NAME_KEY, savedUserId),
        name
      );
  
      const savedUserName = await AsyncStorage.getItem(USER_NAME_KEY);
  
      await saveJapamNameToSupabase(
        savedUserId,
        savedUserName || 'User',
        name
      );
    } else {
      await AsyncStorage.setItem(JAPAM_NAME_KEY, name);
    }
  };

  const performLogout = async () => {

    const currentUserId = await AsyncStorage.getItem(USER_ID_KEY);
  
    if (currentUserId) {
      await AsyncStorage.setItem(
        getUserStorageKey(TOTAL_KEY, currentUserId),
        String(totalRef.current)
      );
    }
  
    setIsRunning(false);
    setSeconds(0);
    setLoopTimer(false);
    setAutoCompletedMalas(0);
    setShowUserMenu(false);
  
    setUserName('');
    setJapamName('Japam');
    setNameInput('Japam');
    setShowUserModal(false);
  
    await AsyncStorage.removeItem(USER_NAME_KEY);
    await AsyncStorage.removeItem(USER_ID_KEY);
  
    await restoreTotal(0, { userId: null });
  };

  const handleLogout = () => {
    if (Platform.OS === 'web') {
      const ok = window.confirm('Do you want to logout?');
      if (ok) void performLogout();
      return;
    }

    Alert.alert('Logout', 'Do you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: () => void performLogout(),
      },
    ]);
  };

  const openRename = () => {
    setNameInput(japamName);
    setShowNameEditor(true);
  };

  const cancelRename = () => {
    setNameInput(japamName);
    setShowNameEditor(false);
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const todayLabel = new Date().toLocaleDateString();

  return (
    <LinearGradient
      colors={['#0f172a', '#1e1b4b', '#0f172a']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ flex: 1 }}
    >
      <ScrollView
  style={[styles.container, { backgroundColor: '#111136' }]}
  contentContainerStyle={styles.content}
  showsVerticalScrollIndicator={false}
>
  
      {isSigningIn && (
        <View style={styles.signingInBanner}>
          <Text style={styles.signingInText}>Signing in...</Text>
        </View>
      )}
  
      <View style={styles.topBar}>
        <View style={styles.headerCenter}>
          <Pressable onPress={openRename}>
            <Text style={styles.title}>🧘 {japamName}</Text>
          </Pressable>

{!userName && (
  <Pressable
    style={[
      styles.loginButton,
      isMobile ? styles.loginButtonMobile : styles.loginButtonDesktop,
    ]}
    onPress={() => setShowUserModal(true)}
  >
    <Text style={styles.loginButtonText}>Sign in</Text>
  </Pressable>
)}

      

          {!!userName && (
            <View
              style={[
                styles.userMenuWrap,
                isMobile ? styles.mobileUserBadge : styles.desktopUserBadge,
              ]}
            >
              <Pressable
                style={styles.userBadge}
                onPress={() => setShowUserMenu((prev) => !prev)}
              >
                <Text style={styles.userBadgeText}>🙏 {userName}</Text>
              </Pressable>

              {showUserMenu && (
                <View style={styles.userMenu}>
                  <Pressable style={styles.userMenuItem} onPress={handleLogout}>
                    <Text style={styles.userMenuText}>Logout</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}

          <Text style={styles.renameHint}>Tap name to rename</Text>
        </View>
      </View>

      {showNameEditor && (
        <View style={styles.nameEditor}>
          <TextInput
            style={styles.nameInput}
            value={nameInput}
            onChangeText={setNameInput}
            placeholder="Enter japam name"
            placeholderTextColor="#94a3b8"
          />

          <Pressable style={styles.smallBtn} onPress={saveJapamName}>
            <Text style={styles.smallBtnText}>Save</Text>
          </Pressable>

          <Pressable style={styles.graySmallBtn} onPress={cancelRename}>
            <Text style={styles.smallBtnText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      <Animated.Text style={[styles.quote, { opacity: fade }]}>
        {quote}
      </Animated.Text>

      <Text style={styles.dateText}>Today: {todayLabel}</Text>

      <Text style={styles.big}>{count}</Text>

      <View style={styles.progressBarBackground}>
        <View
          style={[
            styles.progressBarFill,
            {
              width: `${(count / 108) * 100}%`,
            },
          ]}
        />
      </View>

      <Text style={styles.progressText}>{count} / 108</Text>

      <View style={styles.metricsRow}>
      <Text style={styles.metricText}>
  📿 {malas} {malas === 1 ? 'mala' : 'malas'}
</Text>
        <Text style={[styles.metricText, isRunning && styles.timerRunningText]}>
          ⏱ {formatTime(seconds)}
        </Text>
        <Text style={styles.metricText}>Total {total}</Text>
      </View>

      <Animated.View
  style={[
    styles.circleGlow,
    {
      shadowOpacity: 0.45,
      transform: [{ scale: 1 }],
    },
  ]}
>
  <Pressable
    onPress={handleTap}
    style={({ pressed }) => [pressed && styles.circlePressed]}
  >
    <LinearGradient
      colors={['#7c3aed', '#4f46e5', '#312e81']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.circle}
    >
      <Text style={styles.omText}>ॐ</Text>

      <Animated.View
        pointerEvents="none"
        style={[
          styles.omPressGlow,
          {
            opacity: pressAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 0.65],
            }),
            transform: [
              {
                scale: pressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.8, 1.25],
                }),
              },
            ],
          },
        ]}
      />
    </LinearGradient>
  </Pressable>
</Animated.View>

<Pressable style={styles.undoBtn} onPress={handleUndo}>
  <Text style={styles.undoText}>↻ Undo last tap</Text>
</Pressable>

<Text style={styles.inputLabel}>Timer (minutes)</Text>

      <TextInput
  style={[
    styles.input,
    isRunning && styles.disabledInput,
  ]}
  value={minutesInput}
  onChangeText={(value) => {
    if (isRunning) return;

    setMinutesInput(value);
    setSeconds(0);
  }}
  editable={!isRunning}
  selectTextOnFocus={!isRunning}
  keyboardType="numeric"
/>

<Text style={styles.timerHint}>
Timer ending = 1 mala automatically added
</Text>
      <View style={styles.autoRepeatRow}>
        <Text style={styles.autoRepeatText}>Auto Repeat (Max 5 Malas)</Text>

        <Switch
          value={loopTimer}
          onValueChange={(value) => {
            setLoopTimer(value);
            setAutoCompletedMalas(0);

            if (!value) {
              setIsRunning(false);
              setSeconds(0);
            }
          }}
        />
      </View>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={handleStart}>
          <Text style={styles.btnText}>Start</Text>
        </Pressable>

        <Pressable style={[styles.btn, styles.gray]} onPress={handlePause}>
          <Text style={styles.btnText}>Pause</Text>
        </Pressable>

        <Pressable style={[styles.btn, styles.red]} onPress={handleStop}>
          <Text style={styles.btnText}>Stop</Text>
        </Pressable>
      </View>

      <Modal visible={showUserModal && !isSigningIn} transparent animationType="fade">
  <View style={styles.modalOverlay}>
    <View style={styles.modalCard}>

      <Pressable
        style={styles.modalClose}
        onPress={() => setShowUserModal(false)}
      >
        <Text style={styles.modalCloseText}>×</Text>
      </Pressable>

      <View style={styles.modalTopMark}>
        <Text style={styles.modalTopMarkText}>ॐ</Text>
      </View>

            <Text style={styles.modalTitle}>
              Sign in to save history
            </Text>

            <Text style={styles.modalSubtitle}>
              Sign in with Google to save your Japam history and sync it across devices.
            </Text>

            <Pressable
              disabled={!request}
              style={[styles.modalButton, !request && styles.disabledButton]}
              onPress={() => {
                setIsSigningIn(true);
                setShowUserModal(false);
                void (async () => {
                  await AsyncStorage.setItem(AUTH_PENDING_KEY, String(Date.now()));
                  const result = await promptAsync({
                    showInRecents: true,
                  });

                  if (result.type !== 'success') {
                    await AsyncStorage.removeItem(AUTH_PENDING_KEY);
                    setIsSigningIn(false);
                    setShowUserModal(true);
                  }
                })();
              }}
            >
              <View style={styles.googleIcon}>
                <Text style={styles.googleIconText}>G</Text>
              </View>
              <Text style={styles.modalButtonText}>Continue with Google</Text>
            </Pressable>

            <Text style={styles.modalFootnote}>
              Your history stays separate from other users on this device.
            </Text>
          </View>
        </View>
      </Modal>
      </ScrollView>
  </LinearGradient>

  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: {
    alignItems: 'center',
  
    paddingHorizontal: 20,
    paddingTop: 34,
    paddingBottom: 120,
  },
  topBar: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  headerCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    marginBottom: 8,
  },
  userMenuWrap: { alignItems: 'flex-end', zIndex: 20 },
  userBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  desktopUserBadge: { position: 'absolute', right: 45, top: 12 },
  mobileUserBadge: { marginTop: 10, alignItems: 'center' },
  userBadgeText: { color: '#ffffff', fontSize: 14, fontWeight: '800' },
  userMenu: {
    marginTop: 8,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
    minWidth: 110,
  },
  userMenuItem: { paddingVertical: 10, paddingHorizontal: 14 },
  userMenuText: { color: 'white', fontSize: 14, fontWeight: '800' },
  title: {
    color: '#f8fafc',
  
    fontSize: 28,
    fontWeight: '500',
  
    textAlign: 'center',
  
    letterSpacing: 0.3,
  
    textShadowColor: 'rgba(255,255,255,0.06)',
    textShadowOffset: {
      width: 0,
      height: 1,
    },
    textShadowRadius: 6,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    letterSpacing: 1.8,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  count: {
    fontSize: 82,
    fontWeight: '300',
    color: '#ffffff',
  
    textShadowColor: 'rgba(255,255,255,0.12)',
    textShadowOffset: {
      width: 0,
      height: 2,
    },
    textShadowRadius: 12,
  },
  renameHint: { color: '#64748b', fontSize: 12, marginTop: 4 },
  nameEditor: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 14,
  },
  nameInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  quote: {
    color: 'rgba(255,255,255,0.82)',
    textAlign: 'center',
  
    marginTop: 10,
    marginBottom: 12,
  
    fontSize: 18,
    fontStyle: 'italic',
  
    lineHeight: 30,
  
    maxWidth: 620,
  },
  dateText: { color: '#94a3b8', fontSize: 14, marginBottom: 4 },
  big: { color: 'white', fontSize: 68, fontWeight: '900', marginTop: 0 },
  progressBarBackground: {
    width: 220,
    height: 6,
    backgroundColor: '#1e293b',
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 8,
    alignSelf: 'center',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 999,
  },
  progressText: { color: '#94a3b8', fontSize: 13, marginBottom: 8 },
  metricsRow: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 18,
  },
  metricText: {
    color: '#e2e8f0',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  timerRunningText: { fontSize: 24, color: 'white', fontWeight: '900' },
  circleGlow: {
    width: 220,
    height: 220,
    borderRadius: 110,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(139, 92, 246, 0.10)',
    shadowColor: '#8b5cf6',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 35,
    elevation: 20,
    borderWidth: 0,
  },
  circle: {
    width: 180,
    height: 180,
    borderRadius: 90,
  
    justifyContent: 'center',
    alignItems: 'center',
  
    shadowColor: '#8b5cf6',
    shadowOffset: {
      width: 0,
      height: 0,
    },
    shadowOpacity: 0.95,
    shadowRadius: 40,
  
    elevation: 25,
  },
  circlePressed: { transform: [{ scale: 0.96 }] },
  innerBead: {
    position: 'absolute',
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  undoBtn: {
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 999,
    marginTop: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  undoText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  inputLabel: { color: '#94a3b8', fontSize: 13, marginBottom: 6 },
  input: {
    backgroundColor: '#1e293b',
    color: 'white',
    borderRadius: 10,
    width: 110,
    textAlign: 'center',
    padding: 10,
    fontSize: 18,
  },
  autoRepeatRow: {
    width: 260,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  autoRepeatText: { color: '#cbd5e1', fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: {
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 86,
    alignItems: 'center',
  },
  gray: { backgroundColor: '#475569' },
  red: { backgroundColor: '#991b1b' },
  smallBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  graySmallBtn: {
    backgroundColor: '#475569',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  smallBtnText: { color: 'white', fontWeight: '700', fontSize: 14 },
  btnText: { color: 'white', fontWeight: '700', fontSize: 16 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#111827',
    borderRadius: 18,
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 22,
    borderWidth: 1,
    borderColor: '#374151',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 12,
  },
  modalTopMark: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#4f46e5',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 14,
  },
  modalTopMarkText: {
    color: '#e0e7ff',
    fontSize: 28,
    fontWeight: '800',
  },
  modalTitle: {
    color: 'white',
    fontSize: 30,
    fontWeight: '900',
    marginBottom: 10,
    textAlign: 'center',
  },
  modalSubtitle: {
    color: '#cbd5e1',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 22,
  },
  modalButton: {
    backgroundColor: '#f8fafc',
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  disabledButton: { opacity: 0.5 },
  googleIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'white',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  googleIconText: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '900',
  },
  modalButtonText: { color: '#0f172a', fontWeight: '900', fontSize: 16 },
  modalFootnote: {
    color: '#94a3b8',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 14,
  },
  modalClose: {
    position: 'absolute',
    right: 14,
    top: 10,
    zIndex: 10,
  },
  
  modalCloseText: {
    color: '#94a3b8',
    fontSize: 28,
    fontWeight: '800',
  },
  loginButton: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  loginButtonDesktop: {
    position: 'absolute',
    right: 16,
    top: 12,
  },
  loginButtonMobile: {
    marginTop: 8,
    alignSelf: 'center',
  },
  
  loginButtonText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  timerHint: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 6,
    textAlign: 'center',
  },
  disabledInput: {
    opacity: 0.55,
  },
  signingInBanner: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 20,
  },
  
  signingInText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  
  omText: {
    fontSize: 96,
    color: '#fbbf24',
    fontWeight: '300',
  
    textShadowColor: 'rgba(251,191,36,0.8)',
    textShadowOffset: {
      width: 0,
      height: 0,
    },
    textShadowRadius: 22,
  
    opacity: 1,
  },
  omPressGlow: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(251,191,36,0.22)',
    shadowColor: '#fbbf24',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 30,
    zIndex: 1,
  },
});
