import React from 'react';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer = require('react-test-renderer');
const { act } = renderer;

jest.mock('../../lib/androidUpdate', () => ({
  ANDROID_UPDATE_MESSAGE: 'Get the latest version from Google Play.',
}));

jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const makeHost = (name: string) => {
    const Host = ({ children, ...props }: any) => React.createElement(name, props, children);
    Host.displayName = name;
    return Host;
  };

  return {
    Pressable: makeHost('Pressable'),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Text: makeHost('Text'),
    View: makeHost('View'),
  };
});

// eslint-disable-next-line import/first
import AndroidUpdateBanner from '../AndroidUpdateBanner';

describe('AndroidUpdateBanner', () => {
  it('renders one calm update action with the requested copy', () => {
    const onUpdate = jest.fn();
    let tree: any;
    act(() => {
      tree = renderer.create(React.createElement(AndroidUpdateBanner, { topInset: 24, onUpdate }));
    });

    const text = tree.root.findAllByType('Text').map((node: any) => node.props.children).join(' ');
    expect(text).toContain('Update Available');
    expect(text).toContain('Get the latest version from Google Play.');
    expect(text).toContain('Update on Google Play');
    expect(tree.root.findAllByType('Pressable')).toHaveLength(1);

    tree.root.findByType('Pressable').props.onPress();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });
});
