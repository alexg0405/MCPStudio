/** The schema version a saved project carries (migrations in `core/schema` bring older ones up to it). */
export const SCHEMA_VERSION = 3;

/** Integer ticks at PPQ 960. */
export type Tick = number;

declare const brand: unique symbol;
/** A string that only the matching id type accepts, so a pattern id cannot be passed where a channel id is wanted. */
type Id<B extends string> = string & { readonly [brand]: B };

/** A channel of the channel rack (instrument, audio clip or automation). */
export type ChannelId = Id<'ch'>;
/** A pattern of notes. */
export type PatternId = Id<'pat'>;
/** One note inside a pattern. */
export type NoteId = Id<'n'>;
/** A track of the playlist. */
export type LaneId = Id<'lane'>;
/** A clip on the playlist. */
export type ClipId = Id<'clip'>;
/** A mixer insert (track). */
export type InsertId = Id<'ins'>;
/** An effect slot on a mixer insert. */
export type SlotId = Id<'fx'>;
/** A sample of the project (a recording, an import or a generated sound). */
export type SampleId = Id<'smp'>;
/** A MIDI controller link. */
export type LinkId = Id<'lnk'>;
/** A named position on the playlist ruler. */
export type MarkerId = Id<'mk'>;
/** A chord on the chord track. */
export type ChordId = Id<'cd'>;
/** A mixer group: tracks whose faders, pans, mutes and solos move together, and the VCA that scales them. */
export type GroupId = Id<'grp'>;
/** A saved state of the mixer (faders, pans, mutes, sends, effect settings) that can be recalled. */
export type SnapshotId = Id<'snap'>;
/** A column of the clip launcher. */
export type LaunchTrackId = Id<'lt'>;
/** A row of the clip launcher. */
export type SceneId = Id<'sc'>;

/** The master insert has a fixed id. */
export const MASTER = 'master' as InsertId;
