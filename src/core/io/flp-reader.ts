/**
 * Turns the event stream of an .flp (`flp.ts` finds where it starts) into an `FlpProject`.
 *
 * Events arrive in FL's saving order and many only make sense in the context set by an earlier one: a
 * "channel name" belongs to the channel opened by the last "new channel", a plugin name to that channel or,
 * once the channel has its own, to a mixer slot. `FlpEventReader` keeps that context and has one small
 * method per kind of event; `scanEvents` (flp-scan.ts) splits the byte stream into events and feeds them in.
 */
import { type FlpView, cleanText, colorOf, isUnicodeVersion, latin1, utf16le } from './flp-bytes';
import {
  FLP_AUTOMATION_HEADER,
  FLP_AUTOMATION_LINK_FIELD,
  FLP_AUTOMATION_LINK_SIZE,
  FLP_AUTOMATION_POINT_COUNT_OFFSET,
  FLP_AUTOMATION_POINT_FIELD,
  FLP_AUTOMATION_POINT_SIZE,
  FLP_CHANNEL_LEVELS_FIELD,
  FLP_EVENT,
  FLP_ITEM_MUTED,
  FLP_LIMITS,
  FLP_MIXER_PARAM_FIELD,
  FLP_MIXER_PARAM_SIZE,
  FLP_NOTE_SIZE,
  FLP_PATTERN_BASE,
  FLP_PLAYLIST_ITEM,
  FlpError,
  type FlpArrangement,
  type FlpAutomationPoint,
  type FlpChannel,
  type FlpInsert,
  type FlpMarker,
  type FlpPattern,
  type FlpProject,
  type FlpSlot,
} from './flp-format';
import { itemOffset, parseVst, playlistStride, readNote } from './flp-records';
import { applyMixerParams, resolvePlaylistTracks, resolveTempoAndTimeSignature, type MixerParam } from './flp-resolve';

/** What the last context-setting event opened; events that need a channel (or pattern ...) check it. */
type Context = 'project' | 'channel' | 'pattern' | 'arrangement' | 'mixer';

const MAX_LAYER_CHILDREN = 256;
const MAX_SLOTS_PER_INSERT = 64;
const MAX_AUTOMATION_LINKS = 10000;
/** The longest version text read, in bytes. */
const MAX_VERSION_TEXT = 64;
/** Offsets of fields inside the events that are not plain numbers. */
const INSERT_FLAGS_OFFSET = 4; // u32, in an event of at least 8 bytes
const TRACK_COLOR_OFFSET = 4; // u32, in an event of at least 8 bytes
const TRACK_ENABLED_OFFSET = 12; // u8, in an event of at least 13 bytes
/** A marker position event holds the position in its low 27 bits and the marker kind in the high 5. */
const MARKER_POSITION_BITS = 27;
const MARKER_POSITION_MASK = (1 << MARKER_POSITION_BITS) - 1;
/** A mixer param's insert/slot word: insert in bits 6–12, slot in bits 0–5. */
const MIXER_PARAM_SLOT_MASK = 0x3f;
const MIXER_PARAM_INSERT_SHIFT = 6;
const MIXER_PARAM_INSERT_MASK = 0x7f;

/** Collects an `FlpProject` from events, one `handleEvent` call each, then `finish()`. */
export class FlpEventReader {
  readonly project: FlpProject;
  private readonly view: FlpView;
  private readonly bytes: Uint8Array;
  private readonly ppq: number;

  private readonly channelsByIid = new Map<number, FlpChannel>();
  /** Which plugin events each channel has had; a repeat belongs to a mixer slot (see `onPluginEvent`). */
  private readonly pluginEventsSeen = new Map<FlpChannel, Set<number>>();
  private readonly patternsByIid = new Map<number, FlpPattern>();
  /** True/false once the version is known (decides the text encoding); null before. */
  private isUnicode: boolean | null = null;
  private context: Context = 'project';
  private channel: FlpChannel | null = null;
  private pattern: FlpPattern | null = null;
  private arrangement: FlpArrangement | null = null;
  private marker: FlpMarker | null = null;
  private insertIndex = 0;
  private slot: FlpSlot | null = null;
  private tempoCoarse: number | null = null;
  private tempoFine = 0;
  private timeSigNumerator: number | null = null;
  private timeSigBeat: number | null = null;
  private totalNotes = 0;
  private totalItems = 0;
  private totalAutomationPoints = 0;
  private readonly cappedKinds = new Set<string>();
  private readonly mixerParams: MixerParam[] = [];

  constructor(view: FlpView, header: { format: number; channelCount: number; ppq: number }, warnings: string[]) {
    this.view = view;
    this.bytes = view.bytes;
    this.ppq = header.ppq;
    this.project = {
      format: header.format,
      channelCount: header.channelCount,
      ppq: header.ppq,
      version: '',
      versionParts: [],
      tempo: null,
      timeSig: null,
      channels: [],
      patterns: [],
      arrangements: [],
      currentArrangement: null,
      inserts: [],
      automationLinks: [],
      warnings,
      skippedEvents: 0,
    };
  }

  /**
   * Applies one event: its `id`, the `size` of its payload, the payload's byte offset `at`, and `value`, the
   * payload read as a number (for 1, 2 and 4 byte events; 0 for the others).
   */
  handleEvent(id: number, size: number, at: number, value: number): void {
    const E = FLP_EVENT;
    switch (id) {
      // --- Project -------------------------------------------------------------------------
      case E.version:
        this.onVersion(at, size);
        break;
      case E.title:
        this.project.title = this.text(at, size);
        break;
      case E.artist:
        this.project.artist = this.text(at, size);
        break;
      case E.genre:
        this.project.genre = this.text(at, size);
        break;
      case E.comments:
        this.project.comments = this.text(at, size);
        break;
      case E.tempo:
        this.project.tempo = value / 1000;
        break;
      case E.tempoCoarse:
        this.tempoCoarse = value;
        break;
      case E.tempoFine:
        this.tempoFine = value;
        break;
      case E.timeSigNum:
        this.timeSigNumerator = value;
        break;
      case E.timeSigBeat:
        this.timeSigBeat = value;
        break;

      // --- Channels ------------------------------------------------------------------------
      case E.channelNew:
        this.onChannelNew(value);
        break;
      case E.channelType:
        if (this.channelContext()) this.channel!.type = value;
        break;
      case E.channelRoutedTo:
        // A signed byte: 0 = master, −1 = "current".
        if (this.channelContext()) this.channel!.insert = (value << 24) >> 24;
        break;
      case E.channelEnabled:
        if (this.channelContext()) this.channel!.enabled = value !== 0;
        break;
      case E.samplePath:
        if (this.channelContext()) this.channel!.samplePath = this.text(at, size);
        break;
      case E.channelName:
        this.onChannelName(at, size);
        break;
      case E.channelLevels:
        this.onChannelLevels(at, size);
        break;
      case E.channelVolWord:
        if (this.channelContext() && this.channel!.volume === undefined) this.channel!.volume = value;
        break;
      case E.channelPanWord:
        if (this.channelContext() && this.channel!.pan === undefined) this.channel!.pan = value;
        break;
      case E.channelVolByte:
        if (this.channelContext() && this.channel!.volume === undefined) this.channel!.volume = value * 100;
        break;
      case E.channelPanByte:
        if (this.channelContext() && this.channel!.pan === undefined) this.channel!.pan = value * 100;
        break;
      case E.channelRootNote:
        if (this.channelContext()) this.channel!.rootNote = value;
        break;
      case E.channelChild:
        if (this.channelContext() && this.channel!.children.length < MAX_LAYER_CHILDREN) {
          this.channel!.children.push(value);
        }
        break;
      case E.channelAutomation:
        if (this.channelContext() && size >= FLP_AUTOMATION_HEADER) this.onChannelAutomation(at, size);
        break;

      // --- Plugins: the channel's generator, or a mixer slot's effect ------------------------
      case E.pluginColor:
      case E.pluginInternalName:
      case E.pluginName:
      case E.pluginData:
        this.onPluginEvent(id, at, size, value);
        break;

      // --- Patterns ------------------------------------------------------------------------
      case E.patternNew:
        this.onPatternNew(value);
        break;
      case E.patternName:
        if (this.pattern) this.pattern.name = this.text(at, size) || undefined;
        break;
      case E.patternColor:
        if (this.pattern) this.pattern.color = colorOf(value);
        break;
      case E.patternNotes:
        this.onPatternNotes(at, size);
        break;

      // --- Arrangements, playlist, tracks, markers ------------------------------------------
      case E.arrangementNew:
        this.context = 'arrangement';
        this.arrangement = { index: value, items: [], tracks: [], markers: [] };
        this.project.arrangements.push(this.arrangement);
        this.marker = null;
        break;
      case E.arrangementName:
        if (this.arrangement) this.arrangement.name = this.text(at, size) || undefined;
        break;
      case E.arrangementCurrent:
        this.project.currentArrangement = value;
        break;
      case E.playlist:
        this.onPlaylist(at, size);
        break;
      case E.trackData:
        this.onTrackData(at, size);
        break;
      case E.trackName: {
        const tracks = this.currentArrangement().tracks;
        const track = tracks[tracks.length - 1];
        if (track) track.name = this.text(at, size) || undefined;
        break;
      }
      case E.markerPosition:
        this.onMarkerPosition(value);
        break;
      case E.markerName:
        if (this.marker) this.marker.name = this.text(at, size) || undefined;
        break;
      case E.markerNumerator:
        if (this.marker) this.marker.numerator = value;
        break;
      case E.markerDenominator:
        if (this.marker) this.marker.denominator = value;
        break;

      // --- Mixer ---------------------------------------------------------------------------
      case E.insertFlags: {
        this.enterMixer();
        const insert = this.currentInsert();
        if (insert && size >= 8) insert.flags = this.view.u32(at + INSERT_FLAGS_OFFSET);
        break;
      }
      case E.insertName: {
        this.enterMixer();
        const insert = this.currentInsert();
        if (insert) insert.name = this.text(at, size) || undefined;
        break;
      }
      case E.insertColor: {
        this.enterMixer();
        const insert = this.currentInsert();
        if (insert) insert.color = colorOf(value);
        break;
      }
      case E.insertIcon:
      case E.insertInput:
        this.enterMixer();
        break;
      case E.slotIndex:
        this.onSlotIndex(value);
        break;
      case E.insertRouting:
        this.onInsertRouting(at, size);
        break;
      case E.insertOutput:
        this.enterMixer();
        this.currentInsert();
        this.insertIndex++;
        this.slot = null;
        break;
      case E.mixerParams:
        this.onMixerParams(at, size);
        break;
      case E.automationLinks:
        this.onAutomationLinks(at, size);
        break;
      default:
        this.project.skippedEvents++;
    }
  }

  /**
   * Called after the last event: settles what needs the whole file (tempo, playlist track numbers,
   * mixer parameters) and returns the project. Throws when nothing was found at all.
   */
  finish(): FlpProject {
    const out = this.project;
    resolveTempoAndTimeSignature(out, {
      tempoCoarse: this.tempoCoarse,
      tempoFine: this.tempoFine,
      timeSigNumerator: this.timeSigNumerator,
      timeSigBeat: this.timeSigBeat,
    });
    resolvePlaylistTracks(out);
    applyMixerParams(out, this.mixerParams);
    // Holes (inserts with no events of their own) become empty inserts.
    for (let i = 0; i < out.inserts.length; i++) out.inserts[i] ??= { index: i, sends: {}, slots: [] };
    const isEmpty = out.channels.length === 0 && out.patterns.length === 0 && out.arrangements.length === 0;
    if (isEmpty && !out.version) throw new FlpError('The FL Studio project file has no project data.');
    return out;
  }

  // --- Shared helpers --------------------------------------------------------------------------

  /** Records (once) that a kind of thing hit its size cap, so the musician is told what was left out. */
  private cap(what: string): void {
    if (this.cappedKinds.has(what)) return;
    this.cappedKinds.add(what);
    this.project.warnings.push(`The project has more ${what} than can be imported; the rest were left out.`);
  }

  /** Text of an event, in the file's encoding (UTF-16LE from FL 11.5, one byte per character before). */
  private text(at: number, size: number): string {
    const length = Math.min(size, FLP_LIMITS.maxText);
    // Before the version event (never in FL's own files): guess from the zero high bytes.
    const isWide = this.isUnicode ?? (length >= 2 && length % 2 === 0 && this.bytes[at + 1] === 0);
    return cleanText(isWide ? utf16le(this.bytes, at, length) : latin1(this.bytes, at, length));
  }

  /** True when a channel event applies: the last context-setting event opened a channel that was kept. */
  private channelContext(): boolean {
    return this.context === 'channel' && this.channel !== null;
  }

  private currentArrangement(): FlpArrangement {
    if (!this.arrangement) {
      this.arrangement = { index: 0, items: [], tracks: [], markers: [] };
      this.project.arrangements.push(this.arrangement);
    }
    return this.arrangement;
  }

  /** The mixer insert being described, created on first use; null past the cap on inserts. */
  private currentInsert(): FlpInsert | null {
    if (this.insertIndex >= FLP_LIMITS.maxInserts) {
      this.cap('mixer tracks');
      return null;
    }
    let insert = this.project.inserts[this.insertIndex];
    if (!insert) {
      insert = { index: this.insertIndex, sends: {}, slots: [] };
      this.project.inserts[this.insertIndex] = insert;
    }
    return insert;
  }

  private enterMixer(): void {
    if (this.context === 'mixer') return;
    this.context = 'mixer';
    this.slot = null;
  }

  private currentSlot(): FlpSlot {
    this.slot ??= { index: -1 };
    return this.slot;
  }

  // --- Project ---------------------------------------------------------------------------------

  private onVersion(at: number, size: number): void {
    const project = this.project;
    project.version = cleanText(latin1(this.bytes, at, Math.min(size, MAX_VERSION_TEXT)));
    project.versionParts = project.version
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));
    this.isUnicode = isUnicodeVersion(project.versionParts);
  }

  // --- Channels --------------------------------------------------------------------------------

  private onChannelNew(iid: number): void {
    this.context = 'channel';
    let channel = this.channelsByIid.get(iid);
    if (!channel) {
      if (this.channelsByIid.size >= FLP_LIMITS.maxChannels) {
        this.cap('channels');
        this.channel = null;
        return;
      }
      channel = { iid, type: null, enabled: true, children: [] };
      this.channelsByIid.set(iid, channel);
      this.project.channels.push(channel);
    }
    this.channel = channel;
  }

  private onChannelName(at: number, size: number): void {
    // The display name (PluginID.Name) wins over this older name event.
    if (!this.channelContext()) return;
    const channel = this.channel!;
    if (this.pluginEventsSeen.get(channel)?.has(FLP_EVENT.pluginName)) return;
    channel.name = this.text(at, size) || undefined;
  }

  private onChannelLevels(at: number, size: number): void {
    if (!this.channelContext()) return;
    const channel = this.channel!;
    if (size >= 4) channel.pan = this.view.i32(at + FLP_CHANNEL_LEVELS_FIELD.pan);
    if (size >= 8) channel.volume = this.view.u32(at + FLP_CHANNEL_LEVELS_FIELD.volume);
    if (size >= 12) channel.pitch = this.view.i32(at + FLP_CHANNEL_LEVELS_FIELD.pitch);
  }

  private onChannelAutomation(at: number, size: number): void {
    const view = this.view;
    const declaredCount = view.u32(at + FLP_AUTOMATION_POINT_COUNT_OFFSET);
    const roomForCount = Math.floor((size - FLP_AUTOMATION_HEADER) / FLP_AUTOMATION_POINT_SIZE);
    const pointCount = Math.min(declaredCount, roomForCount);
    const points: FlpAutomationPoint[] = [];
    let beats = 0;
    for (let i = 0; i < pointCount; i++) {
      if (this.totalAutomationPoints >= FLP_LIMITS.maxAutomationPoints) {
        this.cap('automation points');
        break;
      }
      const pointAt = at + FLP_AUTOMATION_HEADER + i * FLP_AUTOMATION_POINT_SIZE;
      const deltaBeats = view.f64(pointAt + FLP_AUTOMATION_POINT_FIELD.deltaBeats);
      beats += Number.isFinite(deltaBeats) ? deltaBeats : 0;
      const value = view.f64(pointAt + FLP_AUTOMATION_POINT_FIELD.value);
      const tension = view.f32(pointAt + FLP_AUTOMATION_POINT_FIELD.tension);
      points.push({
        beats,
        value: Number.isFinite(value) ? value : 0,
        tension: Number.isFinite(tension) ? tension : 0,
      });
      this.totalAutomationPoints++;
    }
    this.channel!.automation = points;
  }

  // --- Plugins ---------------------------------------------------------------------------------

  /**
   * Plugin colour, internal name, name and data. A channel has each of these once; a repeat means the
   * mixer slot data that follows the channels, so it is filed under the current slot instead.
   */
  private onPluginEvent(id: number, at: number, size: number, value: number): void {
    if (this.channelContext() && this.fillChannelPlugin(this.channel!, id, at, size, value)) return;
    this.enterMixer();
    const slot = this.currentSlot();
    if (id === FLP_EVENT.pluginInternalName) slot.internalName ??= this.text(at, size);
    else if (id === FLP_EVENT.pluginName) slot.name ??= this.text(at, size);
    else if (id === FLP_EVENT.pluginData) slot.vst ??= parseVst(this.view, at, size);
  }

  /** Stores a plugin event on the channel if it is the channel's first of that kind. False for a repeat. */
  private fillChannelPlugin(channel: FlpChannel, id: number, at: number, size: number, value: number): boolean {
    let seen = this.pluginEventsSeen.get(channel);
    if (!seen) {
      seen = new Set();
      this.pluginEventsSeen.set(channel, seen);
    }
    if (seen.has(id)) return false;
    seen.add(id);
    if (id === FLP_EVENT.pluginColor) channel.color = colorOf(value);
    else if (id === FLP_EVENT.pluginInternalName) channel.internalName = this.text(at, size);
    else if (id === FLP_EVENT.pluginName) channel.name = this.text(at, size) || channel.name;
    else channel.vst = parseVst(this.view, at, size);
    return true;
  }

  // --- Patterns --------------------------------------------------------------------------------

  private onPatternNew(iid: number): void {
    this.context = 'pattern';
    let pattern = this.patternsByIid.get(iid);
    if (!pattern) {
      if (this.patternsByIid.size >= FLP_LIMITS.maxPatterns) {
        this.cap('patterns');
        this.pattern = null;
        return;
      }
      pattern = { iid, notes: [] };
      this.patternsByIid.set(iid, pattern);
      this.project.patterns.push(pattern);
    }
    this.pattern = pattern;
  }

  private onPatternNotes(at: number, size: number): void {
    const pattern = this.pattern;
    if (!pattern) return;
    const view = this.view;
    if (size % FLP_NOTE_SIZE !== 0) {
      this.project.warnings.push('Some note data had an unexpected size; whole notes were read.');
    }
    const noteCount = Math.floor(size / FLP_NOTE_SIZE);
    // This loop runs once per note, up to a million times: it keeps its counter in a local.
    let totalNotes = this.totalNotes;
    for (let i = 0; i < noteCount; i++) {
      if (totalNotes >= FLP_LIMITS.maxNotes) {
        this.cap('notes');
        break;
      }
      pattern.notes.push(readNote(view, at + i * FLP_NOTE_SIZE));
      totalNotes++;
    }
    this.totalNotes = totalNotes;
  }

  // --- Playlist --------------------------------------------------------------------------------

  private onPlaylist(at: number, size: number): void {
    const arrangement = this.currentArrangement();
    const stride = playlistStride(this.view, at, size);
    if (stride === null) {
      if (size > 0) this.project.warnings.push('Some playlist data had an unknown layout and was skipped.');
      return;
    }
    const view = this.view;
    const recordCount = size / stride;
    // Field offsets as locals: this loop runs once per playlist clip, up to hundreds of thousands of times.
    const { itemIndex: itemIndexAt, position, length, track, flags, startOffset, endOffset } = FLP_PLAYLIST_ITEM;
    const items = arrangement.items;
    const ppq = this.ppq;
    for (let i = 0; i < recordCount; i++) {
      if (this.totalItems >= FLP_LIMITS.maxItems) {
        this.cap('playlist clips');
        break;
      }
      const recordAt = at + i * stride;
      const itemIndex = view.u16(recordAt + itemIndexAt);
      const isPattern = itemIndex > FLP_PATTERN_BASE;
      items.push({
        position: view.u32(recordAt + position),
        length: view.u32(recordAt + length),
        // Stored reversed; the real index needs the version (resolved in `resolvePlaylistTracks`).
        track: view.u16(recordAt + track),
        kind: isPattern ? 'pattern' : 'channel',
        ref: isPattern ? itemIndex - FLP_PATTERN_BASE : itemIndex,
        muted: (view.u16(recordAt + flags) & FLP_ITEM_MUTED) !== 0,
        startOffset: itemOffset(view, recordAt + startOffset, isPattern, ppq),
        endOffset: itemOffset(view, recordAt + endOffset, isPattern, ppq),
      });
      this.totalItems++;
    }
  }

  private onTrackData(at: number, size: number): void {
    const arrangement = this.currentArrangement();
    if (arrangement.tracks.length >= FLP_LIMITS.maxTracks) {
      this.cap('playlist tracks');
      return;
    }
    arrangement.tracks.push({
      index: arrangement.tracks.length,
      ...(size >= 8 ? { color: colorOf(this.view.u32(at + TRACK_COLOR_OFFSET)) } : {}),
      enabled: size >= 13 ? this.view.u8(at + TRACK_ENABLED_OFFSET) !== 0 : true,
    });
  }

  private onMarkerPosition(value: number): void {
    const arrangement = this.currentArrangement();
    if (arrangement.markers.length >= FLP_LIMITS.maxMarkers) {
      this.cap('markers');
      this.marker = null;
      return;
    }
    this.marker = { position: value & MARKER_POSITION_MASK, kind: value >>> MARKER_POSITION_BITS };
    arrangement.markers.push(this.marker);
  }

  // --- Mixer -----------------------------------------------------------------------------------

  /** "Slot index" closes a slot: the plugin events gathered since the last one become that slot. */
  private onSlotIndex(index: number): void {
    this.enterMixer();
    const insert = this.currentInsert();
    const slot = this.slot;
    if (insert && slot?.internalName) {
      slot.index = index;
      if (insert.slots.length < MAX_SLOTS_PER_INSERT) insert.slots.push(slot);
    }
    this.slot = null;
  }

  private onInsertRouting(at: number, size: number): void {
    this.enterMixer();
    // PyFLP ends an insert at its Output event, FLParser at its routing: a second routing for
    // the same insert means the file has no Output events, so the routing starts the next one.
    if (this.project.inserts[this.insertIndex]?.routing) this.insertIndex++;
    const insert = this.currentInsert();
    if (!insert) return;
    const routing: boolean[] = [];
    for (let i = 0; i < Math.min(size, FLP_LIMITS.maxInserts); i++) routing.push(this.bytes[at + i] !== 0);
    insert.routing = routing;
  }

  private onMixerParams(at: number, size: number): void {
    this.enterMixer();
    const recordCount = Math.floor(size / FLP_MIXER_PARAM_SIZE);
    for (let i = 0; i < recordCount; i++) {
      const recordAt = at + i * FLP_MIXER_PARAM_SIZE;
      const insertAndSlot = this.view.u16(recordAt + FLP_MIXER_PARAM_FIELD.insertAndSlot);
      this.mixerParams.push({
        id: this.view.u8(recordAt + FLP_MIXER_PARAM_FIELD.paramId),
        insert: (insertAndSlot >> MIXER_PARAM_INSERT_SHIFT) & MIXER_PARAM_INSERT_MASK,
        slot: insertAndSlot & MIXER_PARAM_SLOT_MASK,
        value: this.view.i32(recordAt + FLP_MIXER_PARAM_FIELD.value),
      });
    }
  }

  private onAutomationLinks(at: number, size: number): void {
    const links = this.project.automationLinks;
    const recordCount = Math.floor(size / FLP_AUTOMATION_LINK_SIZE);
    for (let i = 0; i < recordCount && links.length < MAX_AUTOMATION_LINKS; i++) {
      const recordAt = at + i * FLP_AUTOMATION_LINK_SIZE;
      links.push({
        channel: this.view.u8(recordAt + FLP_AUTOMATION_LINK_FIELD.channel),
        param: this.view.u16(recordAt + FLP_AUTOMATION_LINK_FIELD.param),
        destination: this.view.u16(recordAt + FLP_AUTOMATION_LINK_FIELD.destination),
      });
    }
  }
}
