/**
 * The bands of a song: the drums, bass and chord parts that play under a melody, one band for each kind of section (the
 * intro keeps to chords, the verse adds drums and bass, the build leans forward, the chorus plays everything, the last
 * chorus adds more, the break takes the beat away). Every band is one four-bar pattern.
 */
import type { BeatNote, BeatTrack } from '../beat/spec';
import { songBass } from './bass';
import { songArp } from './colour';
import { songDrums, type DrumTier } from './drums';
import { chordPartTrack } from './parts';
import { songMelody, type SongMotifs } from './melody';
import type { CompShape, StyleProfile } from './profiles';
import type { PlacedChord, SongRequest } from './types';

/** The kinds of band. */
export type BandKind = 'intro' | 'verse' | 'build' | 'chorus' | 'chorusFinal' | 'break';

/** What a band is built from. */
export interface BandInput {
  kind: BandKind;
  request: SongRequest;
  profile: StyleProfile;
  /** The four-bar chord loop the band plays. */
  chords: readonly PlacedChord[];
  motifs: SongMotifs;
  /** 1 to 5, from the section the band is first used in. */
  energy: number;
}

/** What each band has: its drums (none for the quiet ones), whether it has a bass, how its chord parts play and how loud. */
interface BandRecipe {
  drums: DrumTier | null;
  bass: boolean;
  /** Which of a chord part's shapes plays: its groove, peak or lite one. */
  shape: 'groove' | 'peak' | 'lite';
  /** How loud the chord parts play (1 is the part's own level). */
  chordStrength: number;
  /** Whether the style's arpeggio plays on top, and how loud. */
  arp: number | null;
}

const RECIPES: Record<BandKind, BandRecipe> = {
  intro: { drums: null, bass: false, shape: 'lite', chordStrength: 0.8, arp: null },
  verse: { drums: 'light', bass: true, shape: 'groove', chordStrength: 0.85, arp: null },
  build: { drums: 'build', bass: true, shape: 'lite', chordStrength: 0.9, arp: 0.6 },
  chorus: { drums: 'full', bass: true, shape: 'peak', chordStrength: 1, arp: 0.78 },
  chorusFinal: { drums: 'peak', bass: true, shape: 'peak', chordStrength: 1.1, arp: 0.9 },
  break: { drums: null, bass: false, shape: 'lite', chordStrength: 0.75, arp: 0.5 },
};

/** The velocity factor of a section's energy: a quiet section plays 15 % softer than a full one, a loud one a little louder. */
export const energyFactor = (energy: number): number => 0.8 + 0.05 * energy;

/** Scales every velocity of a track (the kick keeps its strength: it is the pulse the rest is heard against). */
export function scaleVelocities(track: BeatTrack, factor: number): void {
  if (track.sound === 'kick') return;
  for (const note of track.notes) note.vel = Math.round(Math.max(0.05, Math.min(1, (note.vel ?? 0.8) * factor)) * 1000) / 1000;
}

/** The steps the kick hits in a set of drum tracks, once each, in order. */
function kickStepsOf(drums: readonly BeatTrack[]): number[] {
  const kick = drums.find((track) => track.sound === 'kick');
  return [...new Set((kick?.notes ?? []).map((note: BeatNote) => note.step))].sort((a, b) => a - b);
}

/** The shape a chord part plays in a recipe. */
const shapeFor = (part: StyleProfile['chordParts'][number], recipe: BandRecipe): CompShape => part[recipe.shape];

/** Whether the band has the style's arpeggio: the dance styles always, the others only in the biggest chorus. */
function hasArp(input: BandInput, recipe: BandRecipe): boolean {
  if (recipe.arp === null || input.profile.colour === 'none') return false;
  return input.profile.colour === 'arp' || input.kind === 'chorusFinal';
}

/** The tracks of one band. */
export function makeBand(input: BandInput): BeatTrack[] {
  const { kind, request, profile, chords, energy } = input;
  const recipe = RECIPES[kind];
  const tracks: BeatTrack[] = [];
  const drums = recipe.drums
    ? songDrums({ style: request.style, tier: recipe.drums, seed: request.seed, label: kind, density: request.density, noHats: request.noHats })
    : [];
  tracks.push(...drums);
  if (recipe.bass) {
    tracks.push(
      ...songBass({
        rule: profile.bass,
        chords,
        kickSteps: kickStepsOf(drums),
        seed: request.seed,
        label: kind,
        energy,
        style: request.style,
        profile,
      }),
    );
  }
  for (const part of profile.chordParts) tracks.push(chordPartTrack(part, shapeFor(part, recipe), chords, recipe.chordStrength));
  if (hasArp(input, recipe)) {
    const arp = songArp(chords, profile, request.seed, recipe.arp ?? 0.7);
    tracks.push({ name: 'Arp', sound: profile.arp.sound, notes: arp });
  }
  if (kind === 'intro') {
    const teaser = songMelody({ plan: 'teaser', key: request.key, chords, profile, motifs: input.motifs, seed: request.seed, energy });
    tracks.push({ name: 'Lead', sound: profile.lead.sound, notes: teaser });
  }
  const factor = energyFactor(energy);
  for (const track of tracks) scaleVelocities(track, factor);
  return tracks;
}
