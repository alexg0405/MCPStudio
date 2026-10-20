import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { registerFeatures } from '..';
import { collectActions } from '../palette/collect';
import { searchActions } from '../palette/search';
import { TOURS } from '../tours/tour-list';
import { windowTypes } from '../../workspace/registry';
import { windowHelp, windowHelpLinks } from '../../workspace/window-help';
import { allFeatureEntries, buildFeatureMap } from './feature-map';
import { searchTopics } from './help-search';
import { collectHelpTopics, HELP_CATEGORIES } from './help-topics';

const s = createTestServices();
registerFeatures(s);
const topics = collectHelpTopics(s);
const AI_WORD = /\bA\.?I\.?\b/;

describe('help topics', () => {
  it('cover every category, each with something in it', () => {
    for (const { id } of HELP_CATEGORIES) expect(topics.filter((t) => t.category === id).length, id).toBeGreaterThan(0);
  });

  it('have unique ids and say something', () => {
    const ids = topics.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of topics) {
      expect(t.title.length, t.id).toBeGreaterThan(1);
      expect(t.summary.length, t.id).toBeGreaterThan(5);
    }
  });

  it('say “Studio”, never “AI”', () => {
    const bad = topics.flatMap((t) =>
      [t.title, t.summary, ...t.moves.flat()].filter((text) => AI_WORD.test(text)).map((text) => `${t.id}: ${text}`),
    );
    expect(bad).toEqual([]);
  });

  it('include every tour, every lesson, and a page for every window that has a “?”', () => {
    for (const tour of TOURS)
      expect(
        topics.some((t) => t.id === `tour:${tour.id}`),
        tour.id,
      ).toBe(true);
    for (const type of windowTypes())
      if (windowHelp(type))
        expect(
          topics.some((t) => t.id === `window:${type}`),
          type,
        ).toBe(true);
  });

  it('give every window a “?” text (the help window, the tours and the features page rely on it)', () => {
    const without = windowTypes().filter((type) => !windowHelp(type));
    expect(without).toEqual([]);
  });

  it('list the keyboard navigation and the touch gestures, and the shortcuts by area', () => {
    expect(topics.some((t) => t.id === 'keyboard:Everywhere')).toBe(true);
    expect(topics.some((t) => t.id === 'keyboard:screen-reader')).toBe(true);
    expect(topics.some((t) => t.category === 'Touch and gestures')).toBe(true);
    const transport = topics.find((t) => t.id === 'shortcuts:Transport');
    expect(transport?.moves.some(([keys, what]) => keys.length > 0 && what === 'Play / stop')).toBe(true);
  });

  it('give each topic a button that does what it says: start the tour, open the window, run the action', () => {
    expect(topics.find((t) => t.id === 'tour:first-song')?.action?.label).toBe('Start the tour');
    expect(topics.find((t) => t.id === 'window:mixer')?.action?.label).toBe('Open Mixer');
    expect(topics.find((t) => t.id === 'cmd:file.save')?.action?.label).toBe('Run it');
    // An action that needs an argument has no button of its own.
    expect(topics.find((t) => t.id === 'cmd:tour.start')?.action).toBeNull();
  });
});

describe('help search', () => {
  const first = (query: string, category: Parameters<typeof searchTopics>[2] = 'all') =>
    searchTopics(topics, query, category)[0]?.id;
  const found = (query: string) => searchTopics(topics, query).map((t) => t.id);

  it('finds the tour for a job in the musician’s words', () => {
    expect(first('record a vocal', 'Tours')).toBe('tour:record-vocal');
    expect(first('dj', 'Tours')).toBe('tour:dj-mixing');
    expect(first('clip launcher', 'Tours')).toBe('tour:clip-launcher');
    expect(first('chords', 'Tours')).toBe('tour:harmony-chords');
    expect(first('mastering', 'Tours')).toBe('tour:mix-master');
    expect(first('mcp', 'Tours')).toBe('tour:studio-mcp');
    expect(first('first song', 'Tours')).toBe('tour:first-song');
  });

  it('finds windows by what they do and by their moves', () => {
    expect(found('pitch')).toContain('window:pitch-editor');
    expect(found('snapshot')).toContain('window:mix-snapshots');
    expect(found('loudness')).toContain('window:meters');
    expect(found('crossfader')).toContain('window:dj-decks');
    expect(found('fade in')).toContain('window:playlist');
  });

  it('finds commands, shortcuts, keyboard moves and gestures', () => {
    expect(found('save a version')).toContain('cmd:versions.save');
    expect(found('undo')).toContain('shortcuts:Edit');
    expect(found('screen reader')).toContain('keyboard:screen-reader');
    expect(found('pinch')).toContain('touch:Playlist, piano roll, pitch editor and their rulers');
  });

  it('needs every word, so a longer search narrows', () => {
    expect(found('record vocal').length).toBeLessThanOrEqual(found('record').length);
    expect(found('zzzz nothing like this')).toEqual([]);
  });

  it('lists a category in its own order when there is no search, commands by group', () => {
    const tours = searchTopics(topics, '', 'Tours').map((t) => t.id);
    expect(tours).toEqual(TOURS.map((t) => `tour:${t.id}`));
    const commands = searchTopics(topics, '', 'Commands');
    const groups = commands.map((t) => t.group ?? '');
    expect(groups).toEqual([...groups].sort((a, b) => a.localeCompare(b)));
  });
});

describe('the action search’s “Learn:” rows', () => {
  const actions = collectActions(s);
  const learn = actions.filter((a) => a.label.startsWith('Learn: '));

  it('has one for every tour, lesson and window with help', () => {
    for (const tour of TOURS)
      expect(
        learn.some((a) => a.label === `Learn: ${tour.title}`),
        tour.id,
      ).toBe(true);
    expect(learn.some((a) => a.key.startsWith('learn:lesson:'))).toBe(true);
    expect(learn.some((a) => a.key === 'learn:window:mixer')).toBe(true);
  });

  it('is what a search for “learn” or a job finds first', () => {
    expect(searchActions(actions, 'learn record vocal')[0]?.label).toBe('Learn: Record and polish a vocal');
    expect(searchActions(actions, 'tutorial dj')[0]?.label).toBe('Learn: DJ mixing');
    expect(
      searchActions(actions, 'learn')
        .slice(0, 10)
        .every((a) => a.label.startsWith('Learn: ')),
    ).toBe(true);
  });

  it('says what it does in the hint and never says “AI”', () => {
    for (const a of learn) {
      expect(a.hint?.length, a.key).toBeGreaterThan(10);
      expect(AI_WORD.test(`${a.label} ${a.hint ?? ''}`), a.key).toBe(false);
    }
  });
});

describe('every window’s “?”', () => {
  it('links to its tour and to its page in Help', () => {
    for (const type of windowTypes()) {
      const labels = windowHelpLinks(type).map((l) => l.label);
      expect(
        labels.some((l) => l.startsWith('Take the tour: ')),
        `${type}: ${labels.join(' | ')}`,
      ).toBe(true);
      expect(labels, type).toContain('More in Help');
    }
  });
});

describe('the feature map', () => {
  const areas = buildFeatureMap(s);
  const entries = allFeatureEntries(areas);

  it('lists every window type, every tour and every top-level command category', () => {
    for (const type of windowTypes())
      expect(
        entries.some((e) => e.id === `window:${type}`),
        `window ${type}`,
      ).toBe(true);
    for (const tour of TOURS)
      expect(
        entries.some((e) => e.id === `tour:${tour.id}`),
        `tour ${tour.id}`,
      ).toBe(true);
    const categories = new Set(
      s.commands
        .list()
        .filter((c) => c.hint)
        .map((c) => c.category ?? 'Other'),
    );
    for (const category of categories) {
      const command = s.commands.list().find((c) => (c.category ?? 'Other') === category && c.hint)!;
      expect(
        entries.some((e) => e.id === `cmd:${command.id}`),
        `category ${category}`,
      ).toBe(true);
    }
    // Not just one per category: every command with a hint is somewhere.
    for (const c of s.commands.list().filter((x) => x.hint))
      expect(
        entries.some((e) => e.id === `cmd:${c.id}`),
        c.id,
      ).toBe(true);
  });

  it('files everything in an area (nothing is left in “More”): a new window or category needs an area in feature-map.ts', () => {
    const more = areas.find((a) => a.id === 'more');
    const left = more ? [...more.windows, ...more.tours, ...more.commands].map((e) => e.id) : [];
    expect(left, `register these in an area of feature-map.ts: ${left.join(', ')}`).toEqual([]);
  });

  it('lists nothing twice', () => {
    const ids = entries.map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('says where a command lives in the menus, and has a button for those that can run on their own', () => {
    const save = entries.find((e) => e.id === 'cmd:file.save')!;
    expect(save.where).toBe('File');
    expect(save.run).toBeTypeOf('function');
    expect(save.chord).toBeTruthy();
    const pitch = entries.find((e) => e.id === 'cmd:pitchEditor.openClip')!;
    expect(pitch.where).toBe('Playlist');
    // A command that needs an argument has no button; the page says it is used from a menu, a key or Studio.
    expect(entries.find((e) => e.id === 'cmd:tour.start')?.run).toBeUndefined();
  });

  it('gives windows their own button, except one that belongs to an instrument', () => {
    expect(entries.find((e) => e.id === 'window:mixer')?.run).toBeTypeOf('function');
    expect(entries.find((e) => e.id === 'window:plugin')?.run).toBeUndefined();
  });

  it('says “Studio”, never “AI”', () => {
    for (const a of areas)
      for (const e of [...a.windows, ...a.tours, ...a.commands])
        expect(AI_WORD.test(`${e.label} ${e.hint} ${e.where}`), e.id).toBe(false);
    for (const a of areas) expect(AI_WORD.test(`${a.title} ${a.summary}`), a.id).toBe(false);
  });
});
