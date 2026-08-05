import React from 'react';
const renderer = require('react-test-renderer');
const { act } = renderer;

const mockPush = jest.fn();
const mockUseRouter = jest.fn(() => ({ push: mockPush }));
const mockUseCurrentJapam = jest.fn(() => ({ currentJapam: { id: 'j1', name: 'My Japam' } }));

jest.mock('expo-router', () => ({
  useRouter: () => mockUseRouter(),
}));

jest.mock('../../contexts/current-japam-context', () => ({
  useCurrentJapam: () => mockUseCurrentJapam(),
}));

jest.mock('react-native', () => {
  const React = require('react');
  const makeHost = (name: string) => {
    const Host = ({ children, ...props }: any) => React.createElement(name, props, children);
    Host.displayName = name;
    return Host;
  };

  return {
    Text: makeHost('Text'),
    Pressable: makeHost('Pressable'),
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
    },
  };
});

import CurrentJapamHeaderButton from '../CurrentJapamHeaderButton';

const renderButton = async (props: { variant: 'timer' | 'home' | 'tapJapam' | 'manual' | 'history' }) => {
  let tree: any;
  await act(async () => {
    tree = renderer.create(React.createElement(CurrentJapamHeaderButton, props));
    await Promise.resolve();
  });
  return tree;
};

describe('CurrentJapamHeaderButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: mockPush });
  });

  it('opens the My Japams selector mode when pressed', async () => {
    const tree = await renderButton({ variant: 'timer' });
    const pressable = tree.root.findByType('Pressable');

    await act(async () => {
      pressable.props.onPress();
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/my-japams?mode=selector');
  });

  it('renders the current Japam name with a chevron when a Japam is selected', async () => {
    mockUseCurrentJapam.mockReturnValue({ currentJapam: { id: 'j1', name: 'My Japam' } });
    const tree = await renderButton({ variant: 'timer' });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('My Japam');
    expect(json).toContain('▾');
  });

  it('falls back to a generic My Japams label when no Japam is selected', async () => {
    mockUseCurrentJapam.mockReturnValue({ currentJapam: null } as any);
    const tree = await renderButton({ variant: 'timer' });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('My Japams');
  });

  it('uses an accessibility label that mentions switching the current Japam', async () => {
    mockUseCurrentJapam.mockReturnValue({ currentJapam: { id: 'j1', name: 'My Japam' } });
    const tree = await renderButton({ variant: 'timer' });
    const pressable = tree.root.findByType('Pressable');
    expect(pressable.props.accessibilityLabel).toContain('Tap to switch');
  });
});
