import packageJson from '../package.json' with { type: 'json' };

// TypeScript copies this package metadata into dist alongside the compiled server.
export const APP_VERSION = packageJson.version;
