import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ANDROID_UPDATE_MESSAGE,
} from '../lib/androidUpdate';

type AndroidUpdateBannerProps = {
  topInset: number;
  onUpdate: () => void;
};

export default function AndroidUpdateBanner({ topInset, onUpdate }: AndroidUpdateBannerProps) {
  return (
    <View style={[styles.banner, { top: Math.max(12, topInset + 8) }]}>
      <View style={styles.copy}>
        <Text style={styles.title}>Update Available</Text>
        <Text style={styles.subtitle}>{ANDROID_UPDATE_MESSAGE}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Update on Google Play"
        style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        onPress={onUpdate}
      >
        <Text style={styles.actionText}>Update on Google Play</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 1000,
    elevation: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(15,143,135,0.18)',
  },
  copy: {
    flex: 1,
  },
  title: {
    color: '#063B3B',
    fontSize: 14,
    fontWeight: '900',
  },
  subtitle: {
    color: '#517579',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  action: {
    paddingVertical: 5,
    paddingLeft: 4,
  },
  actionPressed: {
    opacity: 0.72,
  },
  actionText: {
    color: '#0F766E',
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'right',
  },
});
