import { describe, expect, it } from 'vitest';
import { Keymap, chordFromEvent, formatChord, parseChord, type KeyEventLike } from './keymap';
import { CommandRegistry } from './registry';

const ev = (p: Partial<KeyEventLike>): KeyEventLike => ({
  key: '',
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...p,
});

describe('parseChord', () => {
  it('maps Mod per platform and orders modifiers canonically', () => {
    expect(parseChord('Mod+Shift+z', 'mac')).toBe('Shift+Meta+Z');
    expect(parseChord('shift+mod+Z', 'other')).toBe('Ctrl+Shift+Z');
    expect(parseChord('Cmd+Alt+Ctrl+Shift+K', 'mac')).toBe('Ctrl+Alt+Shift+Meta+K');
  });

  it('normalizes key aliases', () => {
    expect(parseChord('space', 'mac')).toBe('Space');
    expect(parseChord('Del', 'mac')).toBe('Delete');
    expect(parseChord('f7', 'mac')).toBe('F7');
    expect(parseChord('Mod+=', 'mac')).toBe('Meta+Equal');
    expect(parseChord('Mod++', 'mac')).toBe('Meta+Equal');
    expect(parseChord('Alt+1', 'mac')).toBe('Alt+1');
  });

  it('rejects unknown modifiers', () => {
    expect(() => parseChord('Hyper+K', 'mac')).toThrow(/Unknown modifier/);
  });
});

describe('chordFromEvent', () => {
  it('uses the physical key for letters and digits (Option+1 on macOS)', () => {
    expect(chordFromEvent(ev({ key: '¡', code: 'Digit1', altKey: true }))).toBe('Alt+1');
    expect(chordFromEvent(ev({ key: 'Z', code: 'KeyZ', shiftKey: true, metaKey: true }))).toBe('Shift+Meta+Z');
  });

  it('handles space, function keys and named keys', () => {
    expect(chordFromEvent(ev({ key: ' ', code: 'Space' }))).toBe('Space');
    expect(chordFromEvent(ev({ key: 'F7', code: 'F7' }))).toBe('F7');
    expect(chordFromEvent(ev({ key: 'Delete', code: 'Delete' }))).toBe('Delete');
  });

  it('ignores bare modifier presses', () => {
    expect(chordFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: 'Meta', code: 'MetaRight', metaKey: true }))).toBeNull();
  });

  it('round-trips with parseChord', () => {
    const chord = chordFromEvent(ev({ key: 'z', code: 'KeyZ', metaKey: true }));
    expect(chord).toBe(parseChord('Mod+Z', 'mac'));
  });
});

describe('formatChord', () => {
  it('uses symbols on macOS', () => {
    expect(formatChord('Shift+Meta+Z', 'mac')).toBe('⇧⌘Z');
    expect(formatChord('Ctrl+Shift+Z', 'other')).toBe('Ctrl+Shift+Z');
    expect(formatChord('Space', 'mac')).toBe('Space');
  });
});

describe('Keymap', () => {
  it('prefers focus-scoped bindings, then the newest binding', () => {
    const km = new Keymap('mac');
    km.add([{ chord: 'Delete', command: 'global.delete' }]);
    km.add([{ chord: 'Delete', command: 'roll.delete', when: { focus: ['piano-roll'] } }]);
    km.add([{ chord: 'Delete', command: 'global.delete2' }]);
    expect(km.match('Delete', { focus: 'piano-roll', inInput: false })?.command).toBe('roll.delete');
    expect(km.match('Delete', { focus: 'mixer', inInput: false })?.command).toBe('global.delete2');
    expect(km.match('Delete', { focus: null, inInput: false })?.command).toBe('global.delete2');
  });

  it('skips bindings while typing unless allowed', () => {
    const km = new Keymap('mac');
    km.add([
      { chord: 'Space', command: 'transport.toggle' },
      { chord: 'Mod+S', command: 'file.save', when: { allowInInput: true } },
    ]);
    expect(km.match('Space', { focus: null, inInput: true })).toBeUndefined();
    expect(km.match('Meta+S', { focus: null, inInput: true })?.command).toBe('file.save');
  });

  it('removes bindings and lists chords for a command', () => {
    const km = new Keymap('other');
    const remove = km.add([
      { chord: 'F6', command: 'view.channelRack' },
      { chord: 'Alt+2', command: 'view.channelRack' },
    ]);
    expect(km.chordsFor('view.channelRack')).toEqual(['F6', 'Alt+2']);
    remove();
    expect(km.match('F6', { focus: null, inInput: false })).toBeUndefined();
    expect(km.chordsFor('view.channelRack')).toEqual([]);
  });
});

describe('CommandRegistry', () => {
  it('runs enabled commands with args and replaces on re-register', () => {
    const calls: string[] = [];
    const reg = new CommandRegistry<{ name: string }>();
    reg.bindContext(() => ({ name: 'ctx' }));
    reg.register<string>({ id: 'a', title: 'A', run: (ctx, arg) => void calls.push(`${ctx.name}:${arg}`) });
    expect(reg.run('a', 'x')).toBe(true);
    reg.register({ id: 'a', title: 'A2', run: () => void calls.push('replaced') });
    reg.run('a');
    expect(calls).toEqual(['ctx:x', 'replaced']);
    expect(reg.get('a')?.title).toBe('A2');
  });

  it('refuses disabled or missing commands', () => {
    const reg = new CommandRegistry<object>();
    reg.bindContext(() => ({}));
    reg.register({ id: 'off', title: 'Off', enabled: () => false, run: () => {} });
    expect(reg.run('off')).toBe(false);
    expect(reg.run('missing')).toBe(false);
    expect(reg.isEnabled('off')).toBe(false);
  });

  it('only unregisters the definition it registered', () => {
    const reg = new CommandRegistry<object>();
    reg.bindContext(() => ({}));
    const un1 = reg.register({ id: 'a', title: '1', run: () => {} });
    reg.register({ id: 'a', title: '2', run: () => {} });
    un1();
    expect(reg.get('a')?.title).toBe('2');
  });
});

describe('user shortcuts', () => {
  const ctx = { focus: null, inInput: false };
  const setup = () => {
    const km = new Keymap('mac');
    km.add([
      { chord: 'Space', command: 'play' },
      { chord: 'Mod+S', command: 'save' },
      { chord: 'Delete', command: 'delete-note', when: { focus: ['piano-roll'] } },
    ]);
    return km;
  };

  it('replace a command’s built-in chords, and win a clash with another command', () => {
    const km = setup();
    km.setUserBindings({ save: ['Mod+Shift+K'], 'open-mixer': ['Space'] });
    expect(km.chordsFor('save')).toEqual(['Shift+Meta+K']);
    expect(km.match('Meta+S', ctx)).toBeUndefined();
    expect(km.match('Shift+Meta+K', ctx)?.command).toBe('save');
    // Space now opens the mixer instead of playing.
    expect(km.commandForChord('Space')).toBe('open-mixer');
    expect(km.isCustomized('save')).toBe(true);
    expect(km.defaultChordsFor('save')).toEqual(['Meta+S']);
  });

  it('can leave a command without a shortcut, and reset back to the built-ins', () => {
    const km = setup();
    km.setUserBindings({ 'delete-note': [] });
    expect(km.match('Delete', { focus: 'piano-roll', inInput: false })).toBeUndefined();
    km.setUserBindings({});
    expect(km.match('Delete', { focus: 'piano-roll', inInput: false })?.command).toBe('delete-note');
    expect(km.isCustomized('delete-note')).toBe(false);
  });

  it('never fires while typing in a text field', () => {
    const km = setup();
    km.setUserBindings({ play: ['K'] });
    expect(km.match('K', { focus: null, inInput: true })).toBeUndefined();
  });
});
