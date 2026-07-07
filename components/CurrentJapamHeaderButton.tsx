/**
 * The single "Current Japam" header trigger used on every screen (Timer, Home, Tap Japam, Manual
 * Entry, History). Owns everything about this button: reading the current Japam, navigating to
 * My Japams, the "My Japams" fallback label, the chevron, ellipsis for long names, sizing,
 * accessibility, and pressed-state styling. Screens render <CurrentJapamHeaderButton /> and know
 * nothing else about it.
 *
 * Future changes to this button (icon, badge, archived indicator, dropdown, loading state,
 * notification dot, different colors, animations) happen ONLY inside this file. No screen should
 * ever need to change because of them.
 *
 * The optional `style` prop is for LAYOUT INTEGRATION ONLY -- where this button sits within a
 * given screen's own header (flex, margin, position, alignSelf) -- never for the button's own
 * visual identity (colors, border, shadow, text style, sizing), which this component owns
 * entirely and never varies by screen.
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { useCurrentJapam } from '../contexts/current-japam-context';

type CurrentJapamHeaderButtonProps = {
  style?: StyleProp<ViewStyle>;
};

export default function CurrentJapamHeaderButton({ style }: CurrentJapamHeaderButtonProps) {
  const router = useRouter();
  const { currentJapam } = useCurrentJapam();

  const label = currentJapam ? `${currentJapam.name} ▾` : 'My Japams';
  const accessibilityLabel = currentJapam
    ? `Current Japam: ${currentJapam.name}. Tap to switch.`
    : 'Open My Japams';

  return (
    <Pressable
      style={({ pressed }) => [styles.button, pressed && styles.pressed, style]}
      onPress={() => router.push('/my-japams')}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.text}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 40,
    minWidth: 74,
    maxWidth: 168,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.66)',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f8f87',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  pressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.86,
  },
  text: {
    color: '#063B3B',
    fontSize: 14,
    fontWeight: '900',
  },
});
