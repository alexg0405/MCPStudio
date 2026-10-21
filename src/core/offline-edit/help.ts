/**
 * What the offline editor can do, in the words the musician sees: the help reply, the answer to a request it cannot read, and the
 * ideas Studio offers once a song exists. One list feeds all three, so they cannot drift apart.
 */

/** One kind of change the offline editor makes, with phrasings that work. */
export interface OfflineAbility {
  title: string;
  examples: readonly string[];
}

/** Every kind of change, in the order the help lists them. */
export const OFFLINE_ABILITIES: readonly OfflineAbility[] = [
  { title: 'Drums', examples: ['busier hats in the chorus', 'simpler drums', 'no hats in bars 9–16', 'add a fill at the end of bar 8', 'make the kick and snare hit harder'] },
  { title: 'Melody', examples: ['write a new melody for the hook', 'a different hook for the last chorus'] },
  { title: 'Chords', examples: ['change the chords in bars 9–16', 'darker chords', 'use seventh chords'] },
  { title: 'Key, tempo and swing', examples: ['transpose up 2 semitones', 'change the key to F minor', 'tempo 128', 'a bit faster', 'more swing'] },
  { title: 'Song parts', examples: ['add a breakdown before the last chorus', 'add a build into the drop', 'add an outro'] },
  { title: 'Variation and transitions', examples: ['more variation', 'smoother transitions', 'add a riser into the chorus'] },
  { title: 'Vocals', examples: ['add harmonies to the vocal', 'clean up the vocal'] },
  { title: 'Mix', examples: ['turn the lead up 3 dB', 'quieter drums', 'more reverb on the vocals', 'make the pads wider', 'mute the hats', 'level the mix'] },
  { title: 'Style', examples: ['make it sound like house'] },
];

/** The part of the song a request can be limited to. */
const PART_TIP =
  'Name a part to change only that: "in the chorus", "in bars 9–16", "the last verse". Or pick a part in the playlist and ask about it.';

/** What Studio answers to "help": everything the offline editor can do, with examples. */
export function offlineHelpText(): string {
  const lines = OFFLINE_ABILITIES.map((ability) => `${ability.title}: ${ability.examples.map((example) => `“${example}”`).join(', ')}`);
  return `Without an AI I can change the song you have, one thing at a time. ${lines.join(' · ')}. ${PART_TIP} For anything else, connect an AI (Studio's ⋯ menu).`;
}

/** The answer to words the offline editor cannot read. */
export function unknownRequestReply(): string {
  const examples = ['busier hats in the chorus', 'a new melody for the hook', 'change the chords in bars 9–16', 'transpose up 2 semitones', 'add a breakdown', 'turn the lead up 3 dB'];
  return `I did not understand that as a change I can make offline. I can do things like ${examples.map((example) => `“${example}”`).join(', ')} (say “help” for the whole list). For anything else, connect an AI in Studio's ⋯ menu.`;
}

/** The ideas Studio offers once a song exists and no AI answers: each one works with the offline editor. */
export const OFFLINE_SONG_IDEAS: readonly string[] = [
  'Busier hats in the chorus',
  'Write a new melody for the hook',
  'Change the chords',
  'Add a breakdown before the last chorus',
  'Smoother transitions',
  'Make the kick and snare hit harder',
];
