/** The `settings` action: preferences and the editors' tool and grid. They are not the project, so no undo step. */
import { SNAP_OPTIONS, type Snap } from '@core/time/snap';
import type { Services } from '../../../services';
import { PIANO_ROLL_TOOLS, PLAYLIST_TOOLS } from '../../../stores/editor';
import type { AudioBufferChoice, PrefsState } from '../../../stores/prefs';
import type { AiAction } from '../../schema';
import { ActionError, type OpContext } from '../context';
import { bool, isObj, num, r2, str } from '../values';
import type { SessionOutput } from './output';

/** Record-quantize grids by name (ticks; 0 = off). */
export const RECORD_GRIDS: Readonly<Record<string, number>> = {
  off: 0,
  '1/4': 960,
  '1/8': 480,
  '1/16': 240,
  '1/32': 120,
  '1/8t': 320,
  '1/16t': 160,
};
export const AUDIO_BUFFERS: readonly AudioBufferChoice[] = ['auto', 'small', 'medium', 'large'];
export const SCOPES = ['scope', 'spectrum', 'off'] as const;
export const SNAPS = SNAP_OPTIONS.map((option) => option.value);

/** Count-in bars the settings action allows. */
const MAX_COUNT_IN_BARS = 4;
/** Typing-keyboard octaves (0–9; 5 is the one with middle C). */
const MAX_PIANO_OCTAVE = 9;
/** Decoded-audio memory limits (MB). */
const MIN_SAMPLE_MEMORY_MB = 256;
const MAX_SAMPLE_MEMORY_MB = 16384;
/** The recording latency correction limit either way (ms). */
const MAX_LATENCY_OFFSET_MS = 200;
/** Export sample rates (Hz) and MP3 bit rates (kbps) the action accepts. */
const EXPORT_SAMPLE_RATES_HZ = [44100, 48000, 96000];
const EXPORT_MP3_KBPS = [128, 192, 256, 320];

/** What one settings action collects: the preferences to set and the words for the chat. */
interface SettingsEdit {
  action: AiAction;
  context: OpContext;
  out: SessionOutput;
  prefs: Partial<PrefsState>;
  text: string[];
}

const onOff = (value: boolean) => (value ? 'on' : 'off');

/** The export defaults as `settings.export` names them. */
function exportPatch(
  exportSettings: Record<string, unknown>,
  warn: (message: string) => void,
): { patch: Partial<PrefsState>; text: string[] } {
  const patch: Partial<PrefsState> = {};
  const text: string[] = [];
  const codec = (['wav', 'flac', 'mp3'] as const).find((candidate) => candidate === str(exportSettings.codec));
  if (exportSettings.codec !== undefined && !codec) {
    warn(`export codec must be wav, flac or mp3 (not ${JSON.stringify(exportSettings.codec)})`);
  }
  if (codec) {
    patch.exportCodec = codec;
    text.push(codec.toUpperCase());
  }
  const bits = num(exportSettings.bits);
  if (bits !== undefined) {
    if (bits === 16 || bits === 24) {
      patch.exportFormat = bits === 16 ? 'pcm16' : 'pcm24';
      patch.exportFlacBits = bits;
      text.push(`${bits}-bit`);
    } else if (bits === 32 && codec !== 'flac') {
      patch.exportFormat = 'float32';
      text.push('32-bit float');
    } else warn(`export bits must be 16 or 24 (WAV also 32), not ${bits}`);
  }
  const sampleRate = num(exportSettings.sample_rate);
  if (sampleRate !== undefined) {
    if (EXPORT_SAMPLE_RATES_HZ.includes(sampleRate)) {
      patch.exportSampleRate = sampleRate;
      text.push(`${sampleRate / 1000} kHz`);
    } else warn('export sample_rate must be 44100, 48000 or 96000');
  }
  const mp3Kbps = num(exportSettings.mp3_kbps);
  if (mp3Kbps !== undefined) {
    if (EXPORT_MP3_KBPS.includes(mp3Kbps)) {
      patch.exportMp3Kbps = mp3Kbps;
      text.push(`${mp3Kbps} kbps`);
    } else warn('export mp3_kbps must be 128, 192, 256 or 320');
  }
  for (const [key, pref, label] of [
    ['normalize', 'exportNormalize', 'normalize'],
    ['stems', 'exportStems', 'stems'],
    ['master_chain', 'exportMasterChain', 'stems through the master chain'],
  ] as const) {
    const value = bool(exportSettings[key]);
    if (value !== undefined) {
      patch[pref] = value;
      text.push(`${label} ${onOff(value)}`);
    }
  }
  const stemsTo = (['folder', 'zip'] as const).find((candidate) => candidate === str(exportSettings.stems_to));
  if (exportSettings.stems_to !== undefined && !stemsTo) warn('export stems_to must be folder or zip');
  if (stemsTo) {
    patch.exportStemsTo = stemsTo;
    text.push(`stems into a ${stemsTo}`);
  }
  return { patch, text };
}

/** The plain on/off switches. */
function applySwitches({ action, prefs, text }: SettingsEdit): void {
  const flag = (key: string, pref: keyof PrefsState, label: string) => {
    const value = bool(action[key]);
    if (value === undefined) return;
    (prefs as Record<string, unknown>)[pref] = value;
    text.push(`${label} ${onOff(value)}`);
  };
  flag('metronome', 'metronome', 'metronome');
  flag('record_notes', 'recordNotes', 'record notes');
  flag('record_audio', 'recordAudio', 'record audio');
  flag('follow_playhead', 'followPlayhead', 'follow playhead');
  flag('tooltips', 'tooltips', 'tooltips');
  flag('typing_piano', 'typingPiano', 'typing piano');
  flag('midi_input', 'midiInput', 'MIDI input');
  flag('monitor', 'audioMonitor', 'input monitoring');
}

/** Count-in, record mode and the grid recorded notes snap to. */
function applyRecordSettings({ action, out, prefs, text }: SettingsEdit): void {
  const countIn = num(action.count_in_bars);
  if (countIn !== undefined) {
    prefs.countInBars = Math.max(0, Math.min(MAX_COUNT_IN_BARS, Math.round(countIn)));
    text.push(`count-in ${prefs.countInBars} bar${prefs.countInBars === 1 ? '' : 's'}`);
  }
  const recordMode = (['overdub', 'replace'] as const).find((candidate) => candidate === str(action.record_mode));
  if (action.record_mode !== undefined && !recordMode) out.warn('record_mode must be overdub or replace');
  if (recordMode) {
    prefs.recordMode = recordMode;
    text.push(`record mode ${recordMode}`);
  }
  if (action.record_quantize !== undefined) {
    const grid = str(action.record_quantize);
    const gridName = Object.keys(RECORD_GRIDS).find((name) => name === grid);
    if (gridName === undefined) {
      out.warn(`record_quantize must be one of ${Object.keys(RECORD_GRIDS).join(', ')}`);
    } else {
      prefs.recordQuantize = RECORD_GRIDS[gridName]!;
      text.push(`record quantize ${gridName}`);
    }
  }
}

/** The typing keyboard, audio buffer, sample memory, toolbar display, audio input and latency correction. */
function applyAudioSettings({ action, context, out, prefs, text }: SettingsEdit): void {
  const octave = num(action.piano_octave);
  if (octave !== undefined) {
    prefs.pianoOctave = Math.max(0, Math.min(MAX_PIANO_OCTAVE, Math.round(octave)));
    text.push(`typing keyboard octave ${prefs.pianoOctave}`);
  }
  const buffer = AUDIO_BUFFERS.find((candidate) => candidate === str(action.audio_buffer));
  if (action.audio_buffer !== undefined && !buffer) out.warn('audio_buffer must be auto, small, medium or large');
  if (buffer) {
    prefs.audioBuffer = buffer;
    if (buffer === 'auto') prefs.autoBufferSize = 'small';
    else prefs.audioBufferPicked = true;
    text.push(`audio buffer ${buffer}`);
  }
  const memoryMb = num(action.sample_memory_mb);
  if (memoryMb !== undefined) {
    prefs.sampleMemoryMb = Math.max(MIN_SAMPLE_MEMORY_MB, Math.min(MAX_SAMPLE_MEMORY_MB, Math.round(memoryMb)));
    text.push(`sample memory ${prefs.sampleMemoryMb} MB`);
  }
  const scope = SCOPES.find((candidate) => candidate === str(action.scope));
  if (action.scope !== undefined && !scope) out.warn('scope must be scope, spectrum or off');
  if (scope) {
    prefs.scopeMode = scope;
    text.push(`toolbar display ${scope}`);
  }
  const inputChannels = (['mono', 'stereo'] as const).find((candidate) => candidate === str(action.input_channels));
  if (action.input_channels !== undefined && !inputChannels) out.warn('input_channels must be mono or stereo');
  if (inputChannels) {
    prefs.audioInputChannels = inputChannels;
    text.push(`input ${inputChannels}`);
  }
  if (action.input_track !== undefined) {
    try {
      const id = context.insert(action.input_track);
      prefs.audioInputTrack = id === 'master' ? '' : id;
      text.push(`input track ${context.project.mixer.inserts[id]?.name ?? id}`);
    } catch (error) {
      out.warn(error instanceof ActionError ? error.message : String(error));
    }
  }
  const latencyMs = num(action.latency_offset_ms);
  if (latencyMs !== undefined) {
    prefs.recordLatencyOffsetMs = Math.max(-MAX_LATENCY_OFFSET_MS, Math.min(MAX_LATENCY_OFFSET_MS, latencyMs));
    text.push(`latency correction ${r2(prefs.recordLatencyOffsetMs)} ms`);
  }
}

/** The export defaults. */
function applyExportSettings({ action, out, prefs, text }: SettingsEdit): void {
  if (!isObj(action.export)) return;
  const exported = exportPatch(action.export, out.warn);
  Object.assign(prefs, exported.patch);
  if (exported.text.length) text.push(`export ${exported.text.join(', ')}`);
}

/** "tool pencil, snap 1/8, scale snap on": a patch to an editor's settings in words. */
function describeEditorPatch(patch: Record<string, unknown>): string {
  return Object.entries(patch)
    .map(([key, value]) => {
      const name = key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
      return `${name} ${typeof value === 'boolean' ? onOff(value) : String(value)}`;
    })
    .join(', ');
}

/** The piano roll's and the playlist's tool and snap (the piano roll also its scale options). */
function applyEditorSettings(services: Services, { action, out, text }: SettingsEdit): void {
  const editor = services.editor.getState();
  for (const [key, tools, set] of [
    ['piano_roll', PIANO_ROLL_TOOLS, editor.setPianoRoll],
    ['playlist', PLAYLIST_TOOLS, editor.setPlaylist],
  ] as const) {
    const given = action[key];
    if (!isObj(given)) continue;
    const label = key.replace('_', ' ');
    const patch: Record<string, unknown> = {};
    const tool = (tools as readonly string[]).find((candidate) => candidate === str(given.tool));
    if (given.tool !== undefined && !tool) out.warn(`${label} tool must be one of ${tools.join(', ')}`);
    if (tool) patch.tool = tool;
    const snap = SNAPS.find((candidate) => candidate === str(given.snap));
    if (given.snap !== undefined && !snap) out.warn(`snap must be one of ${SNAPS.join(', ')}`);
    if (snap) patch.snap = snap satisfies Snap;
    if (key === 'piano_roll') {
      if (bool(given.scale_snap) !== undefined) patch.scaleSnap = given.scale_snap;
      if (bool(given.scale_highlight) !== undefined) patch.scaleHighlight = given.scale_highlight;
    }
    if (Object.keys(patch).length) {
      (set as (changes: Record<string, unknown>) => void)(patch);
      text.push(`${label} ${describeEditorPatch(patch)}`);
    }
  }
}

/** Applies a `settings` action: preferences first, then the editors; says what changed (or that nothing did). */
export function applySettings(services: Services, action: AiAction, context: OpContext, out: SessionOutput): void {
  const edit: SettingsEdit = { action, context, out, prefs: {}, text: [] };
  applySwitches(edit);
  applyRecordSettings(edit);
  applyAudioSettings(edit);
  applyExportSettings(edit);
  if (Object.keys(edit.prefs).length) services.prefs.getState().set(edit.prefs);
  applyEditorSettings(services, edit);
  if (edit.text.length) out.ui.push(`Settings: ${edit.text.join(', ')}`);
  else if (!isObj(action.export)) out.warn('nothing to change (give a setting)');
}
