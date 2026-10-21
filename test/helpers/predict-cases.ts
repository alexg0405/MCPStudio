/**
 * Requests a musician would type, with what a correct answer to each needs from the catalog. `test/unit/ai-predict.test.ts`
 * checks the guess of which plugins and commands to attach against them; `test/unit/ai-first-turn.test.ts` measures the size
 * of the first turn with them.
 *
 * Each need is a list of alternatives: one of them has to be in the guess ("reverb" needs the Reverb; "grit" is the
 * Distortion or the Saturator or the Lo-Fi). Plugin ids are `agstudio.<name>`, piano-roll tools `agstudio.notes.<name>`,
 * chains are named, commands have their ids.
 */
export interface PredictCase {
  request: string;
  needs: string[][];
}

const plugin = (name: string) => `agstudio.${name}`;
const notes = (name: string) => `agstudio.notes.${name}`;

/** The requests the producers' words (src/app/ai/predict-words.ts) were tuned on. */
export const TUNED_REQUESTS: PredictCase[] = [
  { request: 'make a dark grunge beat', needs: [[plugin('distortion'), plugin('saturator'), plugin('lofi')]] },
  { request: 'add reverb to the lead', needs: [[plugin('reverb')]] },
  { request: 'sidechain the bass to the kick', needs: [[plugin('ducker'), plugin('compressor')]] },
  { request: 'make harmonies', needs: [['harmonies.make', plugin('harmonizer')]] },
  { request: 'open the clip launcher', needs: [['launcher.open']] },
  { request: 'save it', needs: [['file.save']] },
  { request: 'export the song as an mp3', needs: [['file.exportMp3', 'file.exportAudioNow']] },
  { request: 'export stems', needs: [['file.exportStems']] },
  { request: 'undo that', needs: [['edit.undo']] },
  { request: 'turn on the metronome', needs: [['transport.metronome']] },
  { request: 'show me the mixer', needs: [['view.mixer']] },
  { request: 'tap in the tempo', needs: [['transport.tapTempo']] },
  { request: 'put a chord progression on the chord track', needs: [['chords.progression']] },
  { request: 'arpeggiate the melody', needs: [[notes('arpeggiate')]] },
  { request: 'put a live arpeggiator on the pad', needs: [['arp']] },
  { request: 'every key I play should be a chord', needs: [['chord', 'Chords in the song key']] },
  { request: 'keep the notes in the song key while I play', needs: [['scale', 'Stay in key and tidy']] },
  { request: 'give the synth a trance gate', needs: [['Trance gate']] },
  { request: 'midi echo on the keys', needs: [['echo', 'Dub echo']] },
  { request: 'parallel compression on the drum bus', needs: [['Parallel NY compression', plugin('compressor')]] },
  { request: 'multiband saturation on the bass', needs: [['Multiband saturation']] },
  { request: 'widen the pad with a mid side rack', needs: [['Mid/side widener']] },
  { request: 'build me a rack with a macro for the delay throws', needs: [['Dub delay throws with macro']] },
  { request: 'humanize the hi-hats', needs: [[notes('humanize')]] },
  { request: 'quantize the piano part with some swing', needs: [[notes('quantize')]] },
  { request: 'make the vocal sound wider and doubled', needs: [[plugin('doubler'), plugin('stereo'), plugin('chorus')]] },
  { request: 'tune the vocal to the key', needs: [[plugin('tune'), 'pitchEditor.snapToKey']] },
  { request: 'get rid of the hiss in my recording', needs: [[plugin('denoise'), 'cleanup.apply']] },
  { request: 'tame the harsh s sounds in the vocal', needs: [[plugin('de-esser')]] },
  { request: 'make the bass punchier', needs: [[plugin('transient'), plugin('compressor'), plugin('eq')]] },
  { request: 'master the song so it is loud', needs: [[plugin('limiter'), plugin('maximizer')]] },
  { request: 'add a delay on the snare', needs: [[plugin('delay')]] },
  { request: 'a stutter effect at the end of the build', needs: [[plugin('stutter')]] },
  { request: 'make a lo-fi hip hop chord loop', needs: [[plugin('lofi')]] },
  {
    request: 'a lush pad with a long reverb',
    needs: [[plugin('wavetable'), plugin('3xosc'), plugin('granular')], [plugin('reverb')]],
  },
  { request: 'a plucked guitar-like melody', needs: [[plugin('pluck')]] },
  { request: 'an electric piano chord', needs: [[plugin('fm')]] },
  { request: 'chop this sample into slices', needs: [[plugin('slicer'), 'audioClip.sliceAtTransients']] },
  { request: 'add a phaser sweep to the pad', needs: [[plugin('phaser')]] },
  { request: 'turn my voice into a robot', needs: [[plugin('vocoder'), plugin('tune')]] },
  { request: 'cut the mud below 200 hz on the guitar', needs: [[plugin('eq'), plugin('eq-pro'), plugin('filter')]] },
  { request: 'a low-pass filter sweep on the lead', needs: [[plugin('filter')]] },
  { request: 'tighten the kick with a gate', needs: [[plugin('gate')]] },
  { request: 'show the loudness report', needs: [['meters.report']] },
  { request: 'add a marker at the drop', needs: [['playlist.addMarker']] },
  { request: 'import a midi file', needs: [['file.importMidi']] },
  { request: 'start a new project', needs: [['file.new']] },
  { request: 'clean up my vocal take', needs: [['cleanup.apply', 'cleanup.openClip']] },
  { request: 'export a vertical music video', needs: [['file.exportVideoNow', 'file.exportVideo']] },
  { request: 'write a melody in the song key', needs: [[notes('generate')]] },
  { request: 'transpose the bassline up a fifth', needs: [[notes('transpose'), 'pianoRoll.transpose']] },
  {
    request: 'put a vocal chain on the vocals',
    needs: [['Clean pop vocal', 'Rap vocal', 'Airy ballad', 'Lo-fi vocal', 'Trap auto-tune vocal', 'Podcast voice']],
  },
  { request: 'record audio from my microphone', needs: [['transport.recordAudio']] },
  { request: 'show the piano roll', needs: [['view.pianoRoll']] },
  { request: 'switch to the mix layout', needs: [['view.layout.mix']] },
  { request: 'analyze the spectrum', needs: [[plugin('analyzer'), 'view.meters']] },
  // From a second batch, written after the tuning: its first run missed this one (the Reverb has a "Cathedral" preset, but
  // presets are not searched), so it got its word and joined the tuned requests.
  { request: 'can you make it sound like a cathedral', needs: [[plugin('reverb')]] },
];

/** Requests written before the producers' words were tuned and not looked at while tuning them. */
export const HELD_OUT_REQUESTS: PredictCase[] = [
  { request: 'give me a wobbly flanged guitar', needs: [[plugin('flanger'), plugin('phaser'), plugin('chorus')], [plugin('pluck')]] },
  { request: 'crush the drums for a gritty sound', needs: [[plugin('distortion'), plugin('saturator'), plugin('lofi')]] },
  { request: 'make the chorus section wider', needs: [[plugin('stereo'), plugin('chorus'), plugin('doubler')]] },
  { request: 'the snare needs more snap', needs: [[plugin('transient'), plugin('compressor'), plugin('eq')]] },
  { request: 'mute the click and turn off the count-in', needs: [['transport.metronome', 'transport.countIn']] },
  { request: 'bounce stems for mixing', needs: [['file.exportStems']] },
  { request: 'i want to sing along, record my voice', needs: [['transport.recordAudio', 'transport.record']] },
  { request: 'glitch the vocal chop', needs: [[plugin('stutter'), plugin('granular'), plugin('slicer')]] },
  { request: 'bring back the previous version of the song', needs: [['versions.restore', 'edit.undo']] },
  { request: 'make the 808 longer and add some drive', needs: [[plugin('bass808')], [plugin('distortion'), plugin('saturator')]] },
  { request: 'type the chords Am F C G', needs: [['chords.type', 'chords.progression']] },
  { request: 'write out the sheet music', needs: [['view.sheetMusic', 'sheet.print']] },
];
