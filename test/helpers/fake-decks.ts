/** The recording stand-in for the live decks (see `src/app/dj/controllers/fake-decks.ts`). */
export { FakeDecks, fakeDeckState, fakeDecksState, type FakeCall } from '@app/dj/controllers/fake-decks';

import type { SampleRef } from '@core/model/types';

/** A made-up library song reference for tests. */
export function fakeSampleRef(name: string): SampleRef {
  return { id: `smp_${name}` as SampleRef['id'], name, source: { kind: 'embedded', hash: `hash-${name}`, ext: 'mp3' } };
}
