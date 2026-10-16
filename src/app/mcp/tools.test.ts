import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAR, stackedSong } from '../../../test/helpers/focus';
import { afterStepFor, registerAfterStep } from '../assistant/after-steps';
import { createTestServices } from '../testing';
import type { AudioDeps } from './audio-tools';
import { clientLabel } from './common';
import { readTools } from '../ai/read';
import { TOOL_DEFS } from './defs';
import { createMcpTools, type McpTools } from './tools';
import type { ToolResult } from './types';

/** The MCP tools against real services (a FakeEngine, no audio): what an AI app gets back, and what it leaves behind. */

const CLAUDE = { client: { name: 'claude-code', version: '2.0' } };
const text = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
const master = { lufs: -7, shortTermMax: -6, peakDb: -0.1, truePeakDb: 0.4, rmsDb: -8, crestDb: 8, bands: [20, 30, 20, 15, 10, 5], width: 0.2, correlation: 0.9, silent: false };

function setup(audio: Partial<AudioDeps> = {}) {
  const s = createTestServices();
  const gesture = vi.fn();
  const tools: McpTools = createMcpTools(s, {
    gesture,
    audio: {
      analyze: vi.fn(async () => ({ what: '8 s: bars 1–4 of the song', seconds: 8, master, tracks: [], notes: ['The master is very loud (−7.0 LUFS).'] })) as unknown as AudioDeps['analyze'],
      preview: vi.fn(async () => ({ wav: new Uint8Array([82, 73, 70, 70]), seconds: 2, what: 'bars 1–2' })),
      exportAudio: vi.fn(async (_s, _settings, target) => {
        if (target.kind === 'memory') target.files.set(target.name, new Uint8Array([1, 2, 3]));
        return { names: [target.name], seconds: 4 };
      }) as unknown as AudioDeps['exportAudio'],
      upload: vi.fn(async (_t, f) => `/Users/me/Music/AGstudio/${f.folder ? `${f.folder}/` : ''}${f.name}`),
      ...audio,
    },
  });
  const call = (name: string, args: Record<string, unknown> = {}, ctx = CLAUDE) => tools.call(name, args, ctx);
  return { s, tools, call, gesture };
}

const ids = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id);

describe('the tool list', () => {
  it('has a runtime for every definition and a definition for every runtime', () => {
    const { tools } = setup();
    expect(tools.names().sort()).toEqual(TOOL_DEFS.map((t) => t.name).sort());
  });

  it('describes every tool for the AI: a name AI apps accept, a description, an object schema, a hint', () => {
    for (const t of TOOL_DEFS) {
      expect(t.name, t.name).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
      expect(t.description.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.annotations, t.name).toBeDefined();
    }
    expect(new Set(TOOL_DEFS.map((t) => t.name)).size).toBe(TOOL_DEFS.length);
  });

  it('takes the Studio action schema for apply_actions', () => {
    const t = TOOL_DEFS.find((x) => x.name === 'apply_actions')!;
    const props = t.inputSchema.properties as Record<string, { type?: string; items?: { anyOf?: unknown[] } }>;
    expect(props.actions?.type).toBe('array');
    expect(props.actions?.items?.anyOf?.length).toBeGreaterThan(20);
    expect(t.inputSchema.required).toEqual(['actions']);
  });

  it('names clients the way people say them', () => {
    expect(clientLabel({ name: 'claude-code' })).toBe('Claude Code');
    expect(clientLabel({ name: 'claude-ai' })).toBe('Claude');
    expect(clientLabel({ name: 'my_cool-client' })).toBe('My Cool Client');
    expect(clientLabel({ name: 'Cursor' })).toBe('Cursor');
    expect(clientLabel(undefined)).toBe('An AI app');
  });
});

describe('reading the project', () => {
  it('get_project is the text the Studio chat sends Claude', async () => {
    const { call } = setup();
    const r = await call('get_project');
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^Song: \d+ BPM/);
    expect(text(r)).toContain('Channels (channel rack order):');
    expect(text(r)).toContain('Mixer tracks');
    expect(text(r)).toContain('Playlist');
  });

  it('get_project with a focus adds the part in detail', async () => {
    const { s } = stackedSong();
    const tools = createMcpTools(s);
    const r = await tools.call('get_project', { focus: { from_bar: 17, to_bar: 32 } }, CLAUDE);
    expect(text(r)).toContain('<focus>');
    expect(text(r)).toMatch(/bars 17–32/);
    expect((await tools.call('get_project', { focus: { from_bar: 9, to_bar: 3 } }, CLAUDE)).isError).toBe(true);
  });

  it('list_plugins gives every plugin with its settings', async () => {
    const { call } = setup();
    const r = text(await call('list_plugins'));
    expect(r).toContain('agstudio.reverb');
  });

  it('get_guide prefaces the Studio guide with how to use it over MCP', async () => {
    const { call } = setup();
    const r = text(await call('get_guide'));
    expect(r).toMatch(/^You are driving AGstudio through MCP tools/);
    expect(r).toContain('You are Studio');
    expect(r).toContain('apply_actions');
  });

  it('offers every read tool the Studio chat has, and its JSON back as text and data', async () => {
    const { s, call } = setup();
    const names = TOOL_DEFS.map((t) => t.name);
    for (const t of readTools) expect(names, t.name).toContain(t.name === 'get_project' ? 'get_project_summary' : t.name);
    // The two get_project tools do not share a name: the full text and the JSON overview.
    expect(text(await call('get_project'))).toMatch(/^Song: /);
    const overview = await call('get_project_summary');
    expect(overview.structuredContent).toMatchObject({ bpm: s.doc.getState().project.transport.bpm });
    expect(JSON.parse(text(overview))).toEqual(overview.structuredContent);
    expect((await call('get_transport')).structuredContent).toMatchObject({ playing: false });
  });

  it('reads pattern notes, the mixer and the playlist', async () => {
    const { s, call } = setup();
    await call('apply_actions', {
      summary: 'a beat',
      actions: [{ op: 'beat', title: 'Test beat', bars: 1, tracks: [{ name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 8 }] }] }],
    });
    const notes = await call('get_pattern_notes', { channel: 'Kick' });
    expect(notes.isError).toBeUndefined();
    expect(text(notes)).toContain('"Kick"');
    const mixer = await call('get_mixer');
    expect(text(mixer)).toContain('Master');
    expect(mixer.structuredContent).toBeDefined();
    expect((await call('get_clips', {})).isError).toBeUndefined();
    expect(s.history.steps().done).toHaveLength(1);
  });

  it('turns a bad argument to a read tool into an error the AI can fix', async () => {
    const { call } = setup();
    const r = await call('get_pattern_notes', { pattern: 'no such pattern' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no such pattern|pattern/i);
  });

  it('reads the clips of a stacked song by track and bars', async () => {
    const { s } = stackedSong();
    const tools = createMcpTools(s);
    const all = await tools.call('get_clips', { tracks: [1], from_bar: 17, to_bar: 18 }, CLAUDE);
    expect(all.isError).toBeUndefined();
    const clips = (all.structuredContent as { clips: { track: number }[] }).clips;
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((c) => c.track === 1)).toBe(true);
  });
});

describe('apply_actions', () => {
  it('applies the actions as ONE undo step labelled with the client, and says how to go back', async () => {
    const { s, call } = setup();
    const before = s.history.status();
    const bpm = s.doc.getState().project.transport.bpm;
    const r = await call('apply_actions', {
      summary: 'Slowed it down and set the key',
      actions: [{ op: 'song', bpm: bpm + 20 }, { op: 'song', key: 'F minor' }],
    });
    expect(r.isError).toBeUndefined();
    const p = s.doc.getState().project;
    expect(p.transport.bpm).toBe(bpm + 20);
    expect(p.transport.key).toEqual({ root: 5, scale: 'minor' });
    const steps = s.history.steps().done;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe('Claude Code: Slowed it down and set the key');
    const data = r.structuredContent as { applied: boolean; before_point: number; undo_point: number; history_label: string; changes: string[]; warnings: string[] };
    expect(data).toMatchObject({ applied: true, before_point: before.cursor, undo_point: s.history.status().cursor, history_label: 'Claude Code: Slowed it down and set the key', warnings: [] });
    expect(data.changes.length).toBeGreaterThan(0);
    expect(text(r)).toContain('one undo step');
    // One undo takes it all back.
    s.history.undo();
    expect(s.doc.getState().project.transport.bpm).toBe(bpm);
    expect(s.doc.getState().project.transport.key).toBeUndefined();
  });

  it('shows the edit in the Studio chat as the client\'s message, with the Undo point', async () => {
    const { s, call } = setup();
    await call('apply_actions', { summary: 'Changed the tempo', actions: [{ op: 'song', bpm: 100 }] });
    const msgs = s.assistant.store.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from: 'assistant',
      text: 'Claude Code changed: Changed the tempo',
      detail: 'over MCP',
      undo: s.history.status().cursor,
    });
    expect(msgs[0]!.changes?.[0]).toMatch(/tempo 100 BPM/);
    // The chat's Undo button goes back to the step before that point: the project is as it was.
    s.history.goTo(0);
    expect(s.doc.getState().project.transport.bpm).not.toBe(100);
  });

  it('skips what cannot apply, with a warning, and applies the rest', async () => {
    const { s, call } = setup();
    const r = await call('apply_actions', {
      summary: 'Mixed bag',
      actions: [{ op: 'song', bpm: 90 }, { op: 'edit_channel', channel: 'No such channel', volume_db: -3 }, { op: 'nonsense' }],
    });
    expect(s.doc.getState().project.transport.bpm).toBe(90);
    const data = r.structuredContent as { warnings: string[] };
    expect(data.warnings.join(' ')).toMatch(/channel/i);
    expect(text(r)).toMatch(/1 action was skipped/);
    expect(s.history.steps().done).toHaveLength(1);
  });

  it('refuses an empty or unknown action list and changes nothing', async () => {
    const { s, call } = setup();
    const before = s.doc.getState().project;
    expect((await call('apply_actions', { actions: [] })).isError).toBe(true);
    expect((await call('apply_actions', { actions: [{ op: 'nonsense' }] })).isError).toBe(true);
    expect((await call('apply_actions', { actions: 'no' as unknown as [] })).isError).toBe(true);
    expect(s.doc.getState().project).toBe(before);
    expect(s.history.steps().done).toHaveLength(0);
  });

  it('says nothing changed when the actions change nothing', async () => {
    const { s, call } = setup();
    const bpm = s.doc.getState().project.transport.bpm;
    const r = await call('apply_actions', { summary: 'Nothing', actions: [{ op: 'song', bpm }] });
    expect(text(r)).toMatch(/Nothing in the project changed/);
    expect(s.history.steps().done).toHaveLength(0);
  });

  it('waits for follow-up steps (leveling) and reports them, in the same undo step', async () => {
    const { s, call } = setup();
    const real = afterStepFor('level_mix');
    registerAfterStep('level_mix', async (_item, c) => {
      // A follow-up edit is folded into the answer's undo entry.
      s.history.transact('Level', (d) => void (d.transport.swing = 0.3), { amend: c.entry ?? undefined });
      return { message: 'Leveled the mix', changes: ['Master −1 dB'] };
    });
    try {
      const r = await call('apply_actions', { summary: 'Mix it', actions: [{ op: 'song', bpm: 111 }, { op: 'level_mix' }] });
      expect(text(r)).toContain('Leveled the mix');
      expect((r.structuredContent as { followups: string[] }).followups).toEqual(['Leveled the mix', 'Master −1 dB']);
      expect(s.doc.getState().project.transport.swing).toBe(0.3);
      expect(s.history.steps().done).toHaveLength(1);
      s.history.undo();
      expect(s.doc.getState().project.transport.bpm).not.toBe(111);
      expect(s.doc.getState().project.transport.swing).not.toBe(0.3);
    } finally {
      if (real) registerAfterStep('level_mix', real);
    }
  });

  it('runs edits one at a time, in the order they arrive', async () => {
    const { s, call } = setup();
    const results = await Promise.all([
      call('apply_actions', { summary: 'one', actions: [{ op: 'song', bpm: 101 }] }),
      call('apply_actions', { summary: 'two', actions: [{ op: 'song', bpm: 102 }] }),
      call('apply_actions', { summary: 'three', actions: [{ op: 'song', bpm: 103 }] }),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(s.doc.getState().project.transport.bpm).toBe(103);
    expect(s.history.steps().done.map((d) => d.label)).toEqual(['Claude Code: one', 'Claude Code: two', 'Claude Code: three']);
  });

  it('does not start or stop the music unless the actions ask for it', async () => {
    const { s, call } = setup();
    await call('apply_actions', { summary: 'x', actions: [{ op: 'song', bpm: 99 }] });
    expect(s.engine.playing).toBe(false);
    await call('apply_actions', { summary: 'play', actions: [{ op: 'transport', action: 'play' }] });
    expect(s.engine.playing).toBe(true);
  });
});

describe('apply_actions on a part of the song', () => {
  const outside = [{ op: 'place_pattern', pattern: 'Drop', bar: 1, track: 1 }];

  it('asks first when the edit reaches outside the part, and changes nothing', async () => {
    const { s } = stackedSong();
    const tools = createMcpTools(s);
    const before = s.doc.getState().project;
    const r = await tools.call('apply_actions', { summary: 'A drop at the start', actions: outside, focus: { from_bar: 17, to_bar: 29 } }, CLAUDE);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^Not applied yet\. This edit also changes things outside bars 17–29/);
    expect(text(r)).toContain('approve_outside: true');
    expect(r.structuredContent).toMatchObject({ applied: false, needs_approval: true });
    expect(s.doc.getState().project).toBe(before);
    expect(s.history.steps().done).toHaveLength(0);
    expect(s.assistant.store.getState().messages).toHaveLength(0);
  });

  it('applies it with approve_outside, as one undo step', async () => {
    const { s } = stackedSong();
    const tools = createMcpTools(s);
    const before = s.doc.getState().project;
    const r = await tools.call('apply_actions', { summary: 'A drop at the start', actions: outside, focus: { from_bar: 17, to_bar: 29 }, approve_outside: true }, CLAUDE);
    expect(r.structuredContent).toMatchObject({ applied: true });
    expect(s.history.steps().done).toHaveLength(1);
    expect(s.doc.getState().project).not.toBe(before);
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('applies an edit that stays inside the part without asking', async () => {
    const { s } = stackedSong();
    const tools = createMcpTools(s);
    const r = await tools.call(
      'apply_actions',
      { summary: 'Snare', actions: [{ op: 'write_notes', pattern: 'Drop', channel: 'Snare', notes: [{ step: 8 }] }], focus: { from_bar: 37, to_bar: 52 } },
      CLAUDE,
    );
    expect(r.structuredContent).toMatchObject({ applied: true });
    expect(s.history.steps().done).toHaveLength(1);
    expect(BAR).toBe(3840);
  });
});

describe('commands', () => {
  it('lists commands with ids, hints and arguments', async () => {
    const { s, call } = setup();
    s.commands.register<string>({ id: 'test.shout', title: 'Shout', category: 'Test', hint: 'Says it loud', argsHint: 'a word', run: () => {} });
    const r = await call('list_commands', {});
    expect(text(r)).toContain('test.shout "Shout": Says it loud [args: a word]');
    expect(text(r)).toContain('(run with run_command)');
    const data = r.structuredContent as { commands: { id: string; args?: string }[] };
    expect(data.commands.find((c) => c.id === 'test.shout')).toMatchObject({ title: 'Shout', args: 'a word', category: 'Test' });
    const found = await call('list_commands', { search: 'shout' });
    expect(ids((found.structuredContent as { commands: { id: string }[] }).commands)).toEqual(['test.shout']);
  });

  it('runs a command with its argument', async () => {
    const { s, call } = setup();
    const run = vi.fn();
    s.commands.register<string>({ id: 'test.shout', title: 'Shout', hint: 'Says it loud', argsHint: 'a word', run: (_s, a) => run(a) });
    const r = await call('run_command', { id: 'test.shout', args: 'hey' });
    expect(r.isError).toBeUndefined();
    expect(run).toHaveBeenCalledWith('hey');
    expect(text(r)).toBe('Ran "Shout".');
  });

  it('puts a command that changed the project in the chat, with Undo', async () => {
    const { s, call } = setup();
    s.commands.register({ id: 'test.tempo', title: 'Make it 77', hint: 'Sets 77 BPM', argsHint: 'none', run: (c) => void c.history.transact('Tempo 77', (d) => void (d.transport.bpm = 77)) });
    const r = await call('run_command', { id: 'test.tempo' });
    expect(r.structuredContent).toMatchObject({ ran: true, changed_project: true });
    const msg = s.assistant.store.getState().messages[0]!;
    expect(msg).toMatchObject({ text: 'Claude Code ran “Make it 77”', undo: s.history.status().cursor });
  });

  it('reports a command that complains with a toast', async () => {
    const { s, call } = setup();
    s.commands.register({ id: 'test.fail', title: 'Fail', hint: 'Complains', argsHint: 'none', run: (c) => c.session.getState().toast('Nothing to fail at.', 'error') });
    const r = await call('run_command', { id: 'test.fail' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Nothing to fail at.');
  });

  it('turns a file-dialog command into a button for the musician instead of running it', async () => {
    const { s, call, gesture } = setup();
    const run = vi.fn();
    s.commands.register({ id: 'test.save', title: 'Save as…', hint: 'Saves a file', argsHint: 'none', gesture: true, run });
    const r = await call('run_command', { id: 'test.save', args: { a: 1 } });
    expect(run).not.toHaveBeenCalled();
    expect(gesture).toHaveBeenCalledWith('Claude Code', 'test.save', { a: 1 });
    expect(text(r)).toMatch(/needs? the musician|only allows that right after a click/);
    expect(r.structuredContent).toMatchObject({ ran: false, waiting_for_click: true });
  });

  it('refuses unknown, disabled and AI-hidden commands with a reason', async () => {
    const { s, call } = setup();
    s.commands.register({ id: 'test.off', title: 'Off', hint: 'Disabled', argsHint: 'none', enabled: () => false, run: () => {} });
    s.commands.register({ id: 'test.hidden', title: 'Hidden', hint: 'For the musician', argsHint: 'none', ai: false, run: () => {} });
    expect(text(await call('run_command', { id: 'nope.nothing' }))).toMatch(/No command "nope.nothing"/);
    expect(text(await call('run_command', { id: 'test.off' }))).toMatch(/isn't available right now/);
    expect((await call('run_command', { id: 'test.hidden' })).isError).toBe(true);
    expect((await call('run_command', {})).isError).toBe(true);
  });

  it('hands a file-dialog command inside apply_actions to the musician too', async () => {
    const { s, call, gesture } = setup();
    s.commands.register({ id: 'test.pick', title: 'Pick a file…', hint: 'Opens a picker', argsHint: 'none', gesture: true, run: () => {} });
    const r = await call('apply_actions', { summary: 'Export', actions: [{ op: 'command', id: 'test.pick' }] });
    expect(gesture).toHaveBeenCalledWith('Claude Code', 'test.pick', undefined);
    expect(text(r)).toContain("waiting for the musician's click");
  });
});

describe('transport', () => {
  it('reports the state and plays, seeks, loops and stops', async () => {
    const { s, call } = setup();
    const st0 = (await call('transport_state')).structuredContent as { playing: boolean; bar: number; loop: unknown; bpm: number };
    expect(st0).toMatchObject({ playing: false, bar: 1, loop: null });

    await call('play', { from_bar: 3 });
    expect(s.engine.playing).toBe(true);
    expect(s.view.getState().mode).toBe('song');
    expect(s.view.getState().songStart).toBe(2 * 3840);

    await call('stop');
    expect(s.engine.playing).toBe(false);

    await call('set_loop', { from_bar: 5, to_bar: 8 });
    expect(s.view.getState().loop).toEqual({ start: 4 * 3840, end: 8 * 3840 });
    expect(((await call('transport_state')).structuredContent as { loop: unknown }).loop).toEqual({ from_bar: 5, to_bar: 8 });
    await call('play');
    expect(s.engine.playing).toBe(true);
    await call('stop');
    await call('set_loop', { clear: true });
    expect(s.view.getState().loop).toBeNull();

    await call('seek', { bar: 9 });
    expect(s.view.getState().songStart).toBe(8 * 3840);

    await call('play', { loop_from_bar: 2, loop_to_bar: 3 });
    expect(s.view.getState().loop).toEqual({ start: 3840, end: 3 * 3840 });
  });

  it('plays a pattern by name and refuses bad input', async () => {
    const { s, call } = setup();
    await call('apply_actions', { summary: 'p', actions: [{ op: 'add_pattern', name: 'Verse' }] });
    const id = s.doc.getState().project.patternOrder.find((p) => s.doc.getState().project.patterns[p]?.name === 'Verse')!;
    const r = await call('play', { pattern: 'Verse' });
    expect(r.isError).toBeUndefined();
    expect(s.view.getState()).toMatchObject({ mode: 'pattern', currentPatternId: id });
    expect((await call('play', { pattern: 'Nope' })).isError).toBe(true);
    expect((await call('play', { loop_from_bar: 4 })).isError).toBe(true);
    expect((await call('seek', { bar: 0 })).isError).toBe(true);
    expect((await call('set_loop', { from_bar: 4, to_bar: 2 })).isError).toBe(true);
  });

  it('warns that sound is locked until a click when the browser has not unlocked it', async () => {
    const { s, call } = setup();
    Object.defineProperty(s.fakeEngine, 'state', { value: 'suspended', configurable: true });
    expect(text(await call('play', { from_bar: 1 }))).toMatch(/clicks once inside AGstudio/);
    expect(text(await call('transport_state'))).toMatch(/not unlocked sound/);
  });
});

describe('undo, redo and history', () => {
  async function made() {
    const k = setup();
    await k.call('apply_actions', { summary: 'first', actions: [{ op: 'song', bpm: 101 }] });
    await k.call('apply_actions', { summary: 'second', actions: [{ op: 'song', bpm: 102 }] });
    return k;
  }

  it('lists the history with points', async () => {
    const { call } = await made();
    const h = (await call('history')).structuredContent as { done: { point: number; label: string }[]; undone: unknown[] };
    expect(h.done.map((d) => d.label)).toEqual(['Claude Code: first', 'Claude Code: second']);
    expect(h.undone).toEqual([]);
    expect(text(await call('history'))).toContain('Claude Code: second (point');
  });

  it('undoes and redoes steps and says so in the chat', async () => {
    const { s, call } = await made();
    const r = await call('undo', {});
    expect(text(r)).toMatch(/Undid 1 step: Claude Code: second/);
    expect(s.doc.getState().project.transport.bpm).toBe(101);
    expect(s.assistant.store.getState().messages.at(-1)?.text).toBe('Claude Code undid: Claude Code: second');
    await call('redo', {});
    expect(s.doc.getState().project.transport.bpm).toBe(102);
    await call('undo', { steps: 2 });
    expect(s.history.status().canUndo).toBe(false);
    expect((await call('undo', {})).isError).toBe(true);
    expect((await call('redo', { steps: 2 })).structuredContent).toMatchObject({ redone: 2 });
    expect((await call('redo', {})).isError).toBe(true);
  });

  it('goes back to a point apply_actions returned', async () => {
    const { s, call } = setup();
    const a = await call('apply_actions', { summary: 'first', actions: [{ op: 'song', bpm: 101 }] });
    const b = await call('apply_actions', { summary: 'second', actions: [{ op: 'song', bpm: 102 }] });
    const c = await call('apply_actions', { summary: 'third', actions: [{ op: 'song', bpm: 103 }] });
    const point = (a.structuredContent as { undo_point: number }).undo_point;
    expect((b.structuredContent as { before_point: number }).before_point).toBe(point);
    const r = await call('undo', { to_point: point });
    expect(s.doc.getState().project.transport.bpm).toBe(101);
    expect(text(r)).toMatch(/Undid 2 steps/);
    const start = (a.structuredContent as { before_point: number }).before_point;
    await call('undo', { to_point: start });
    expect(s.history.status().canUndo).toBe(false);
    expect((await call('undo', { to_point: 987654 })).isError).toBe(true);
    expect((c.structuredContent as { applied: boolean }).applied).toBe(true);
  });
});

describe('listening and rendering', () => {
  it('analyze_mix reports the findings', async () => {
    const { call } = setup();
    const r = await call('analyze_mix', {});
    expect(text(r)).toContain('Listened to 8 s: bars 1–4 of the song.');
    expect(text(r)).toContain('The master is very loud');
    expect((r.structuredContent as { findings: string[] }).findings).toEqual(['The master is very loud (−7.0 LUFS).']);
  });

  it('analyze_mix listens to the bars asked for, and says when it cannot', async () => {
    const analyze = vi.fn(async () => {
      throw new Error('nothing plays');
    });
    const { call } = setup({ analyze: analyze as unknown as AudioDeps['analyze'] });
    const r = await call('analyze_mix', { bars: { from_bar: 2, to_bar: 3 } });
    expect(analyze).toHaveBeenCalledWith(expect.anything(), { range: { from: 3840, to: 3 * 3840 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/nothing plays/);
  });

  it('render_preview returns a WAV as audio content, capped at 30 s', async () => {
    const preview = vi.fn(async () => ({ wav: new Uint8Array([82, 73, 70, 70]), seconds: 2, what: 'bars 1–2' }));
    const { call } = setup({ preview });
    const r = await call('render_preview', { bars: { from_bar: 1, to_bar: 2 }, max_seconds: 999 });
    expect(r.content[1]).toEqual({ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' });
    expect(text(r)).toContain('Rendered bars 1–2');
    expect(preview).toHaveBeenCalledWith(expect.anything(), { from: 1, to: 2 }, 30);
    await call('render_preview', {});
    expect(preview).toHaveBeenLastCalledWith(expect.anything(), undefined, 15);
  });

  it('export_audio renders in memory and hands the file to the dev server, which writes it', async () => {
    const { call } = setup();
    // An empty project has no song: bars given.
    const r = await call('export_audio', { bars: { from_bar: 1, to_bar: 2 }, format: 'flac', file_name: 'Demo' }, { ...CLAUDE, ticket: 'tk' } as typeof CLAUDE);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe('Exported 4 s of audio to /Users/me/Music/AGstudio/Demo.flac.');
    expect(r.structuredContent).toMatchObject({ files: ['/Users/me/Music/AGstudio/Demo.flac'], format: 'flac' });
  });

  it('export_audio needs a ticket from the dev server; with an empty playlist it exports the current pattern', async () => {
    const { s, call } = setup();
    expect((await call('export_audio', {})).isError).toBe(true);
    const r = await call('export_audio', {}, { ...CLAUDE, ticket: 'tk' } as typeof CLAUDE);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^Exported \d+ s of audio to /);
    expect(s.prefs.getState().exportCodec).toBe('wav');
  });

  it('export_audio puts stems in a folder', async () => {
    const exportAudio = vi.fn(async (_s, _set, target) => {
      if (target.kind === 'memory') {
        target.files.set('Demo - Kick.wav', new Uint8Array([1]));
        target.files.set('Demo - Snare.wav', new Uint8Array([2]));
      }
      return { names: [], seconds: 3 };
    });
    const { call } = setup({ exportAudio: exportAudio as unknown as AudioDeps['exportAudio'] });
    const r = await call('export_audio', { bars: { from_bar: 1, to_bar: 2 }, stems: true, file_name: 'Demo' }, { ...CLAUDE, ticket: 'tk' } as typeof CLAUDE);
    expect(text(r)).toBe('Exported 2 stems (4 s each) to the folder /Users/me/Music/AGstudio/Demo (stems).');
  });
});

afterEach(() => vi.restoreAllMocks());
