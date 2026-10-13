// The version has one home: "version" in package.json (the desktop app reads it
// too). "nibChannel" adds the test label, e.g. 0.5.0-beta.
import pkg from '../package.json';

export const VERSION: string = pkg.nibChannel ? `${pkg.version}-${pkg.nibChannel}` : pkg.version;
