/**
 * Songs longer than this are not decoded whole when their file can be read by parts (WAV, MP3): a deck holds a window of
 * them around the play position (`engine/deck/deck-stream.ts`), and their analysis is made from chunks as the file is read
 * (`app/dj/analysis-stream.ts`), so a 2-hour mix needs no more memory than a 5-minute song.
 */
export const LONG_SONG_SEC = 12 * 60;
