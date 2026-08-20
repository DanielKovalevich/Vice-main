// Starts a new translation.
//
// Run with: npm run i18n:new -- pt-BR
//
// Copies en.json under the new name with the English text left in place as the
// values, so a translator overwrites in place and never has to invent the key
// structure or guess what a string is for. Also wires the file into
// locales/index.ts, which is the step people forget.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const LOCALES_DIR = new URL('../ui-src/locales/', import.meta.url);

const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run i18n:new -- <locale>   for example pt-BR, pl, fr');
  process.exit(1);
}
// BCP 47 as far as Vice needs it: a language, optionally a region.
if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(name)) {
  console.error(`"${name}" is not a locale name. Use a form like fr, pt-BR or pl-PL.`);
  process.exit(1);
}

const target = new URL(`${name}.json`, LOCALES_DIR);
if (existsSync(fileURLToPath(target))) {
  console.error(`ui-src/locales/${name}.json already exists. Edit it instead.`);
  process.exit(1);
}

const english = readFileSync(new URL('en.json', LOCALES_DIR), 'utf8');
writeFileSync(target, english);

const indexPath = fileURLToPath(new URL('index.ts', LOCALES_DIR));
let index = readFileSync(indexPath, 'utf8');

// A hyphen is legal in a file name and not in an identifier, and a key holding
// one has to be quoted.
const ident = name.replace(/-/g, '_');
const key = /-/.test(name) ? `'${name}'` : name;
if (!index.includes(`from './${name}.json'`)) {
  index = index.replace(
    /(import en from '\.\/en\.json';\n)/,
    `$1import ${ident} from './${name}.json';\n`,
  );
  index = index.replace(/(export const LOCALES = \{\n  en,\n)/, `$1  ${key}: ${ident},\n`);
  index = index.replace(
    /(export const LOCALE_LABELS: Record<LocaleName, string> = \{\n  en: 'English',\n)/,
    `$1  ${key}: '${name}',\n`,
  );
  writeFileSync(indexPath, index);
}

console.log(`Created ui-src/locales/${name}.json and added it to locales/index.ts.

Next:
  1. Translate the values in ui-src/locales/${name}.json. Leave the keys alone.
  2. Put your language's own name in LOCALE_LABELS in ui-src/locales/index.ts,
     spelled the way you would spell it, for example Português (Brasil).
  3. npm run i18n:check   to see how much is left.
  4. Open a pull request. A partly finished translation is fine: anything you
     have not done falls back to English.`);
