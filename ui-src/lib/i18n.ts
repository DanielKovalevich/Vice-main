import type {ReactNode} from 'react';

import {LOCALES, type LocaleName} from '../locales';

/**
 * Translation, in about as little code as it can be done correctly.
 *
 * No i18n library. The runtime need here is a dictionary lookup, a fallback
 * chain and plural selection; react-i18next is 40KB to provide that in a bundle
 * that already carries the whole editor. Plurals go through Intl.PluralRules,
 * which every engine Vice runs on already has, and which is the only way to be
 * right in languages that do not work like English.
 *
 * English is the source of truth. Anything missing from a locale falls back to
 * it, so a half-finished translation is safe to ship: a contributor can send a
 * PR with 40% done and nothing breaks. That property is the whole point, so do
 * not "improve" this by making a missing key an error.
 */

const FALLBACK: LocaleName = 'en';
const STORAGE_KEY = 'vice-locale';

/** A leaf is either a plain string or a set of CLDR plural categories. */
type Leaf = string | Partial<Record<Intl.LDMLPluralRule, string>>;
type Tree = {[key: string]: Leaf | Tree};

export type Vars = Record<string, string | number>;

let active: LocaleName = FALLBACK;
let plurals = new Intl.PluralRules(FALLBACK);
const listeners = new Set<() => void>();

/**
 * Notified when the language changes.
 *
 * The root subscribes and re-renders, which is enough: t() reads the active
 * locale at call time and nothing in this tree is memoized, so one render from
 * the top retranslates every screen without a reload. A reload would be the
 * easy answer and it would throw away an in-progress Settings draft.
 */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(tree: Tree, path: string): Leaf | undefined {
  let node: Leaf | Tree | undefined = tree;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Tree)[part];
    if (node === undefined) return undefined;
  }
  return typeof node === 'object' && !isPlural(node) ? undefined : (node as Leaf);
}

function isPlural(value: unknown): value is Partial<Record<Intl.LDMLPluralRule, string>> {
  return typeof value === 'object' && value !== null && 'other' in value;
}

function fill(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Translate a key. `count` in `vars` selects the plural form.
 *
 * A key that resolves nowhere returns the key itself rather than an empty
 * string, so a typo shows up on screen instead of silently blanking a label.
 */
export function t(key: string, vars?: Vars): string {
  const found =
    lookup(LOCALES[active] as Tree, key) ?? lookup(LOCALES[FALLBACK] as Tree, key);
  if (found === undefined) return key;

  if (typeof found === 'string') return fill(found, vars);

  const count = typeof vars?.count === 'number' ? vars.count : 0;
  // Fall back through the category the active locale asked for, then 'other',
  // which CLDR guarantees every language defines.
  const category = plurals.select(count);
  const template = found[category] ?? found.other ?? key;
  return fill(template, vars);
}

/**
 * Translate a key whose values are React nodes rather than text.
 *
 * This exists so a sentence with markup inside it stays one sentence in the
 * locale file. The alternative, splitting a sentence into fragments around its
 * <b> and <kbd>, produces word order no other language can follow. Putting the
 * markup in the locale file instead was the other option, and it is worse: a
 * translation arrives as a pull request, so a string rendered as HTML would be
 * an injection route. Here a translator only ever controls the text between
 * placeholders.
 */
export function tNode(key: string, vars: Record<string, ReactNode>): ReactNode[] {
  const template =
    lookup(LOCALES[active] as Tree, key) ?? lookup(LOCALES[FALLBACK] as Tree, key) ?? key;
  const text = typeof template === 'string' ? template : key;

  const out: ReactNode[] = [];
  const pattern = /\{(\w+)\}/g;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > at) out.push(text.slice(at, match.index));
    out.push(match[1] in vars ? vars[match[1]] : match[0]);
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Every locale that has a file, for the picker in Settings. */
export function availableLocales(): LocaleName[] {
  return Object.keys(LOCALES) as LocaleName[];
}

export function currentLocale(): LocaleName {
  return active;
}

/**
 * Pick the closest locale we actually have.
 *
 * Matched loosely on purpose: a browser reporting pt-BR should get pt-BR if it
 * exists and pt if it does not, rather than dropping straight to English over a
 * region suffix.
 */
export function resolveLocale(requested: string | null | undefined): LocaleName {
  if (!requested) return FALLBACK;
  const available = availableLocales();
  const wanted = requested.replace('_', '-');
  const exact = available.find(name => name.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const base = wanted.split('-')[0].toLowerCase();
  return available.find(name => name.split('-')[0].toLowerCase() === base) ?? FALLBACK;
}

export function setLocale(name: LocaleName): void {
  active = name;
  plurals = new Intl.PluralRules(name);
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Private windows and some WebKit builds refuse storage. The choice just
    // does not survive a restart, which beats failing to apply it at all.
  }
  document.documentElement.lang = name;
  for (const fn of listeners) fn();
}

/**
 * Decide the starting locale: an explicit choice first, then the system, then
 * English. Called once before React mounts.
 */
export function initLocale(): LocaleName {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  const name = stored ? resolveLocale(stored) : resolveLocale(navigator.language);
  active = name;
  plurals = new Intl.PluralRules(name);
  document.documentElement.lang = name;
  return name;
}
