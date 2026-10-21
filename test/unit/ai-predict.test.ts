/**
 * Which plugins and commands Studio attaches details for (src/app/ai/predict.ts), checked against requests a musician
 * would type (test/helpers/predict-cases.ts: what a correct answer to each needs, as lists of alternatives). The guess has to
 * include at least one alternative of at least 90 % of the needs, within the budget of 8 plugins and 30 commands. A miss
 * costs a read-tool call, not a wrong answer, but a high recall is the point of the guess.
 *
 * The producers' words (`predict-words.ts`) were tuned on `TUNED_REQUESTS`. `HELD_OUT_REQUESTS` was written before that and not
 * looked at while tuning: it says what the guess does on requests it was not fitted to.
 */
import { describe, expect, it } from 'vitest';
import { createTestServices } from '@app/testing';
import { DEFAULT_DETAILS_BUDGET, predictItems } from '@app/ai/predict';
import { registerFeatures } from '@ui/features';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { MASTER } from '@core/model/types';
import { resolveFocus } from '@app/ai/focus';
import { BAR, project, stackedSong } from '../helpers/focus';
import { HELD_OUT_REQUESTS, TUNED_REQUESTS, type PredictCase } from '../helpers/predict-cases';

const services = createTestServices();
registerFeatures(services);

const guessFor = (request: string) => new Set(predictItems(services, { request }).map((item) => item.id));

/** Needs met, needs total, and the needs that were missed (for the failure message). */
function score(cases: readonly PredictCase[]) {
  let met = 0;
  let total = 0;
  const missed: string[] = [];
  for (const { request, needs } of cases) {
    const guess = guessFor(request);
    for (const need of needs) {
      total++;
      if (need.some((id) => guess.has(id))) met++;
      else missed.push(`"${request}" needs ${need.join(' or ')}`);
    }
  }
  return { met, total, recall: met / total, missed };
}

describe('guessing what a request needs', () => {
  it('finds the plugins and commands a correct answer needs (recall of at least 90 %)', () => {
    const { recall, missed, met, total } = score(TUNED_REQUESTS);
    expect(recall, `${met}/${total}; missed:\n${missed.join('\n')}`).toBeGreaterThanOrEqual(0.9);
  });

  it('holds on requests it was not tuned on (at least 80 %)', () => {
    const { recall, missed, met, total } = score(HELD_OUT_REQUESTS);
    expect(recall, `${met}/${total}; missed:\n${missed.join('\n')}`).toBeGreaterThanOrEqual(0.8);
  });

  it('stays within the budget', () => {
    for (const { request } of [...TUNED_REQUESTS, ...HELD_OUT_REQUESTS]) {
      const items = predictItems(services, { request });
      const count = (kinds: string[]) => items.filter((item) => kinds.includes(item.kind)).length;
      expect(count(['instrument', 'effect', 'tool']), request).toBeLessThanOrEqual(DEFAULT_DETAILS_BUDGET.plugins);
      expect(count(['chain']), request).toBeLessThanOrEqual(DEFAULT_DETAILS_BUDGET.chains);
      expect(count(['command']), request).toBeLessThanOrEqual(DEFAULT_DETAILS_BUDGET.commands);
    }
  });

  it('attaches no command and no chain for a request that is not about the studio', () => {
    for (const request of ['what is the capital of france?', '']) {
      const items = predictItems(services, { request });
      expect(items.filter((item) => item.kind === 'command' || item.kind === 'chain'), request).toEqual([]);
    }
  });

  it('is the same every time', () => {
    const first = predictItems(services, { request: 'sidechain the bass to the kick' }).map((item) => item.id);
    const again = predictItems(services, { request: 'sidechain the bass to the kick' }).map((item) => item.id);
    expect(again).toEqual(first);
  });
});

describe('guessing from the part of the song a request is about', () => {
  it('adds the plugins of the channels that play in that part', () => {
    const { s } = stackedSong();
    const song = project(s);
    const from = 36 * BAR;
    const to = 44 * BAR;
    const focus = resolveFocus(song, { kind: 'range', from, to, projectId: song.projectId })!;
    // Independently: the plugin of every channel with notes in a pattern that has a clip in those bars.
    const wanted = new Set<string>();
    for (const clip of Object.values(song.playlist.clips)) {
      if (clip.kind !== 'pattern' || clip.start + clip.length <= from || clip.start >= to) continue;
      for (const channelId of Object.keys(song.patterns[clip.patternId]?.notes ?? {})) {
        const channel = song.channels[channelId as keyof typeof song.channels];
        // (the song's own plugins that are not installed here cannot be in the catalog)
        if (channel?.kind === 'instrument' && s.plugins.get(channel.plugin.pluginId)) wanted.add(channel.plugin.pluginId);
      }
    }
    expect(wanted.size).toBeGreaterThan(0);

    // Nothing in the words points at them, so they are in the guess only because of the part.
    const request = 'make it a little different';
    s.session.getState().selectChannel(null);
    const without = new Set(predictItems(s, { request }).map((item) => item.id));
    const withPart = new Set(predictItems(s, { request, focus }).map((item) => item.id));
    for (const id of wanted) expect(withPart.has(id), id).toBe(true);
    expect([...wanted].some((id) => !without.has(id))).toBe(true);
  });
});

describe('guessing from the song', () => {
  it('adds the plugin of the selected channel, and of a channel the request names', () => {
    const s = createTestServices();
    registerFeatures(s);
    s.history.transact('add channels', (draft) => {
      for (const [name, pluginId] of [['Lead', 'agstudio.fm'], ['Bass', 'agstudio.pluck']] as const) {
        const channel = makeInstrumentChannel(name, makePluginInstance(pluginId, 1, {}), { output: MASTER });
        draft.channels[channel.id] = channel;
        draft.channelOrder.push(channel.id);
      }
    });
    const project = s.doc.getState().project;
    const idOf = (name: string) => Object.values(project.channels).find((channel) => channel.name === name)!.id;
    const ids = (request: string) => predictItems(s, { request }).map((item) => item.id);

    expect(ids('make it brighter')).not.toContain('agstudio.fm');
    expect(ids('make the lead brighter')).toContain('agstudio.fm');
    s.session.getState().selectChannel(idOf('Bass'));
    expect(ids('make it brighter')).toContain('agstudio.pluck');
  });
});
