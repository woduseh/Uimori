import metadata from '../package.json' with { type: 'json' };

export const requiredNode = metadata.engines.node;
// This checkout declares one stable release interval, not arbitrary semver expressions.
const range = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/u.exec(requiredNode);
if (!range) throw new Error(`Unsupported package.json Node range: ${requiredNode}`);
const [minimumMajor, minimumMinor, minimumPatch, maximumMajor] = range.slice(1).map(Number);

export function supportedNode(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    major < maximumMajor &&
    (major > minimumMajor ||
      (major === minimumMajor &&
        (minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch))))
  );
}
