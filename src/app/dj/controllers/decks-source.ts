/**
 * Where the controllers get the live decks from. The decks are created on first use (`DecksFactory`),
 * so a controller asks when it is switched on.
 *
 * Wiring, in the order it is tried:
 *  1. `setDecksProvider(...)`: whoever implements the decks calls this once at registration with a
 *     function that returns the decks (or a promise of them);
 *  2. `services.decks`, if the services object has one: either a `DecksApi` or a `DecksFactory`;
 *  3. in a development build only, a `FakeDecks` stand-in, so a controller can be tried and its LEDs
 *     watched before the decks exist (the Controllers window says so).
 */
import type { Services } from '../../services';
import type { DecksApi, DecksFactory } from '../decks-api';

/** Something that hands the controllers the live decks (set by the app or a test). */
export type DecksProvider = () => DecksApi | null | Promise<DecksApi | null>;

let provider: DecksProvider | null = null;

/** The decks implementation registers here (pass null to remove it). */
export function setDecksProvider(p: DecksProvider | null): void {
  provider = p;
}

const isDecksApi = (x: unknown): x is DecksApi => !!x && typeof x === 'object' && 'store' in x && 'togglePlay' in x;

/** The decks the controllers drive, and whether they are the development stand-in. */
export interface ResolvedDecks {
  decks: DecksApi;
  /** True for the development stand-in. */
  fake: boolean;
}

/** Finds the decks for the controllers: the provider's, the services', or in a development build a stand-in. */
export async function resolveDecks(services: Pick<Services, 'platform'> & { decks?: unknown }): Promise<ResolvedDecks | null> {
  if (provider) {
    const d = await provider();
    if (d) return { decks: d, fake: false };
  }
  const own = services.decks;
  if (isDecksApi(own)) return { decks: own, fake: false };
  if (typeof own === 'function') {
    const d = await (own as DecksFactory)();
    if (d) return { decks: d, fake: false };
  }
  if (import.meta.env.DEV) {
    const { FakeDecks } = await import('./fake-decks');
    return { decks: new FakeDecks(), fake: true };
  }
  return null;
}
