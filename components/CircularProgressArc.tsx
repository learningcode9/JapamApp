import React from 'react';
import { StyleSheet, View } from 'react-native';

// Pure View-based circular progress ("pie mask") for platforms that don't support the CSS
// `conic-gradient` background used on web. A size×size disc is drawn as two rotating halves,
// each clipped to one half of the circle. Rotating a half-colored full-size disc (rather than a
// smaller wedge) keeps the pivot at the disc's true center, which is what makes the sweep land in
// the right place.
export function getArcRotations(progressPercent: number): { rightRotation: number; leftRotation: number } {
  const clamped = Math.min(100, Math.max(0, progressPercent));
  const angle = (clamped / 100) * 360;
  return {
    rightRotation: Math.min(angle, 180),
    leftRotation: Math.max(angle - 180, 0),
  };
}

type CircularProgressArcProps = {
  size: number;
  progress: number;
  color: string;
  trackColor: string;
};

export function CircularProgressArc({ size, progress, color, trackColor }: CircularProgressArcProps) {
  const half = size / 2;
  const { rightRotation, leftRotation } = getArcRotations(progress);

  return (
    <View style={{ width: size, height: size, borderRadius: half }}>
      <View
        style={[
          StyleSheet.absoluteFillObject,
          { borderRadius: half, backgroundColor: trackColor },
        ]}
      />

      <View style={[styles.halfWindow, { width: half, height: size, left: half }]}>
        <View
          style={[
            styles.rotator,
            {
              width: size,
              height: size,
              borderRadius: half,
              left: -half,
              transform: [{ rotate: `${rightRotation}deg` }],
            },
          ]}
        >
          <View
            style={[
              styles.halfPiece,
              { width: half, height: size, backgroundColor: color, borderTopLeftRadius: half, borderBottomLeftRadius: half },
            ]}
          />
          <View
            style={[
              styles.halfPiece,
              { width: half, height: size, left: half, backgroundColor: trackColor, borderTopRightRadius: half, borderBottomRightRadius: half },
            ]}
          />
        </View>
      </View>

      <View style={[styles.halfWindow, { width: half, height: size, left: 0 }]}>
        <View
          style={[
            styles.rotator,
            {
              width: size,
              height: size,
              borderRadius: half,
              left: 0,
              transform: [{ rotate: `${leftRotation}deg` }],
            },
          ]}
        >
          <View
            style={[
              styles.halfPiece,
              { width: half, height: size, backgroundColor: trackColor, borderTopLeftRadius: half, borderBottomLeftRadius: half },
            ]}
          />
          <View
            style={[
              styles.halfPiece,
              { width: half, height: size, left: half, backgroundColor: color, borderTopRightRadius: half, borderBottomRightRadius: half },
            ]}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  halfWindow: {
    position: 'absolute',
    top: 0,
    overflow: 'hidden',
  },
  rotator: {
    position: 'absolute',
    top: 0,
  },
  halfPiece: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
});
