/**
 * What an FL Studio project file (.flp) is made of, and the plain records the reader turns it into: the
 * event ids, record layouts and size caps, then the types of the result (`FlpProject` and its parts). The
 * reader itself is `flp-reader.ts`; the file layout is described in `flp.ts`.
 *
 * The format is undocumented. Ids and layouts follow PyFLP (github.com/demberto/PyFLP) and Monad's
 * FLParser (github.com/monadgroup/FLParser), both checked against real files.
 */

/** Thrown for a file that is not a readable FL Studio project, with a message fit to show the musician. */
export class FlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlpError';
  }
}

/** Event ids the reader understands (names after PyFLP's enums). */
export const FLP_EVENT = {
  channelEnabled: 0,
  channelVolByte: 2,
  channelPanByte: 3,
  timeSigNum: 17,
  timeSigBeat: 18,
  channelType: 21,
  channelRoutedTo: 22,
  markerNumerator: 33,
  markerDenominator: 34,
  channelNew: 64,
  patternNew: 65,
  tempoCoarse: 66,
  channelVolWord: 72,
  channelPanWord: 73,
  tempoFine: 93,
  channelChild: 94,
  insertIcon: 95,
  slotIndex: 98,
  arrangementNew: 99,
  arrangementCurrent: 100,
  pluginColor: 128,
  channelRootNote: 135,
  channelFineTune: 142,
  insertOutput: 147,
  markerPosition: 148,
  insertColor: 149,
  patternColor: 150,
  insertInput: 154,
  tempo: 156,
  channelName: 192,
  patternName: 193,
  title: 194,
  comments: 195,
  samplePath: 196,
  version: 199,
  pluginInternalName: 201,
  pluginName: 203,
  insertName: 204,
  markerName: 205,
  genre: 206,
  artist: 207,
  pluginData: 213,
  channelLevels: 219,
  patternNotes: 224,
  mixerParams: 225,
  automationLinks: 227,
  playlist: 233,
  channelAutomation: 234,
  insertRouting: 235,
  insertFlags: 236,
  trackData: 238,
  trackName: 239,
  arrangementName: 241,
} as const;

/** ChannelID.Type values. */
export const FLP_CHANNEL_TYPE = { sampler: 0, native: 2, layer: 3, instrument: 4, automation: 5 } as const;

/** Playlist items whose index is above this refer to patterns (index − base); others to channels. */
export const FLP_PATTERN_BASE = 20480;

/** Playlist record sizes seen across FL versions (flpkit: 32, 60, 80, 88 bytes). */
export const FLP_PLAYLIST_STRIDES = [32, 60, 80, 88] as const;

/** Bytes of one note in a pattern's note event. */
export const FLP_NOTE_SIZE = 24;
/** Byte offsets of a note's fields (all little endian). */
export const FLP_NOTE = {
  position: 0, // u32, ticks
  flags: 4, // u16
  channel: 6, // u16, the channel's iid
  length: 8, // u32, ticks
  key: 12, // u16
  fine: 16, // u8
  release: 18, // u8
  pan: 20, // u8
  velocity: 21, // u8
  modX: 22, // u8
  modY: 23, // u8
} as const;

/** Byte offsets of the fields the reader uses in a playlist record (the record is `stride` bytes long). */
export const FLP_PLAYLIST_ITEM = {
  position: 0, // u32, ticks
  patternBase: 4, // u16, always FLP_PATTERN_BASE: how a record is told from garbage
  itemIndex: 6, // u16, a channel iid or FLP_PATTERN_BASE + pattern iid
  length: 8, // u32, ticks
  track: 12, // u16, stored reversed from the last track
  flags: 18, // u16
  startOffset: 24, // 4 bytes, see `itemOffset`
  endOffset: 28, // 4 bytes, see `itemOffset`
} as const;

/** Mixer params: 12-byte records. */
export const FLP_MIXER_PARAM_SIZE = 12;
/** Byte offsets of the fields in a mixer param record (each record is `FLP_MIXER_PARAM_SIZE` bytes). */
export const FLP_MIXER_PARAM_FIELD = {
  paramId: 4, // u8, see FLP_MIXER_PARAM
  insertAndSlot: 6, // u16: insert in bits 6–12, slot in bits 0–5
  value: 8, // i32
} as const;

/** Automation links: 20-byte records. */
export const FLP_AUTOMATION_LINK_SIZE = 20;
/** Byte offsets of the fields in an automation link record (each record is `FLP_AUTOMATION_LINK_SIZE` bytes). */
export const FLP_AUTOMATION_LINK_FIELD = {
  channel: 2, // u8, the automation channel's iid
  param: 8, // u16
  destination: 10, // u16
} as const;

/** ChannelID.Automation: 21-byte header (point count at 17), then 24-byte points. */
export const FLP_AUTOMATION_HEADER = 21;
/** Byte offset of the point count inside an automation channel's header. */
export const FLP_AUTOMATION_POINT_COUNT_OFFSET = 17;
/** Bytes of one automation point record. */
export const FLP_AUTOMATION_POINT_SIZE = 24;
/** Byte offsets of the fields in an automation point record (each record is `FLP_AUTOMATION_POINT_SIZE` bytes). */
export const FLP_AUTOMATION_POINT_FIELD = {
  deltaBeats: 0, // f64, distance from the previous point
  value: 8, // f64, 0–1
  tension: 16, // f32
} as const;

/** ChannelID.Levels: pan (i32), volume (u32) and pitch in cents (i32). */
export const FLP_CHANNEL_LEVELS_FIELD = { pan: 0, volume: 4, pitch: 8 } as const;

/** Item flag for "muted in the playlist" (FLParser). */
export const FLP_ITEM_MUTED = 0x2000;
/** Note flag for slide notes. */
export const FLP_NOTE_SLIDE = 1 << 3;
/** Insert flag "enabled" (an insert without it is switched off). */
export const FLP_INSERT_ENABLED = 1 << 3;

/** Mixer param ids (MixerParams items). */
export const FLP_MIXER_PARAM = {
  slotEnabled: 0,
  slotMix: 1,
  routeFirst: 64,
  routeLast: 191,
  volume: 192,
  pan: 193,
} as const;

/** Size caps: beyond them the reader stops collecting and warns. */
export const FLP_LIMITS = {
  maxBytes: 512 * 1024 * 1024,
  maxChannels: 2000,
  maxPatterns: 10000,
  maxNotes: 2_000_000,
  maxItems: 500_000,
  maxInserts: 256,
  maxTracks: 500,
  maxMarkers: 10000,
  maxAutomationPoints: 100_000,
  maxText: 64 * 1024,
} as const;

/** The name and vendor an FL VST wrapper recorded for the plugin it hosts. */
export interface FlpVst {
  name?: string;
  vendor?: string;
}

/** One point of an FL automation clip's curve, as read from the file. */
export interface FlpAutomationPoint {
  /** Quarter notes from the start of the clip. */
  beats: number;
  /** 0–1. */
  value: number;
  tension: number;
}

/**
 * One FL channel (a generator or an audio clip) as read from the file: its settings are in FL's own scales, and fields
 * the file did not have are absent.
 */
export interface FlpChannel {
  /** The channel's FL index (ChannelID.New); notes and playlist items refer to it. */
  iid: number;
  /** ChannelID.Type (see FLP_CHANNEL_TYPE); null when absent. */
  type: number | null;
  /** The display name (PluginID.Name), falling back to ChannelID._Name. */
  name?: string;
  /** The generator's internal name: "Fruity Wrapper" for VST/AU, the plugin's factory name otherwise. */
  internalName?: string;
  vst?: FlpVst;
  samplePath?: string;
  /** 0–12800 (default 10000, nonlinear). */
  volume?: number;
  /** 0 (left) – 12800 (right), centre 6400. */
  pan?: number;
  /** Cents. */
  pitch?: number;
  /** FL key (60 = C5); default 60. */
  rootNote?: number;
  /** Mixer insert (0 = master, −1 = "current"). */
  insert?: number;
  /** "#rrggbb". */
  color?: string;
  enabled: boolean;
  /** Layer children (channel iids). */
  children: number[];
  automation?: FlpAutomationPoint[];
}

/** One note of an FL pattern as read from the file, in FL's own units (ticks at the file's PPQ, keys with 60 = C5). */
export interface FlpNote {
  /** Ticks at the file's PPQ. */
  position: number;
  flags: number;
  /** Channel iid. */
  channel: number;
  length: number;
  /** 0–131, 60 = C5. */
  key: number;
  /** 0–240, 120 = no detune. */
  fine: number;
  /** 0–128, default 64. */
  release: number;
  /** 0–128, 64 = centre. */
  pan: number;
  /** 0–128, default 100. */
  velocity: number;
  modX: number;
  modY: number;
}

/** One FL pattern as read from the file: its number, name, colour and notes. */
export interface FlpPattern {
  /** FL pattern number (PatternID.New); playlist items refer to it. */
  iid: number;
  name?: string;
  color?: string;
  notes: FlpNote[];
}

/** One item on FL's playlist: a pattern or a channel's clip placed on a track. */
export interface FlpPlaylistItem {
  /** Ticks at the file's PPQ. */
  position: number;
  length: number;
  /** Playlist track, 0 = the top one. */
  track: number;
  kind: 'pattern' | 'channel';
  /** Pattern iid or channel iid. */
  ref: number;
  muted: boolean;
  /** Content offset in ticks at the file's PPQ, or null for none. */
  startOffset: number | null;
  endOffset: number | null;
}

/** One playlist track of an FL arrangement: its position, name and colour, and whether it is enabled. */
export interface FlpTrack {
  index: number;
  name?: string;
  color?: string;
  enabled: boolean;
}

/** One playlist marker of an FL arrangement, with its position in ticks at the file's PPQ. */
export interface FlpMarker {
  /** Ticks at the file's PPQ. */
  position: number;
  name?: string;
  /** 0 = text marker, 1 = time signature marker, other = FL marker actions (loop, pause, …). */
  kind: number;
  numerator?: number;
  denominator?: number;
}

/** One FL arrangement: its playlist items, tracks and markers. */
export interface FlpArrangement {
  index: number;
  name?: string;
  items: FlpPlaylistItem[];
  tracks: FlpTrack[];
  markers: FlpMarker[];
}

/** One effect slot of an FL mixer insert, as read from the file. */
export interface FlpSlot {
  /** Slot number within the insert (SlotID.Index). */
  index: number;
  internalName?: string;
  name?: string;
  vst?: FlpVst;
  enabled?: boolean;
  /** FL's slot mix value (−6400…6400). */
  mix?: number;
}

/** One FL mixer insert as read from the file: its name, colour, routing, levels and effect slots. */
export interface FlpInsert {
  /** 0 = master. */
  index: number;
  name?: string;
  color?: string;
  flags?: number;
  /** Route flags by target insert index (InsertID.Routing). */
  routing?: boolean[];
  /** Send levels by target insert (0–16000 scale), from the mixer params. */
  sends: Record<number, number>;
  /** 0–16000, 12800 = 0 dB. */
  volume?: number;
  /** −6400…6400. */
  pan?: number;
  slots: FlpSlot[];
}

/** A link from an FL automation channel to the control it drives, by FL's own parameter and destination numbers. */
export interface FlpAutomationLink {
  /** The automation channel's iid. */
  channel: number;
  param: number;
  destination: number;
}

/** Everything the reader found in a project file, in FL's own units. */
export interface FlpProject {
  format: number;
  /** The header's channel count. */
  channelCount: number;
  /** Ticks per quarter note of every position in this file. */
  ppq: number;
  /** "21.2.3.4004"; empty when the file has no version event. */
  version: string;
  versionParts: number[];
  title?: string;
  artist?: string;
  genre?: string;
  comments?: string;
  /** BPM, or null when the file has none (FL then uses 140). */
  tempo: number | null;
  timeSig: { num: number; beat: number } | null;
  channels: FlpChannel[];
  patterns: FlpPattern[];
  arrangements: FlpArrangement[];
  /** Index of the arrangement that was open when saved, or null. */
  currentArrangement: number | null;
  inserts: FlpInsert[];
  automationLinks: FlpAutomationLink[];
  /** Plain-language notes on what was cut off or ignored. */
  warnings: string[];
  /** Events skipped because the reader doesn't use them. */
  skippedEvents: number;
}
