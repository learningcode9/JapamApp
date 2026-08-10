/* eslint-disable import/first, @typescript-eslint/no-require-imports */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('../supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

import { isNetworkFailure } from '../groupsRepository';

describe('isNetworkFailure', () => {
  it('classifies browser fetch failure text in string and Error forms', () => {
    expect(isNetworkFailure('Failed to fetch')).toBe(true);
    expect(isNetworkFailure('TypeError: Failed to fetch')).toBe(true);
    expect(isNetworkFailure('Network request failed')).toBe(true);
    expect(isNetworkFailure(new Error('Failed to fetch'))).toBe(true);
  });

  it('does not classify server errors as network failures', () => {
    expect(isNetworkFailure({ status: 403, message: 'permission denied' })).toBe(false);
  });
});
