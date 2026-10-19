import type { ChannelId, MarkerId, SampleId, Tick } from './ids';

/** The DJ mix the auto-mix wrote into the project: its songs, the options it was made with and what it made. */
export interface DjMixState {
  songs: DjMixSong[];
  options: DjMixOptions;
  /** Tweaks of single transitions, by the incoming song's sample id. */
  tweaks: Record<string, DjTransitionTweak>;
  /** Channels (songs, curves, the tempo, risers) and markers the mix made. */
  made: { channels: ChannelId[]; markers: MarkerId[] };
}

/** One song of the mix and where it plays. */
export interface DjMixSong {
  sampleId: SampleId;
  /** "Artist – Title" or the file name. */
  title: string;
  /** Its own tempo (null: no steady beat) and key (Camelot, e.g. "8A"; null: unknown). */
  bpm: number | null;
  camelot: string | null;
  deck: 'A' | 'B';
  /** Where it plays in the mix. */
  start: Tick;
  end: Tick;
  /** Auto order keeps it at this position. */
  pinned?: boolean;
}

/** What the musician asked the auto-mix for. */
export interface DjMixOptions {
  order: 'keep' | 'auto';
  energy: 'build' | 'party' | 'chill' | 'peak-time';
  transition: 'auto' | 'smooth' | 'quick' | 'cut';
  /** 'follow' (each song at its own tempo) or one BPM for the whole mix. */
  mixTempo: 'follow' | number;
  lengthTargetMin?: number;
  /** Songs keep their pitch when the tempo moves them (time-stretch) instead of bending it like a turntable. */
  keyLock?: boolean;
}

/** A hand change to one transition of the mix. */
export interface DjTransitionTweak {
  bars?: number;
  recipe?: 'bass-swap' | 'filter' | 'echo' | 'cut';
  riser?: boolean;
}
