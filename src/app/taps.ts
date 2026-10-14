/**
 * Visualization taps of running plugin instances (`host.tap()`), by owner. Plugin editors get a
 * stable view per owner (`view(owner)`): it reads whichever instance runs there now, so an editor
 * keeps drawing across instance swaps (hot reload, engine reboot) without re-rendering.
 */
import type { PluginOwner } from '@core/model/types';
import type { AudioTap } from '@agstudio/sdk';

const ownerKey = (o: PluginOwner) => (o.kind === 'channel' ? `ch:${o.channelId}` : `fx:${o.insertId}:${o.slotId}`);

export class TapRegistry {
  private readonly live = new Map<string, AudioTap>();
  private readonly views = new Map<string, AudioTap>();

  /** The engine reports taps here (EngineOptions.onPluginTap). */
  report(owner: PluginOwner, tap: AudioTap, live: boolean): void {
    const key = ownerKey(owner);
    if (live) this.live.set(key, tap);
    else if (this.live.get(key) === tap) this.live.delete(key);
  }

  /** The tap running at `owner` right now, or null. */
  get(owner: PluginOwner): AudioTap | null {
    return this.live.get(ownerKey(owner)) ?? null;
  }

  /** A stable AudioTap for the owner's editor (inactive while nothing there is tapped). */
  view(owner: PluginOwner): AudioTap {
    const key = ownerKey(owner);
    let view = this.views.get(key);
    if (!view) {
      const current = () => this.live.get(key);
      view = {
        get active() {
          return current()?.active ?? false;
        },
        get sampleRate() {
          return current()?.sampleRate ?? 0;
        },
        get fftSize() {
          return current()?.fftSize ?? 0;
        },
        spectrum: (out) => current()?.spectrum(out) ?? false,
        waveform: (out, channel) => current()?.waveform(out, channel) ?? false,
        reading: (name) => current()?.reading(name),
      };
      this.views.set(key, view);
    }
    return view;
  }
}
