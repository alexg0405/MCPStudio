/**
 * A rack in a live engine (a realtime AudioContext): a song plays through racks on the master and on a track, a macro turned while it
 * plays reaches the sound, the rack's delay compensation keeps the song in time, and nothing reports a fault.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addRackChoice, allRacks } from '@app/actions/racks';
import { findRackChoice } from '@app/racks/library';
import { createServices, type Services } from '@app/services';
import { MASTER, type SlotId } from '@core/model/types';
import { setPluginParam } from '@core/ops/channels';
import { ticksPerBar } from '@core/time/ppq';
import { Engine } from '@engine/engine';
import { R } from '@engine/meter/layout';
import { buildSong } from '../helpers/mix-level';
import { retryWhenOverloaded } from '../helpers/overload';
import { EVENTUALLY } from '../helpers/wait';

const services: Services[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.engine.dispose();
});

async function liveSong(): Promise<Services> {
  const s = createServices({ createEngine: (options) => Engine.realtime({ ...options }) });
  await s.engine.resume();
  buildSong(s, 'house', { bpm: 124, low: 'bass', mix: false });
  await s.engine.ready();
  services.push(s);
  return s;
}

/** Plays `bars` bars from the start and returns the integrated loudness the master meter read. */
async function playLoudness(s: Services, bars: number, during?: () => void): Promise<number> {
  const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  const lease = s.meters.listen(MASTER, { full: true });
  await expect.poll(() => lease.meter.active && lease.meter.blocks > 10, EVENTUALLY).toBe(true);
  s.engine.play(0);
  during?.();
  await expect.poll(() => s.engine.playhead() >= bars * bar, { timeout: 30_000, interval: 25 }).toBe(true);
  s.engine.stop();
  const lufs = lease.meter.readings[R.integrated] as number;
  lease.release();
  return lufs;
}

describe('racks in a live engine', { tags: ['realtime'] }, () => {
  it('plays a song through racks, and a macro turned while it plays moves the sound', async (test) => {
    await retryWhenOverloaded(test, async () => {
      const s = await liveSong();
      const plain = await playLoudness(s, 3);
      const rackId = addRackChoice(s, MASTER, findRackChoice(allRacks(s), 'Multiband saturation')!)!;
      expect(rackId).not.toBeNull();
      await s.engine.ready();
      const through = await playLoudness(s, 3);
      expect(Number.isFinite(through)).toBe(true);
      expect(Math.abs(through - plain), `plain ${plain.toFixed(1)} LUFS, through the rack ${through.toFixed(1)}`).toBeLessThan(6);
      const owner = { kind: 'fx', insertId: MASTER, slotId: rackId as SlotId } as const;
      // The Output macro (6): quiet at 0, loud at 1, set while the song plays.
      s.history.transact('quiet', (d) => void setPluginParam(d, owner, 'macro6', 0));
      const quiet = await playLoudness(s, 3);
      const loud = await playLoudness(s, 3, () => s.history.transact('loud', (d) => void setPluginParam(d, owner, 'macro6', 1)));
      expect(loud - quiet, `quiet ${quiet.toFixed(1)}, loud ${loud.toFixed(1)}`).toBeGreaterThan(3);
      expect(s.session.getState().toasts.filter((toast) => toast.kind === 'error')).toEqual([]);
    });
  }, 180_000);

  it('a rack with a latent effect (lo-fi) keeps the delay compensation honest', async (test) => {
    await retryWhenOverloaded(test, async () => {
      const s = await liveSong();
      const before = s.engine.graphLatency();
      const rackId = addRackChoice(s, MASTER, findRackChoice(allRacks(s), 'Lo-fi tape')!);
      expect(rackId).not.toBeNull();
      await s.engine.ready();
      // The lo-fi effect inside reports 8 ms; the rack passes it on to the mixer.
      await expect.poll(() => s.engine.graphLatency() - before, EVENTUALLY).toBeGreaterThan(0.007);
      expect(s.engine.graphLatency() - before).toBeLessThan(0.02);
      s.history.undo();
      await expect.poll(() => s.engine.graphLatency(), EVENTUALLY).toBeCloseTo(before, 4);
    });
  }, 120_000);
});
