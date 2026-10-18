import { describe, expect, it } from 'vitest';
import { nameHint, nameTokens } from './names';

describe('file name hints', () => {
  it('splits names into words, camelCase and digit joins included', () => {
    expect(nameTokens('Kick_Hard-03.wav')).toEqual(['kick', 'hard', '03']);
    expect(nameTokens('HiHatOpen2.wav')).toEqual(['hi', 'hat', 'open', '2']);
    expect(nameTokens('128bpm Am.flac')).toEqual(['128', 'bpm', 'am']);
  });

  it('reads the category from the file name', () => {
    const cases: [string, string | undefined][] = [
      ['Kick 01.wav', 'kick'],
      ['BD_Punch.wav', 'kick'],
      ['Bass Drum Deep.wav', 'kick'],
      ['SNR_tight.wav', 'snare'],
      ['Snare Roll.wav', 'snare'],
      ['Rim Shot.wav', 'snare'],
      ['Clap_Wide.wav', 'clap'],
      ['HH_closed_02.wav', 'hat'],
      ['Hi Hat 3.wav', 'hat'],
      ['OpenHat.wav', 'open-hat'],
      ['Hat Open 1.wav', 'open-hat'],
      ['hihat_open.wav', 'open-hat'],
      ['OH 02.wav', undefined],
      ['Crash 1.wav', 'cymbal'],
      ['Ride_Bell.wav', 'cymbal'],
      ['Tom Floor.wav', 'tom'],
      ['Shaker_16th.wav', 'perc'],
      ['Conga Hi.wav', 'perc'],
      ['808 C#1.wav', '808'],
      ['Sub_Bass_E.wav', '808'],
      ['Riser 8 bars.wav', 'fx'],
      ['Impact_Big.wav', 'fx'],
      ['Vox Chant.wav', 'vocal'],
      ['Pluck Lead.wav', 'tonal'],
      ['Chord Stab Dm.wav', 'tonal'],
      ['Sample 12.wav', undefined],
    ];
    for (const [file, want] of cases) expect(nameHint(file).category, file).toBe(want);
  });

  it('reads the category from a folder name, weaker than the file name', () => {
    expect(nameHint('Drums/Snares/Take 5.wav')).toMatchObject({ folderCategory: 'snare' });
    expect(nameHint('Drums/Snares/Take 5.wav').category).toBeUndefined();
    expect(nameHint('808s/Hit 7.wav').folderCategory).toBe('808');
    expect(nameHint('Kits/Trap/Clap 2.wav')).toMatchObject({ category: 'clap' });
  });

  it('reads loop or one-shot, the tempo and the key', () => {
    expect(nameHint('Drum Loop 128 bpm.wav')).toMatchObject({ kind: 'loop', bpm: 128 });
    expect(nameHint('Melody_90BPM_Am_loop.wav')).toMatchObject({ kind: 'loop', bpm: 90, root: 9, mode: 'minor' });
    expect(nameHint('Bass Loop 140 F#min.wav')).toMatchObject({ bpm: 140, root: 6, mode: 'minor' });
    expect(nameHint('Pad C# minor.wav')).toMatchObject({ root: 1, mode: 'minor' });
    expect(nameHint('Chords Dmaj.wav')).toMatchObject({ root: 2, mode: 'major' });
    expect(nameHint('Kick One Shot.wav').kind).toBe('one-shot');
    // A bare letter is a word, not a key.
    expect(nameHint('Kick A.wav').root).toBeUndefined();
    // A tempo outside what music uses is not one.
    expect(nameHint('Take 7 bpm 999.wav').bpm).toBeUndefined();
  });

  it('reads the note of a one-shot from its name', () => {
    expect(nameHint('Bass A2.wav').root).toBe(9);
    expect(nameHint('808 C#1.wav').root).toBe(1);
    expect(nameHint('Lead Eb3.wav').root).toBe(3);
  });
});
