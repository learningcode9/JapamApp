/**
 * The single "Current Japam" header trigger used on every screen (Timer, Home, Tap Japam, Manual
 * Entry, History). This is the single permanent source of truth for all of it: reading the
 * current Japam, navigating to My Japams, the "My Japams" fallback label, the chevron, ellipsis
 * for long names, sizing, accessibility, pressed-state styling, AND where this button sits within
 * each screen's own layout. Screens render <CurrentJapamHeaderButton variant="..." /> and know
 * nothing else about it -- no screen passes a style/layout object.
 *
 * Future changes to this button (icon, badge, archived indicator, dropdown, loading state,
 * notification dot, different colors, animations) happen ONLY inside this file. No screen should
 * ever need to change because of them.
 *
 * `variant` is the only thing a caller supplies, and it names WHICH SCREEN's header this instance
 * is placed in -- not a generic layout primitive. Each screen's existing layout structure is
 * different enough (Timer's 3-column flex row, Home's absolutely-positioned account button
 * convention, Tap Japam's own full-width right-aligned row, Manual/History's simple top-of-panel
 * spacing) that naming variants after the screen they belong to is more self-documenting than
 * inventing a generic "placement" vocabulary that would only ever have one caller each anyway. Add
 * a new entry to VARIANT_STYLES for any new screen that needs this button.
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useCurrentJapam } from '../contexts/current-japam-context';

export type CurrentJapamHeaderButtonVariant =
  | 'timer'
  | 'home'
  | 'tapJapam'
  | 'manual'
  | 'history';

type CurrentJapamHeaderButtonProps = {
  variant: CurrentJapamHeaderButtonVariant;
};

type VariantStyle = {
  /** Wraps the button in an extra container for screens that need one (e.g. a full-width row to
   * right-align within). Omitted when the button can be a direct child of its screen's own row. */
  container?: ViewStyle;
  /** Applied to the button itself (flex/position/margin) -- never the button's visual identity. */
  button?: ViewStyle;
};

const VARIANT_STYLES: Record<CurrentJapamHeaderButtonVariant, VariantStyle> = {
  // Timer: one of 3 flex children in its topControls row.
  timer: { button: { flex: 1 } },
  // Home: topControls centers "Welcome"; the account button floats on the right via absolute
  // positioning, so this button floats on the left the same way.
  home: { button: { position: 'absolute', left: 0, top: 2 } },
  // Tap Japam has no existing header row to join -- needs its own full-width, right-aligned row.
  tapJapam: { container: { width: '100%', alignItems: 'flex-end', marginBottom: 8 } },
  // Manual Entry: sits above the title, inside the already-centered panel.
  manual: { button: { marginBottom: 14 } },
  // History: sits below the title, inside the centered header block.
  history: { button: { marginTop: 10 } },
};

export default function CurrentJapamHeaderButton({ variant }: CurrentJapamHeaderButtonProps) {
  const router = useRouter();
  const { currentJapam } = useCurrentJapam();
  const variantStyle = VARIANT_STYLES[variant];

  const label = currentJapam ? `${currentJapam.name} ▾` : 'My Japams';
  const accessibilityLabel = currentJapam
    ? `Current Japam: ${currentJapam.name}. Tap to switch.`
    : 'Open My Japams';

  const button = (
    <Pressable
      style={({ pressed }) => [styles.button, variantStyle.button, pressed && styles.pressed]}
      onPress={() => router.push('/my-japams')}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.text}>
        {label}
      </Text>
    </Pressable>
  );

  if (variantStyle.container) {
    return <View style={variantStyle.container}>{button}</View>;
  }
  return button;
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
