// The version has one home: "version" in package.json (the desktop app reads it
// too). An optional "nibChannel" adds a label, e.g. 0.6.0-preview.
import pkg from '../package.json';

const channel = (pkg as { nibChannel?: string }).nibChannel;

export const VERSION: string = channel ? `${pkg.version}-${channel}` : pkg.version;
