module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>'],
  moduleDirectories: ['node_modules', 'js'],
  // Order matters: Jest applies the first pattern that matches, so stylesheets must be mocked
  // before the `@/` alias resolves `@/…/x.module.scss` to the real file.
  moduleNameMapper: {
    '\.scss$': 'identity-obj-proxy', // Mock SCSS files
    '^@/(.*)$': '<rootDir>/js/$1',
  },
  transform: {
    '^.+\.(ts|tsx)$': 'ts-jest',
    '^.+\.(js|jsx)$': 'babel-jest', // Add babel-jest for JS/JSX files if needed
  },
};
