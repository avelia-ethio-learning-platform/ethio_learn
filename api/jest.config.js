// Single workspace-wide jest run: every package keeps its tests next to its
// source (src/…/*.spec.ts) but one process runs them all — far cheaper than
// a jest boot per package, both locally and in CI.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/gateway/src', '<rootDir>/services', '<rootDir>/packages'],
  testMatch: ['**/src/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    // Resolve workspace packages to their sources so tests never depend on a
    // prior `pnpm build`.
    '^@ethiopialearn/(.*)$': '<rootDir>/packages/$1/src',
  },
  setupFilesAfterEnv: ['<rootDir>/packages/common/jest.setup.ts'],
  clearMocks: true,
};
