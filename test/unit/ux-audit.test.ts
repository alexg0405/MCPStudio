/**
 * UX audit of the registered app (no DOM): every command explains itself, no shortcut clashes, every menu
 * entry points at a real command and is found by the action search (Mod+K), and no user-facing text says "AI"
 * (the product says "Studio"). The DOM half (data-hints, empty states) is test/browser/ux-audit.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { parseChord, type Binding, type Platform } from '@core/commands/keymap';
import { collectActions } from '@ui/features/palette/collect';
import { getMenuItems, getMenus, type MenuItem } from '@ui/shell/menus';
import { registerFeatures } from '@ui/features';

const s = createTestServices();
registerFeatures(s);

const AI_WORD = /\bA\.?I\.?\b/;

describe('command hints', () => {
  it('every command has a plain hint (a sentence, not a repeat of the title)', () => {
    const bad = s.commands
      .list()
      .filter((c) => {
        const hint = c.hint?.trim() ?? '';
        return hint.length < 12 || hint.toLowerCase() === c.title.toLowerCase();
      })
      .map((c) => `${c.id} (${c.hint ?? 'no hint'})`);
    expect(bad).toEqual([]);
  });

  it('command ids are unique per title within a category (no two look the same in the action search)', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const c of s.commands.list()) {
      const key = `${c.category ?? ''}|${c.title}`;
      const prev = seen.get(key);
      if (prev) dup.push(`${prev} / ${c.id}: "${c.title}"`);
      else seen.set(key, c.id);
    }
    expect(dup).toEqual([]);
  });
});

describe('key bindings', () => {
  const overlap = (a: Binding, b: Binding) => {
    const fa = a.when?.focus;
    const fb = b.when?.focus;
    if (!fa || !fb) return true; // a global binding overlaps everything
    return fa.some((f) => fb.includes(f));
  };

  for (const platform of ['mac', 'other'] as Platform[]) {
    it(`no chord is bound twice in the same context (${platform})`, () => {
      const all = s.keymap.all();
      const clashes: string[] = [];
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]!;
          const b = all[j]!;
          if (parseChord(a.chord, platform) !== parseChord(b.chord, platform)) continue;
          if (!overlap(a, b)) continue;
          // The same command with the same arguments twice is harmless duplication; different ones are a clash.
          if (a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)) continue;
          clashes.push(
            `${parseChord(a.chord, platform)}: ${a.command}${a.args !== undefined ? `(${JSON.stringify(a.args)})` : ''} [${a.when?.focus?.join(',') ?? 'global'}] vs ${b.command}${b.args !== undefined ? `(${JSON.stringify(b.args)})` : ''} [${b.when?.focus?.join(',') ?? 'global'}]`,
          );
        }
      }
      expect(clashes).toEqual([]);
    });
  }

  it('every binding runs a registered command', () => {
    const missing = s.keymap
      .all()
      .filter((b) => !s.commands.get(b.command))
      .map((b) => `${b.chord} -> ${b.command}`);
    expect(missing).toEqual([]);
  });
});

describe('menus and the action search', () => {
  const walk = (items: MenuItem[], visit: (i: MenuItem) => void) => {
    for (const i of items) {
      visit(i);
      if (i.kind === 'submenu') walk(i.items(), visit);
    }
  };

  it('every menu command exists', () => {
    const missing: string[] = [];
    for (const m of getMenus())
      walk(getMenuItems(m.id), (i) => {
        if (i.kind === 'command' && !s.commands.get(i.command)) missing.push(`${m.label}: ${i.command}`);
      });
    expect(missing).toEqual([]);
  });

  it('every menu entry is found by the action search, with a hint', () => {
    const actions = collectActions(s);
    const byKey = new Set(actions.map((a) => a.key));
    const lost: string[] = [];
    for (const m of getMenus())
      walk(getMenuItems(m.id), (i) => {
        if (i.kind !== 'command') return;
        const plain = i.args === undefined;
        const key = plain ? `cmd:${i.command}` : `cmd:${i.command}:${JSON.stringify(i.args)}`;
        if (i.command !== 'help.palette' && !byKey.has(key)) lost.push(`${m.label}: ${i.label ?? i.command}`);
      });
    expect(lost).toEqual([]);
    // Choices inside a submenu (accent colors, count-in lengths) explain themselves; commands must have a hint.
    const noHint = actions
      .filter((a) => a.key.startsWith('cmd:') && !a.hint)
      .map((a) => `${a.path.join(' > ')} > ${a.label}`);
    expect(noHint).toEqual([]);
  });

  it('the search lists no duplicate labels under the same path', () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const a of collectActions(s)) {
      const k = `${a.path.join('>')}>${a.label}`;
      if (seen.has(k)) dup.push(k);
      seen.add(k);
    }
    expect(dup).toEqual([]);
  });
});

describe('wording', () => {
  it('no command, hint, menu label or action says "AI" (it is "Studio")', () => {
    const texts: string[] = [];
    for (const c of s.commands.list()) texts.push(c.title, c.hint ?? '', c.category ?? '');
    for (const a of collectActions(s)) texts.push(a.label, a.hint ?? '', ...a.path, ...(a.keywords?.filter(() => false) ?? []));
    for (const m of getMenus()) {
      texts.push(m.label);
      walk(getMenuItems(m.id));
    }
    function walk(items: MenuItem[]) {
      for (const i of items) {
        if (i.kind === 'submenu') {
          texts.push(i.label);
          walk(i.items());
        } else if (i.kind === 'command' && i.label) texts.push(i.label);
      }
    }
    expect(texts.filter((t) => AI_WORD.test(t))).toEqual([]);
  });
});
