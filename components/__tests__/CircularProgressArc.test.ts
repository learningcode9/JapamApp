import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;

import { CircularProgressArc, getArcRotations } from '../CircularProgressArc';

async function renderArc(props: { size: number; progress: number; color: string; trackColor: string }) {
  let tree: any;
  await act(async () => {
    tree = renderer.create(React.createElement(CircularProgressArc, props));
    await Promise.resolve();
  });
  return tree;
}

describe('getArcRotations', () => {
  it('maps progress percent to right/left half rotation degrees', () => {
    expect(getArcRotations(0)).toEqual({ rightRotation: 0, leftRotation: 0 });
    expect(getArcRotations(25)).toEqual({ rightRotation: 90, leftRotation: 0 });
    expect(getArcRotations(50)).toEqual({ rightRotation: 180, leftRotation: 0 });
    expect(getArcRotations(75)).toEqual({ rightRotation: 180, leftRotation: 90 });
    expect(getArcRotations(100)).toEqual({ rightRotation: 180, leftRotation: 180 });
  });

  it('clamps out-of-range progress instead of producing invalid rotations', () => {
    expect(getArcRotations(-10)).toEqual({ rightRotation: 0, leftRotation: 0 });
    expect(getArcRotations(150)).toEqual({ rightRotation: 180, leftRotation: 180 });
  });
});

describe('CircularProgressArc render', () => {
  const size = 100;
  const color = '#0F8F87';
  const trackColor = 'rgba(15,143,135,0.14)';

  it('renders without throwing at 0%, mid-sweep, and 100% progress', async () => {
    for (const progress of [0, 27, 50, 81, 100]) {
      const tree = await renderArc({ size, progress, color, trackColor });
      expect(tree.toJSON()).toBeTruthy();
      act(() => {
        tree.unmount();
      });
    }
  });

  it('rotates only the right half below 50% progress (25%)', async () => {
    const tree = await renderArc({ size, progress: 25, color, trackColor });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('"rotate":"90deg"');
    expect(json).toContain('"rotate":"0deg"');
    act(() => {
      tree.unmount();
    });
  });

  it('fully sweeps both halves at 100% progress (108 out of 108 taps)', async () => {
    const tree = await renderArc({ size, progress: 100, color, trackColor });
    const json = JSON.stringify(tree.toJSON());
    const matches = json.match(/"rotate":"180deg"/g) ?? [];
    expect(matches.length).toBe(2);
    act(() => {
      tree.unmount();
    });
  });
});
