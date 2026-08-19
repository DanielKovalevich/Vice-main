/**
 * Browser key events to evdev names, which is what the daemon binds.
 *
 * The tables are the daemon's vocabulary, not a convenience mapping, so they
 * are carried over exactly: a name that does not exist in evdev binds nothing
 * and fails silently at the hotkey listener.
 */

export function codeToEvdev(code: string): string | null {
  const fn = /^F(\d+)$/.exec(code);
  if (fn) return `KEY_F${fn[1]}`;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return `KEY_${letter[1]}`;
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return `KEY_${digit[1]}`;
  return NUMPAD[code] ?? NAMED[code] ?? null;
}

const NUMPAD: Record<string, string> = {
  Numpad0: 'KEY_KP0',
  Numpad1: 'KEY_KP1',
  Numpad2: 'KEY_KP2',
  Numpad3: 'KEY_KP3',
  Numpad4: 'KEY_KP4',
  Numpad5: 'KEY_KP5',
  Numpad6: 'KEY_KP6',
  Numpad7: 'KEY_KP7',
  Numpad8: 'KEY_KP8',
  Numpad9: 'KEY_KP9',
  NumpadAdd: 'KEY_KPPLUS',
  NumpadSubtract: 'KEY_KPMINUS',
  NumpadMultiply: 'KEY_KPASTERISK',
  NumpadDivide: 'KEY_KPSLASH',
  NumpadEnter: 'KEY_KPENTER',
  NumpadDecimal: 'KEY_KPDOT',
};

const NAMED: Record<string, string> = {
  Insert: 'KEY_INSERT',
  Delete: 'KEY_DELETE',
  Home: 'KEY_HOME',
  End: 'KEY_END',
  PageUp: 'KEY_PAGEUP',
  PageDown: 'KEY_PAGEDOWN',
  ScrollLock: 'KEY_SCROLLLOCK',
  Pause: 'KEY_PAUSE',
  PrintScreen: 'KEY_SYSRQ',
  Tab: 'KEY_TAB',
  CapsLock: 'KEY_CAPSLOCK',
  NumLock: 'KEY_NUMLOCK',
  ArrowUp: 'KEY_UP',
  ArrowDown: 'KEY_DOWN',
  ArrowLeft: 'KEY_LEFT',
  ArrowRight: 'KEY_RIGHT',
  Backspace: 'KEY_BACKSPACE',
  Enter: 'KEY_ENTER',
  Space: 'KEY_SPACE',
  Minus: 'KEY_MINUS',
  Equal: 'KEY_EQUAL',
  BracketLeft: 'KEY_LEFTBRACE',
  BracketRight: 'KEY_RIGHTBRACE',
  Backslash: 'KEY_BACKSLASH',
  Semicolon: 'KEY_SEMICOLON',
  Quote: 'KEY_APOSTROPHE',
  Backquote: 'KEY_GRAVE',
  Comma: 'KEY_COMMA',
  Period: 'KEY_DOT',
  Slash: 'KEY_SLASH',
};

/**
 * Modifiers in the order the daemon stores them. The left-hand names are
 * canonical, so either physical key produces the same combo.
 */
const MOD_ORDER: Array<[keyof KeyboardEvent, string]> = [
  ['ctrlKey', 'KEY_LEFTCTRL'],
  ['altKey', 'KEY_LEFTALT'],
  ['shiftKey', 'KEY_LEFTSHIFT'],
  ['metaKey', 'KEY_LEFTMETA'],
];

export const MOD_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

/** "KEY_LEFTALT+KEY_F9" from the held modifiers plus the main key. */
export function comboFromEvent(event: KeyboardEvent, main: string): string {
  const mods = MOD_ORDER.filter(([flag]) => event[flag]).map(([, name]) => name);
  return [...mods, main].join('+');
}
