/**
 * The Decks window's controls carry their MIDI-learn ids (`data-dj-target`). Renders decks A and B and the
 * mixer (the Decks window's stage) and checks every target of those decks, and the global ones the window
 * shows, against the exemption lists below. The lists are checked both ways: an exempt target must not be
 * tagged, and every other target must be, so a list cannot go stale.
 */
import { describe, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeDecks } from '@app/dj/controllers/fake-decks';
import { createTestServices } from '@app/testing';
import { deckTargets, globalTargets, isTargetId } from '@core/midi-map/targets';
import { ServicesProvider } from '../../services-context';
import { DeckPanel } from './DeckPanel';
import { Mixer } from './Mixer';

/** Deck targets with no control of their own, and why (keyed by the part of the id before ":"). */
const NO_CONTROL: Record<string, string> = {
  jogNudge:
    'the platter is one element: where a press lands (rim or centre) picks nudge or scratch, so the platter is tagged jog',
  jogScratch:
    'the platter is one element: where a press lands (rim or centre) picks nudge or scratch, so the platter is tagged jog',
  jogTouch: 'the platter touch is its press, handled inside the platter element (tagged jog)',
  search: 'no dial in the window: the whole-song waveform seeks by position on a click or drag',
  loopExit: 'the OUT pad leaves an active loop on a second press, so there is no separate exit button',
  hotcueClear: 'clearing a hot cue is only in the right-click menu of its pad, which a controller link cannot take',
};

/** Global targets that the Decks window does not show, and why. */
const NOT_IN_DECKS_WINDOW: Record<string, string> = {
  browse: 'the music list is in the DJ window, not the Decks window',
  browseFast: 'the music list is in the DJ window, not the Decks window',
  'app.playPause': 'the project transport is in the transport bar, not the Decks window',
  'app.stop': 'the project transport is in the transport bar, not the Decks window',
};

/** Renders the Decks window's stage (deck A, the mixer, deck B) to HTML. */
function renderStage(): string {
  const api = new FakeDecks();
  const services = createTestServices();
  const stage = createElement(
    Fragment,
    null,
    createElement(DeckPanel, { api, id: 'A' }),
    createElement(Mixer, { api, order: ['A', 'B'], meterRef: () => () => {} }),
    createElement(DeckPanel, { api, id: 'B' }),
  );
  return renderToStaticMarkup(createElement(ServicesProvider, { services, children: stage }));
}

const tagged = (html: string): string[] => [...html.matchAll(/data-dj-target="([^"]+)"/g)].map((m) => m[1]!);

describe('Decks window: MIDI-learn ids', () => {
  const html = renderStage();
  const present = new Set(tagged(html));

  it('every tag is a real target id', () => {
    for (const id of present) expect(isTargetId(id), id).toBe(true);
  });

  it('tags every target of decks A and B that has a control on screen, and no other', () => {
    for (const deck of ['A', 'B'] as const) {
      const missing: string[] = [];
      const wrongly: string[] = [];
      for (const t of deckTargets(deck)) {
        const shouldHaveControl = !(t.fn.split(':')[0]! in NO_CONTROL);
        if (shouldHaveControl && !present.has(t.id)) missing.push(t.id);
        if (!shouldHaveControl && present.has(t.id)) wrongly.push(t.id);
      }
      expect(missing, `deck ${deck}: targets with a control but no tag`).toEqual([]);
      expect(wrongly, `deck ${deck}: exempt targets that are tagged`).toEqual([]);
    }
  });

  it('tags the global controls the window shows (crossfader, master volume, record)', () => {
    for (const t of globalTargets()) {
      const shouldHaveControl = !(t.id in NOT_IN_DECKS_WINDOW);
      expect(present.has(t.id), t.id).toBe(shouldHaveControl);
    }
  });

  it('uses each deck’s own letter', () => {
    expect(present.has('A.play')).toBe(true);
    expect(present.has('B.play')).toBe(true);
    expect(html.match(/data-dj-target="A\.hotcue:1"/g)).toHaveLength(1);
    expect(html.match(/data-dj-target="B\.hotcue:1"/g)).toHaveLength(1);
  });
});
