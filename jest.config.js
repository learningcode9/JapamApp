// Jest config for offline-first history/stats unit tests.
// Uses the jest-expo preset so TypeScript/babel transforms match the app. The historyStore
// module is pure (no React Native imports), so these run fast in plain Node.
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts'],
};
