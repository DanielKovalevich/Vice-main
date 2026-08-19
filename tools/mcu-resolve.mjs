// material-color-utilities 0.4.0 ships extensionless relative imports
// ("../dynamiccolor/dynamic_color" with no .js) in scheme/*.js and
// color_spec_2025.js. Node's ESM resolver requires the extension, so the
// package cannot be imported as published. Bundlers paper over this; plain
// node does not, and the accent generator is plain node.
//
// This hook appends .js to extensionless relative specifiers, and only for
// files inside that package, so nothing else in the build can be affected by
// it. Registered by `npm run accents`; nothing at runtime uses it.
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';

register(pathToFileURL(new URL('./mcu-resolve-hooks.mjs', import.meta.url).pathname));
