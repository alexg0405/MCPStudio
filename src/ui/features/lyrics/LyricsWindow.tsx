import { useEffect, useMemo, useRef, useState } from 'react';
import { clearLyricTrack, copyLyrics, saveLyricsFile } from '@app/lyrics/actions';
import type { Services } from '@app/services';
import { lyricLines } from '@core/query/lyrics';
import { useDoc, useServices } from '../../services-context';
import type { WindowContentProps } from '../../workspace/registry';
import { KaraokeFollow } from './karaoke-follow';
import { pasteLyricsDialog } from './paste-dialog';
import styles from './Lyrics.module.css';

/** The text size (px) the window starts at, the steps of the size buttons and its limits: big enough to read from a few steps back. */
const START_SIZE = 34;
const SIZE_STEP = 4;
const MIN_SIZE = 16;
const MAX_SIZE = 120;
const SIZE_KEY = 'agstudio.lyricsSize';

/** The saved text size (best effort: storage can be missing or blocked). */
function loadSize(): number {
  try {
    const saved = Number(localStorage.getItem(SIZE_KEY));
    return saved >= MIN_SIZE && saved <= MAX_SIZE ? saved : START_SIZE;
  } catch {
    return START_SIZE;
  }
}

function saveSize(size: number): void {
  try {
    localStorage.setItem(SIZE_KEY, String(size));
  } catch {
    // The size is a convenience: not being able to keep it changes nothing else.
  }
}

/** Shows what an action did as a toast. */
function report(services: Services, result: { ok: boolean; message: string }): void {
  services.session.getState().toast(result.message, result.ok ? 'info' : 'error');
}

/** What the window says while there are no lyrics. */
function EmptyState({ onPaste }: { onPaste: () => void }) {
  return (
    <div className={styles.empty}>
      <p>
        <strong>No lyrics yet.</strong> Paste the words of a song and they are spread over your notes or a sung recording, or
        type them one by one on the Lyrics lane above the playlist. This window then follows the song, so you can read along
        while you record a take.
      </p>
      <button className={styles.button} onClick={onPaste} data-hint="Paste or type the words: they are split into words and syllables (beau-ti-ful) and placed on the notes you pick, or evenly">
        Paste lyrics…
      </button>
    </div>
  );
}

/** The Lyrics window: the lyrics as big text that lights up as the song plays (karaoke), with paste and export. */
export function LyricsWindow(_props: WindowContentProps) {
  const services = useServices();
  const lyrics = useDoc((project) => project.lyrics);
  const lines = useMemo(() => lyricLines({ lyrics }), [lyrics]);
  const [size, setSize] = useState(loadSize);
  const [isFollowing, setIsFollowing] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const followRef = useRef(isFollowing);

  useEffect(() => {
    followRef.current = isFollowing;
  }, [isFollowing]);

  useEffect(() => {
    if (!body.current || lines.length === 0) return;
    const follow = new KaraokeFollow(
      services,
      body.current,
      { sung: styles.sung as string, now: styles.now as string, currentLine: styles.currentLine as string },
      () => followRef.current,
    );
    follow.mount();
    return () => follow.unmount();
  }, [services, lines]);

  const resize = (delta: number) => {
    const next = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size + delta));
    setSize(next);
    saveSize(next);
  };
  let wordIndex = 0;
  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <button className={styles.button} onClick={() => void pasteLyricsDialog(services)} data-hint="Paste or type the words of a section and spread them over the notes you pick (or evenly); they replace any lyrics under them">
          Paste lyrics…
        </button>
        <button className={styles.button} disabled={lines.length === 0} onClick={() => report(services, saveLyricsFile(services, 'text'))} data-hint="Save the lyrics as a plain text file, one line per lyric line">
          Save text
        </button>
        <button className={styles.button} disabled={lines.length === 0} onClick={() => report(services, saveLyricsFile(services, 'lrc'))} data-hint="Save the lyrics as an LRC file: each line with the time it is sung, which music players show as karaoke">
          Save LRC
        </button>
        <button className={styles.button} disabled={lines.length === 0} onClick={() => void copyLyrics(services).then((result) => report(services, result))} data-hint="Copy the lyrics as text">
          Copy
        </button>
        <span className={styles.spacer} />
        <label className={styles.check} data-hint="Keep the line being sung in the middle of the window while the song plays">
          <input type="checkbox" checked={isFollowing} onChange={(event) => setIsFollowing(event.target.checked)} />
          Follow
        </label>
        <button className={styles.button} onClick={() => resize(-SIZE_STEP)} aria-label="Smaller text" data-hint="Smaller text">
          A−
        </button>
        <button className={styles.button} onClick={() => resize(SIZE_STEP)} aria-label="Bigger text" data-hint="Bigger text, to read from further away while you record">
          A+
        </button>
        <button className={styles.button} disabled={lines.length === 0} onClick={() => report(services, clearLyricTrack(services))} data-hint="Remove all the lyrics (one undo step)">
          Clear
        </button>
      </div>
      {lines.length === 0 ? (
        <EmptyState onPaste={() => void pasteLyricsDialog(services)} />
      ) : (
        <div ref={body} className={styles.body} style={{ fontSize: size }} data-hint="The lyrics follow the song: the word being sung fills with colour, the words before it are lit">
          {lines.map((line) => (
            <div key={line.index} className={styles.line} data-line={line.index}>
              {line.words.map((word, i) => {
                const index = wordIndex++;
                return (
                  <span key={word.id}>
                    <span className={styles.word} data-w={index} data-l={line.index}>
                      {word.text}
                    </span>
                    {i < line.words.length - 1 && !word.continues ? <span className={styles.gap} /> : null}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
