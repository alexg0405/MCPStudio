/**
 * AI coverage audit (no DOM): every registered command and every window type must be reachable by Studio
 * (the chat and the MCP server drive the app through the same actions and command catalog). A command
 * counts as reachable when it is
 *   - in the command catalog (`ai` is not false) and, if it takes an argument, says so in its `argsHint`; or
 *   - covered by an action (COVERED_BY_OP: the command opens a dialog or acts on a UI selection that the action
 *     replaces with structured input); or
 *   - listed in NOT_FOR_AI with the reason it makes no sense for Studio.
 * A window type is reachable through the `open` action (OPEN_WINDOWS) or listed in WINDOWS_NOT_FOR_AI.
 *
 * A new feature that registers a command or window with no AI path fails here: give the command an `argsHint`
 * (or an action that covers it) before adding it to a list below. Never add to NOT_FOR_AI just to pass.
 */
import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { aiCommands } from '@app/ai/commands';
import { ACTION_OPS } from '@app/ai/schema';
import { OPEN_WINDOWS, WINDOWS_NOT_FOR_AI } from '@app/ai/ops/windows';
import { registerFeatures } from '@ui/features';
import { SCRIPT } from '@ui/features/piano-roll/menus';
import { getMenuItems, getMenus, type MenuItem } from '@ui/shell/menus';
import { windowTypes } from '@ui/workspace/registry';

const s = createTestServices();
registerFeatures(s);

/** Commands Studio must not run, each with the reason. */
const NOT_FOR_AI: Readonly<Record<string, string>> = {
  'ai.askSelection': 'a UI entry point that sends a request to Studio about the selection; the request itself is the Studio',
  'ai.askSection': 'a UI entry point that sends a request to Studio about a section; the request itself is the Studio',
  'ai.clearFocus': 'a UI control of the Studio window: which part of the song the next request is about',
  'view.assistant': 'Studio’s own window: opening or closing it in the middle of a conversation is the musician’s choice',
  'help.palette': 'the action search box: Studio is the search for what the musician wants to do',
};

/** Commands that open a dialog, a menu or work on a UI selection, and the action that does the same with arguments. */
const COVERED_BY_OP: Readonly<Record<string, string>> = {
  'decks.play': 'deck_play',
  'decks.sync': 'deck_sync',
  'decks.keyLock': 'deck_set',
  'decks.loop': 'deck_loop',
  'decks.crossfader': 'deck_crossfade',
  'arrange.develop': 'develop',
  'arrange.addFill': 'vary',
  'arrange.addTransition': 'transition',
  'arrange.refresh': 'develop',
  'filters.choose': 'filter',
  'filters.apply': 'filter',
  'filters.remove': 'remove_filter',
  'pianoRoll.quantizeTool': 'note_tool',
  'pianoRoll.arpeggiate': 'note_tool',
  'pianoRoll.strum': 'note_tool',
  'pianoRoll.chop': 'note_tool',
  'pianoRoll.glue': 'note_tool',
  'pianoRoll.randomize': 'note_tool',
  'pianoRoll.runScript': 'note_tool',
  'song.settings': 'song',
  'file.projectInfo': 'song',
  'channels.add': 'add_channel',
  'mixer.addInsert': 'add_insert',
  'mixer.routeSelectedChannel': 'edit_channel',
  'mixer.balance': 'level_mix',
  'audioClip.levels': 'edit_audio_clip',
  'options.audioInput': 'settings',
};

/** The piano-roll tool (script id) a note_tool-covered command stands for. */
const NOTE_TOOLS: Readonly<Record<string, string>> = {
  'pianoRoll.quantizeTool': SCRIPT.quantize,
  'pianoRoll.arpeggiate': SCRIPT.arpeggiate,
  'pianoRoll.strum': SCRIPT.strum,
  'pianoRoll.chop': SCRIPT.chop,
  'pianoRoll.glue': SCRIPT.glue,
  'pianoRoll.randomize': SCRIPT.randomize,
};

type Status = 'catalog' | 'op' | 'not for AI' | 'GAP';
interface Row {
  id: string;
  title: string;
  category: string;
  status: Status;
  note: string;
}

/** Commands that are given an argument by a key binding or a menu item (so they take one). */
function argUsers(): Map<string, string> {
  const users = new Map<string, string>();
  for (const b of s.keymap.all()) if (b.args !== undefined) users.set(b.command, 'a key binding passes an argument');
  const walk = (items: MenuItem[]) => {
    for (const i of items) {
      if (i.kind === 'submenu') walk(i.items());
      else if (i.kind === 'command' && i.args !== undefined) users.set(i.command, 'a menu item passes an argument');
    }
  };
  for (const m of getMenus()) walk(getMenuItems(m.id));
  return users;
}

function audit(): Row[] {
  const inCatalog = new Set(aiCommands(s).map((c) => c.id));
  const users = argUsers();
  return s.commands.list().map((def): Row => {
    const base = { id: def.id, title: def.title, category: def.category ?? '' };
    if (def.ai === false) {
      if (NOT_FOR_AI[def.id]) return { ...base, status: 'not for AI', note: NOT_FOR_AI[def.id]! };
      const op = COVERED_BY_OP[def.id];
      if (op) return { ...base, status: 'op', note: op };
      return { ...base, status: 'GAP', note: 'marked ai: false with no reason: list it in NOT_FOR_AI, or in COVERED_BY_OP with its action' };
    }
    const takesArgs = def.run.length >= 2 || users.has(def.id);
    if (takesArgs && !def.argsHint)
      return {
        ...base,
        status: 'GAP',
        note: `takes an argument (${def.run.length >= 2 ? 'run() declares one' : users.get(def.id)}) but has no argsHint`,
      };
    if (!inCatalog.has(def.id))
      return { ...base, status: 'GAP', note: 'not in the command catalog (all its key bindings pass arguments and it has no argsHint)' };
    return { ...base, status: 'catalog', note: def.argsHint ? `args: ${def.argsHint}` : '' };
  });
}

const opNames = new Set(ACTION_OPS.map((o) => o.properties.op.const));

describe('AI coverage: commands', () => {
  const rows = audit();

  it('every command is reachable by Studio (catalog, an action, or a written reason)', () => {
    const gaps = rows.filter((r) => r.status === 'GAP').map((r) => `${r.id} (${r.title}): ${r.note}`);
    expect(gaps, `commands Studio cannot reach:\n${gaps.join('\n')}`).toEqual([]);
  });

  it('NOT_FOR_AI and COVERED_BY_OP hold no stale entries', () => {
    const ids = new Set(s.commands.list().map((c) => c.id));
    for (const id of [...Object.keys(NOT_FOR_AI), ...Object.keys(COVERED_BY_OP)]) {
      expect(ids.has(id), `${id} is listed but is not a registered command`).toBe(true);
      expect(s.commands.get(id)!.ai, `${id} is listed but is not marked ai: false`).toBe(false);
    }
    for (const id of Object.keys(NOT_FOR_AI)) expect(COVERED_BY_OP[id], `${id} is in both lists`).toBeUndefined();
  });

  it('every reason is a real sentence, and every covering action exists', () => {
    for (const [id, why] of Object.entries(NOT_FOR_AI)) expect(why.length, id).toBeGreaterThan(20);
    for (const [id, op] of Object.entries(COVERED_BY_OP)) expect(opNames.has(op), `${id} → ${op}: no such action`).toBe(true);
  });

  it('the note_tool actions stand for piano-roll tools that are installed', () => {
    for (const [id, script] of Object.entries(NOTE_TOOLS)) expect(s.plugins.script(script), `${id} → ${script}`).toBeDefined();
  });

  it('the commands that act on a selection can be given one (the select action exists)', () => {
    expect(opNames.has('select')).toBe(true);
    const bySelection = rows.filter((r) => r.status === 'catalog' && /^(pianoRoll|playlist|audioClip|rack|channels)\./.test(r.id));
    expect(bySelection.length).toBeGreaterThan(20);
  });

  it('prints the coverage table', () => {
    const count = (st: Status) => rows.filter((r) => r.status === st).length;
    const reachable = rows.length - count('GAP');
    const lines: string[] = [
      '',
      `AI coverage: ${reachable}/${rows.length} commands reachable (${count('catalog')} in the catalog, ${count('op')} through an action, ${count('not for AI')} not for AI, ${count('GAP')} gaps)`,
    ];
    const cats = [...new Set(rows.map((r) => r.category || '(none)'))].sort();
    lines.push('', 'category'.padEnd(16) + 'catalog'.padStart(9) + 'action'.padStart(8) + 'not AI'.padStart(8) + 'gaps'.padStart(6));
    for (const c of cats) {
      const mine = rows.filter((r) => (r.category || '(none)') === c);
      const n = (st: Status) => mine.filter((r) => r.status === st).length;
      lines.push(c.padEnd(16) + String(n('catalog')).padStart(9) + String(n('op')).padStart(8) + String(n('not for AI')).padStart(8) + String(n('GAP')).padStart(6));
    }
    lines.push('', 'Through an action:');
    for (const r of rows.filter((x) => x.status === 'op')) lines.push(`  ${r.id.padEnd(30)} → ${r.note}`);
    lines.push('', 'Not for AI:');
    for (const r of rows.filter((x) => x.status === 'not for AI')) lines.push(`  ${r.id.padEnd(30)} ${r.note}`);
    console.log(lines.join('\n'));
    expect(reachable).toBe(rows.length);
  });
});

describe('AI coverage: windows', () => {
  it('every window type can be opened by the open action, or has a reason', () => {
    const missing = windowTypes().filter((t) => !(OPEN_WINDOWS as readonly string[]).includes(t) && !WINDOWS_NOT_FOR_AI[t]);
    expect(missing, `window types Studio cannot open: ${missing.join(', ')}`).toEqual([]);
  });

  it('the open action names no window type that does not exist, and the excluded ones are registered', () => {
    const types = new Set(windowTypes());
    for (const w of OPEN_WINDOWS) if (w !== 'browser') expect(types.has(w), `open: "${w}" is not a window type`).toBe(true);
    for (const t of Object.keys(WINDOWS_NOT_FOR_AI)) expect(types.has(t), `${t} is excluded but not registered`).toBe(true);
    for (const [t, why] of Object.entries(WINDOWS_NOT_FOR_AI)) expect(why.length, t).toBeGreaterThan(20);
  });
});
