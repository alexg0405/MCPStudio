/**
 * Karaoke in the Lyrics window: on every animation frame it finds the word being sung and lights it, dims the words
 * before it and keeps the current line in the middle of the window. It works on the elements React drew once (one
 * `data-w` span per word in time order, one `data-line` block per line) and only touches classes and one style property,
 * so playing a song makes no React commits.
 */
import { isReducedMotion } from '../../a11y/preferences';
import { songPosition } from '@app/actions/markers';
import type { Services } from '@app/services';
import { lyricCursor, newCursor } from '@core/lyrics/karaoke';
import { lyricsSorted } from '@core/query/lyrics';
import { onFrame } from '../../frame-loop';

/** The class names the window's stylesheet gives these states (passed in, because CSS modules rename them). */
export interface KaraokeClasses {
  /** Words already sung. */
  sung: string;
  /** The word being sung. */
  now: string;
  /** The line the word being sung is in (or the first line before the song gets there). */
  currentLine: string;
}

/** Lights the words of the Lyrics window as the song plays. */
export class KaraokeFollow {
  private readonly cursor = newCursor();
  private words: HTMLElement[] = [];
  private lines: HTMLElement[] = [];
  /** The line each word is in (index into `lines`). */
  private lineOfWord: number[] = [];
  private lastWord = -2;
  private lastLine = -1;
  private lastPercent = -1;
  private stop: (() => void) | null = null;

  constructor(
    private readonly s: Services,
    private readonly root: HTMLElement,
    private readonly classes: KaraokeClasses,
    private readonly isFollowing: () => boolean,
  ) {}

  /** Finds the words React drew and starts following the song. */
  mount(): void {
    this.words = [...this.root.querySelectorAll<HTMLElement>('[data-w]')];
    this.lines = [...this.root.querySelectorAll<HTMLElement>('[data-line]')];
    this.lineOfWord = this.words.map((word) => Number(word.dataset.l ?? 0));
    this.lastWord = -2;
    this.lastLine = -1;
    this.lastPercent = -1;
    this.stop = onFrame(() => this.frame());
  }

  unmount(): void {
    this.stop?.();
    this.stop = null;
  }

  private frame(): void {
    const sorted = lyricsSorted(this.s.doc.getState().project);
    if (sorted.length === 0 || sorted.length !== this.words.length) return;
    lyricCursor(sorted, songPosition(this.s), this.cursor);
    if (this.cursor.word !== this.lastWord) this.moveTo(this.cursor.word);
    this.showProgress();
  }

  /** The song reached another word (or jumped): the classes are set again for every word. */
  private moveTo(word: number): void {
    const { sung, now, currentLine } = this.classes;
    const wasWord = this.lastWord;
    this.lastWord = word;
    this.lastPercent = -1;
    // Only the words between the old and the new position change on a normal step; a jump changes them all.
    const from = wasWord >= 0 && Math.abs(word - wasWord) <= 1 ? Math.min(word, wasWord) : 0;
    const to = wasWord >= 0 && Math.abs(word - wasWord) <= 1 ? Math.max(word, wasWord) : this.words.length - 1;
    for (let i = from; i <= to; i++) {
      const el = this.words[i] as HTMLElement;
      el.classList.toggle(sung, i < word);
      el.classList.toggle(now, i === word);
      if (i !== word) el.style.removeProperty('--progress');
    }
    const line = this.lineOfWord[Math.max(0, word)] ?? 0;
    if (line !== this.lastLine) this.moveToLine(line, currentLine);
  }

  private moveToLine(line: number, currentLine: string): void {
    this.lines[this.lastLine]?.classList.remove(currentLine);
    this.lastLine = line;
    const el = this.lines[line];
    if (!el) return;
    el.classList.add(currentLine);
    if (!this.isFollowing()) return;
    const top = el.offsetTop - this.root.clientHeight / 2 + el.clientHeight / 2;
    this.root.scrollTo({ top: Math.max(0, top), behavior: isReducedMotion() ? 'auto' : 'smooth' });
  }

  /** How far through the lit word the song is, as a percentage the stylesheet paints the word with (steps of 2 %). */
  private showProgress(): void {
    if (this.cursor.word < 0) return;
    const percent = Math.round(this.cursor.progress * 50) * 2;
    if (percent === this.lastPercent) return;
    this.lastPercent = percent;
    this.words[this.cursor.word]?.style.setProperty('--progress', `${percent}%`);
  }
}
