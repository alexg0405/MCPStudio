/**
 * Songs longer than this are not decoded whole when their file can be read by parts (WAV, MP3): a deck holds a window of
 * them around the play position (`engine/deck/deck-stream.ts`), and their analysis is made from chunks as the file is read
 * (`app/dj/analysis-stream.ts`), so a 2-hour mix needs no more memory than a 5-minute song.
 */
export const LONG_SONG_SEC = 12 * 60;

/**
 * Files that can't be read by parts (AAC in M4A, Ogg, FLAC, AIFF) are decoded whole, once: the browser makes the whole
 * song as floats (a 45-minute song at 48 kHz is 1 GB), so longer ones are refused (by the decks and the analysis) instead
 * of taking the tab down.
 */
export const MAX_WHOLE_DECODE_SEC = 45 * 60;
