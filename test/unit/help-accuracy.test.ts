/**
 * The help text must not promise keys that do nothing: every shortcut a window's "?" panel names is bound,
 * and the windows it describes exist. (The shortcut list itself, F1, is generated from the keymap.)
 */
import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { parseChord } from '@core/commands/keymap';
import { registerFeatures } from '@ui/features';
import { windowHelpTexts } from '@ui/features/help/window-help';
import { getWindowType } from '@ui/workspace/registry';

const s = createTestServices({ platform: 'other' });
registerFeatures(s);

describe('window help ("?" in a title bar)', () => {
  const help = windowHelpTexts('Ctrl', 'Alt');

  it('describes windows that exist', () => {
    const missing = Object.keys(help).filter((type) => !getWindowType(type));
    expect(missing).toEqual([]);
  });

  it('only names key combinations that are bound', () => {
    const bound = new Set(s.keymap.all().map((b) => parseChord(b.chord, 'other')));
    const named: string[] = [];
    for (const [type, h] of Object.entries(help))
      for (const [how, what] of [...h.moves, ['', h.intro] as const])
        // "Ctrl+Shift+Z", "Alt+T": a modifier combination ending in a single key (mouse moves like "Ctrl+drag" have a word).
        for (const m of `${how} ${what}`.matchAll(
          /\b((?:Ctrl|Alt|Shift)(?:\+(?:Ctrl|Alt|Shift))*\+(?:[A-Z0-9]|F\d{1,2}))(?![A-Za-z])/g,
        ))
          named.push(`${type}: ${m[1]}`);
    expect(named.length).toBeGreaterThan(2);
    const unbound = named.filter((n) => !bound.has(parseChord(n.split(': ')[1]!, 'other')));
    expect(unbound).toEqual([]);
  });

  it('every window with help has a plain intro and moves that say what they do', () => {
    for (const [type, h] of Object.entries(help)) {
      expect(h.intro.length, type).toBeGreaterThan(20);
      expect(h.moves.length, type).toBeGreaterThan(0);
      for (const [how, what] of h.moves) {
        expect(how.trim(), type).not.toBe('');
        expect(what.trim(), type).not.toBe('');
      }
    }
  });
});

describe('the welcome screen', () => {
  it('its six parts open real commands', () => {
    for (const id of [
      'view.channelRack',
      'transport.playPause',
      'view.pianoRoll',
      'view.playlist',
      'view.mixer',
      'view.assistant',
    ])
      expect(s.commands.get(id), id).toBeTruthy();
  });
});
