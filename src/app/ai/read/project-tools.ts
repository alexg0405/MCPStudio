/** Read tools for the project as a whole and the app around it: overview, transport, selection, settings, windows. */
import { MASTER, type Clip, type Project } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import { patternLength } from '@core/query/queries';
import { songSections } from '@core/query/sections';
import { TICKS_PER_STEP } from '@core/time/ppq';
import type { Services } from '../../services';
import { RECORD_GRIDS } from '../ops/session';
import { OPEN_WINDOWS } from '../ops/windows';
import { channelBrief, soundChannels } from './describe';
import { barCount, barEndAt, barNumberAt, mixerNumber, mixerTrackName, projectOf, round2, round3, tool } from './tool';

/** The record-quantize setting as the name the `settings` action takes ("1/16"), or its raw tick count. */
function recordGridName(recordQuantizeTicks: number): string {
  const named = Object.entries(RECORD_GRIDS).find(([, ticks]) => ticks === recordQuantizeTicks);
  return named?.[0] ?? `${recordQuantizeTicks} ticks`;
}

/** The song key as `{ root, scale }`, or null when none is set. */
function keyOf(project: Project) {
  const { key } = project.transport;
  return key ? { root: key.root, scale: key.scale } : null;
}

/** Every pattern with its length and how many channels have notes in it. */
function patternList(project: Project) {
  return project.patternOrder.map((id) => {
    const pattern = project.patterns[id]!;
    const channelsWithNotes = Object.values(pattern.notes).filter((notes) => notes && Object.keys(notes).length);
    return {
      id,
      name: pattern.name,
      bars: barCount(project, patternLength({ ...pattern }, project.transport.timeSig)),
      channels_with_notes: channelsWithNotes.length,
    };
  });
}

/** Playlist tracks in order, numbered from 1, with how many clips each holds. */
function playlistTrackList(project: Project) {
  const clips = Object.values(project.playlist.clips);
  return project.playlist.laneOrder.map((id, index) => ({
    n: index + 1,
    id,
    name: project.playlist.lanes[id]!.name,
    clips: clips.filter((clip) => clip.laneId === id).length,
  }));
}

export const getProject = tool(
  'get_project',
  'An overview of the project: title, tempo, time signature, key, length, and every channel, pattern, mixer track, playlist track and marker with its id and name. Start here.',
  {},
  (services) => {
    const project = projectOf(services);
    const { transport } = project;
    const view = services.view.getState();
    const markers = Object.values(project.playlist.markers).sort((a, b) => a.tick - b.tick);
    return {
      title: project.meta.title,
      ...(project.meta.author ? { author: project.meta.author } : {}),
      bpm: transport.bpm,
      time_signature: `${transport.timeSig.num}/${transport.timeSig.den}`,
      swing: round2(transport.swing),
      key: keyOf(project),
      length_bars: barCount(project, songLength(project)),
      mode: view.mode,
      current_pattern: view.currentPatternId,
      channels: soundChannels(project).map((channel) => channelBrief(project, services, channel)),
      automation_channels: project.channelOrder.length - soundChannels(project).length,
      patterns: patternList(project),
      mixer: project.mixer.order.map((id) => ({
        n: mixerNumber(project, id),
        id,
        name: mixerTrackName(project, id),
      })),
      tracks: playlistTrackList(project),
      markers: markers.map((marker) => ({ id: marker.id, name: marker.name, bar: barNumberAt(project, marker.tick) })),
      sections: songSections(project).map((section) => ({
        name: section.name,
        from_bar: barNumberAt(project, section.from),
        to_bar: barEndAt(project, section.to),
      })),
    };
  },
);

export const getTransport = tool(
  'get_transport',
  'Tempo, time signature, swing, key, pattern or song mode, whether it plays, the playhead and song position, the loop region and the record settings.',
  {},
  (services) => {
    const project = projectOf(services);
    const { transport } = project;
    const view = services.view.getState();
    const prefs = services.prefs.getState();
    const playhead = services.engine.playing ? services.engine.playhead() : view.songStart;
    return {
      bpm: transport.bpm,
      time_signature: `${transport.timeSig.num}/${transport.timeSig.den}`,
      swing: round2(transport.swing),
      key: keyOf(project),
      mode: view.mode,
      playing: services.engine.playing,
      position: { tick: Math.round(playhead), bar: barNumberAt(project, playhead) },
      song_start_bar: barNumberAt(project, view.songStart),
      loop: view.loop
        ? { from_bar: barNumberAt(project, view.loop.start), to_bar: barEndAt(project, view.loop.end) }
        : null,
      current_pattern: view.currentPatternId,
      song_length_bars: barCount(project, songLength(project)),
      metronome: prefs.metronome,
      count_in_bars: prefs.countInBars,
      record: {
        armed: services.recording.armed,
        notes: prefs.recordNotes,
        audio: prefs.recordAudio,
        mode: prefs.recordMode,
        quantize: recordGridName(prefs.recordQuantize),
      },
    };
  },
);

/** The span of the selected clips, as bars (nothing for an empty selection). */
function clipSpan(project: Project, clips: Clip[]) {
  if (clips.length === 0) return {};
  const firstStart = Math.min(...clips.map((clip) => clip.start));
  const lastEnd = Math.max(...clips.map((clip) => clip.start + clip.length));
  return { from_bar: barNumberAt(project, firstStart), to_bar: barEndAt(project, lastEnd) };
}

/** The extent of the selected notes in steps and keys (nothing for an empty selection). */
function noteSpan(notes: { tick: number; length: number; key: number }[]) {
  if (notes.length === 0) return {};
  return {
    from_step: round3(Math.min(...notes.map((note) => note.tick)) / TICKS_PER_STEP),
    to_step: round3(Math.max(...notes.map((note) => note.tick + note.length)) / TICKS_PER_STEP),
    lowest_key: Math.min(...notes.map((note) => note.key)),
    highest_key: Math.max(...notes.map((note) => note.key)),
  };
}

export const getSelection = tool(
  'get_selection',
  'What is selected now: the channel, the mixer track, the pattern being edited, the selected playlist clips and the selected piano-roll notes.',
  {},
  (services) => {
    const project = projectOf(services);
    const editor = services.editor.getState();
    const session = services.session.getState();
    const view = services.view.getState();
    const clips = editor.clipSelection.map((id) => project.playlist.clips[id]).filter((clip): clip is Clip => !!clip);
    const pattern = view.currentPatternId ? project.patterns[view.currentPatternId] : undefined;
    const channelId = session.selectedChannelId;
    const selectedNotes =
      pattern && channelId
        ? Object.values(pattern.notes[channelId] ?? {}).filter((note) => editor.noteSelection.includes(note.id))
        : [];
    const channel = channelId ? project.channels[channelId] : undefined;
    const insertId = session.selectedInsertId;
    return {
      channel: channel ? { id: channel.id, name: channel.name } : null,
      insert: insertId
        ? { n: mixerNumber(project, insertId), id: insertId, name: mixerTrackName(project, insertId) }
        : { n: 0, id: MASTER, name: 'Master' },
      pattern: pattern ? { id: pattern.id, name: pattern.name } : null,
      clips: {
        count: clips.length,
        ids: clips.slice(0, 200).map((clip) => clip.id),
        ...clipSpan(project, clips),
      },
      notes: { count: selectedNotes.length, ...noteSpan(selectedNotes) },
    };
  },
);

export const getSettings = tool(
  'get_settings',
  'The app’s settings: playback and recording preferences, audio, export defaults, look, and the editors’ tool and grid (what the settings action changes).',
  {},
  (services) => {
    const prefs = services.prefs.getState();
    const editor = services.editor.getState();
    return {
      metronome: prefs.metronome,
      count_in_bars: prefs.countInBars,
      record_mode: prefs.recordMode,
      record_quantize: recordGridName(prefs.recordQuantize),
      record_notes: prefs.recordNotes,
      record_audio: prefs.recordAudio,
      follow_playhead: prefs.followPlayhead,
      tooltips: prefs.tooltips,
      touch_layout: prefs.touchLayout,
      keys_velocity: prefs.keysVelocity,
      typing_piano: prefs.typingPiano,
      piano_octave: prefs.pianoOctave,
      midi_input: prefs.midiInput,
      audio_buffer: prefs.audioBuffer,
      sample_memory_mb: prefs.sampleMemoryMb,
      scope: prefs.scopeMode,
      input_device: prefs.audioInputDevice || 'system default',
      input_channels: prefs.audioInputChannels,
      input_track: prefs.audioInputTrack || 'master',
      monitor: prefs.audioMonitor,
      latency_offset_ms: prefs.recordLatencyOffsetMs,
      output_device: prefs.outputDevice || 'system default',
      theme: prefs.theme,
      accent: prefs.accent,
      export: exportSettings(prefs),
      piano_roll: {
        tool: editor.pianoRoll.tool,
        snap: editor.pianoRoll.snap,
        scale_snap: editor.pianoRoll.scaleSnap,
        scale_highlight: editor.pianoRoll.scaleHighlight,
      },
      playlist: { tool: editor.playlist.tool, snap: editor.playlist.snap },
    };
  },
);

type Prefs = ReturnType<Services['prefs']['getState']>;

/** The export defaults, with the bit depth of whichever codec is chosen. */
function exportSettings(prefs: Prefs) {
  const pcmBits = { pcm16: 16, pcm24: 24, float32: 32 }[prefs.exportFormat];
  return {
    codec: prefs.exportCodec,
    bits: prefs.exportCodec === 'flac' ? prefs.exportFlacBits : pcmBits,
    sample_rate: prefs.exportSampleRate,
    mp3_kbps: prefs.exportMp3Kbps,
    normalize: prefs.exportNormalize,
    stems: prefs.exportStems,
    master_chain: prefs.exportMasterChain,
    stems_to: prefs.exportStemsTo,
  };
}

export const getWindows = tool(
  'get_windows',
  'The windows that are open (id, type, visible, focused, maximized), whether the browser panel shows, and the window names the open action takes.',
  {},
  (services) => {
    const view = services.view.getState();
    return {
      windows: Object.values(view.windows)
        .sort((a, b) => b.z - a.z)
        .map((window) => ({
          id: window.id,
          type: window.type,
          visible: window.visible,
          ...(view.focusedId === window.id ? { focused: true } : {}),
          ...(window.maximized ? { maximized: true } : {}),
        })),
      browser: view.browser.visible,
      available: [...OPEN_WINDOWS],
    };
  },
);
