/**
 * The Pitch editor's keyboard cursor. Its notes are blobs found in a recording, not cells of a grid, so the cursor sits
 * on a note: Left and Right go to the previous and next note, Up and Down retune the selected notes (Alt: by cents,
 * Ctrl: by an octave), Enter selects, Delete puts notes back as sung, S splits the note and M joins it with the next.
 * The keys are the shared ones of `timeline/key-cursor/keys.ts`, read for notes.
 */
import { audioClipOf, mergeAt, moveNotes, resetNotes, splitAt } from '@app/actions/pitch';
import { pitchState, type ClipPitch } from '@app/pitch/state';
import type { Services } from '@app/services';
import { plural } from '../../timeline/key-cursor/describe';
import type { CursorBox } from '../../timeline/key-cursor/draw';
import { revealRow, revealTicks } from '../../timeline/key-cursor/grid-math';
import { decodeKey, type KeyIntent } from '../../timeline/key-cursor/keys';
import { KeyStack } from '../../timeline/key-cursor/stack';
import type { Viewport } from '../../timeline/viewport';
import { noteSentence, spokenPitch, spokenTime } from './keyboard-text';
import { rowForKey, type DrawNote } from './model';
import { noteBlobBox } from './pitch-draw';

/** Ctrl or Cmd with Left and Right, and PageUp and PageDown, skip this many notes. */
const NOTES_PER_JUMP = 5;
/** Alt with Up or Down retunes by one cent (0.01 of a semitone), as it always has. */
const CENT = 0.01;
const SEMITONES_PER_OCTAVE = 12;
/** Pressed while a retune repeats: the repeats share one undo step. */
const RETUNE_MERGE_KEY = 'keyboard-retune';

const HELP = 'Left and Right go from note to note, Up and Down retune the selected notes, Enter selects, Delete puts them back as sung, S splits, M joins. Question mark says where you are.';
const NO_NOTES = 'There are no notes to work on yet.';

/** What the keyboard needs from the editor that owns it. */
export interface PitchKeyboardHost {
  readonly services: Services;
  readonly viewport: Viewport;
  /** The element that has the keyboard focus (the editor's area). */
  readonly element: HTMLElement;
  /** The notes as drawn now, and the clip they belong to (null when none is open). */
  notes(): readonly DrawNote[];
  clip(): ClipPitch | null;
  /** The lyric word written under each note, by note index (empty without lyrics). */
  words(): ReadonlyMap<number, string>;
  /** How far the view scrolls (ms). */
  maxMs(): number;
  setSelected(indices: number[]): void;
  /** A pointer drag is going on: the keys leave it alone. */
  isDragging(): boolean;
  /** Everything may have changed on screen (the view scrolled, the cursor moved): draw again. */
  redraw(): void;
}

/** The note cursor of the Pitch editor; the controller creates one and calls `attach()`. */
export class PitchKeyboard {
  /** Whether the editor has the keyboard focus (the cursor is drawn and the keys are its). */
  isActive = false;
  private index = 0;
  private anchor: number | null = null;
  private stack: KeyStack | null = null;

  constructor(private readonly host: PitchKeyboardHost) {}

  /** Makes the editor's area a keyboard stop with a cursor. Returns how to undo it. */
  attach(): () => void {
    const stack: KeyStack = new KeyStack(this.host.services, this.host.element, {
      label: 'Pitch editor notes',
      help: HELP,
      onKeyDown: (event) => this.onKeyDown(event),
      onActiveChange: (isActive) => {
        this.isActive = isActive;
        if (isActive) this.onFocus();
        this.host.redraw();
      },
    });
    this.stack = stack;
    this.refreshSummary();
    return () => {
      stack.dispose();
      this.stack = null;
    };
  }

  /** The notes or the selection changed: keep the cursor on a note that exists and describe the editor again. */
  dataChanged(): void {
    const count = this.host.notes().length;
    this.index = Math.max(0, Math.min(this.index, count - 1));
    this.refreshSummary();
  }

  /** The box the cursor is drawn around (the note it is on), or null while the keyboard is elsewhere. */
  cursorBox(): CursorBox | null {
    const note = this.host.notes()[this.index];
    return this.isActive && note ? noteBlobBox(this.host.viewport, note) : null;
  }

  private onFocus(): void {
    const selected = pitchState.getState().selected;
    const first = selected[0];
    if (first !== undefined && first < this.host.notes().length) this.index = first;
    this.reveal();
    this.refreshSummary();
  }

  private currentNote(): DrawNote | undefined {
    return this.host.notes()[this.index];
  }

  private describeNote(index: number): string {
    const note = this.host.notes()[index];
    if (!note) return NO_NOTES;
    const isSelected = pitchState.getState().selected.includes(index);
    return noteSentence(note, this.host.notes().length, { isSelected, word: this.host.words().get(index) });
  }

  /** The text a screen reader reads as the editor's description. */
  private summary(): string {
    const state = pitchState.getState();
    const clip = this.host.clip();
    if (!clip) return state.phase === 'analyzing' ? 'The pitch editor is listening to the clip to find its notes.' : state.message || 'No clip is open. Select an audio clip in the playlist and open the pitch editor from its menu.';
    const notes = this.host.notes();
    if (notes.length === 0) return 'No sung notes were found in this clip.';
    const found = audioClipOf(this.host.services.doc.getState().project, clip.clipId);
    const name = found?.clip.name ?? found?.channel.name ?? 'the clip';
    const note = notes[this.index];
    const place = note ? ` Cursor on note ${this.index + 1}: ${spokenPitch(note.target)} at ${spokenTime(note.fromMs)}.` : '';
    return `Pitch editor for ${name}: ${plural(notes.length, 'note')}, ${state.selected.length} selected.${place}`;
  }

  private refreshSummary(): void {
    this.stack?.setSummary(this.summary());
  }

  /** Scrolls, in one jump, so the cursor note is on screen. */
  private reveal(): void {
    const note = this.currentNote();
    const vp = this.host.viewport;
    if (!note) return;
    const movedSideways = revealTicks(vp, note.fromMs, note.toMs, this.host.maxMs());
    const movedUp = revealRow(vp, rowForKey(Math.round(note.target)));
    if (movedSideways || movedUp) this.host.redraw();
  }

  private say(text: string): void {
    this.stack?.say(text);
  }

  private onKeyDown(event: KeyboardEvent): boolean {
    if (this.host.isDragging()) return false;
    const isPlainLetter = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (isPlainLetter && event.code === 'KeyS') return this.splitCursorNote();
    if (isPlainLetter && event.code === 'KeyM') return this.joinCursorNote();
    const intent = decodeKey(event);
    if (!intent) return false;
    if (intent.kind === 'describe') {
      this.stack?.sayNow(`${this.summary()} Under the cursor: ${this.describeNote(this.index)}. ${HELP}`);
      return true;
    }
    if (!this.host.clip() || this.host.notes().length === 0) {
      this.say(this.summary());
      return true;
    }
    const sentence = this.run(intent);
    if (sentence === null) return false;
    this.say(sentence);
    this.host.redraw();
    return true;
  }

  /** What to say for the key, or null when it is not used (Escape with nothing selected goes on to the app). */
  private run(intent: KeyIntent): string | null {
    switch (intent.kind) {
      case 'move':
        return intent.rows !== 0 ? this.retune(this.rowsToSemitones(intent.rows, intent.isJump)) : this.goTo(this.index + intent.columns * (intent.isJump ? NOTES_PER_JUMP : 1), intent.isExtend);
      case 'page':
        return this.goTo(this.index + intent.direction * NOTES_PER_JUMP, intent.isExtend);
      case 'edge':
        return this.goTo(intent.edge === 'start' ? 0 : this.host.notes().length - 1, intent.isExtend);
      case 'toggle':
        return this.toggleSelected();
      case 'delete':
        return this.putBackAsSung();
      case 'selectAll':
        this.host.setSelected(this.host.notes().map((note) => note.index));
        return `Selected all ${plural(this.host.notes().length, 'note')}`;
      case 'clear':
        return this.clearSelection();
      case 'shift':
        return intent.rows === 0 ? 'Notes keep their place in time: only their pitch changes.' : this.retune(intent.isJump ? this.rowsToSemitones(intent.rows, true) : -intent.rows * CENT);
      case 'insert':
        return 'This editor works on the notes found in the recording, so none can be added. S splits a note in two.';
      case 'resize':
      case 'adjust':
        return 'S splits the note at the cursor and M joins it with the next one.';
      default:
        return null;
    }
  }

  /** Up is higher: rows count down the screen, so -1 row is +1 semitone (an octave with Ctrl). */
  private rowsToSemitones(rows: -1 | 0 | 1, isJump: boolean): number {
    return -rows * (isJump ? SEMITONES_PER_OCTAVE : 1);
  }

  private goTo(wanted: number, isExtend: boolean): string {
    const count = this.host.notes().length;
    const next = Math.max(0, Math.min(count - 1, wanted));
    if (isExtend && this.anchor === null) this.anchor = this.index;
    if (!isExtend) this.anchor = null;
    this.index = next;
    if (isExtend && this.anchor !== null) this.selectRange(this.anchor, next);
    this.reveal();
    this.refreshSummary();
    const sentence = this.describeNote(next);
    return isExtend ? `${sentence}. ${plural(pitchState.getState().selected.length, 'note')} selected` : sentence;
  }

  private selectRange(from: number, to: number): void {
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    this.host.setSelected(Array.from({ length: high - low + 1 }, (_, i) => low + i));
  }

  private toggleSelected(): string {
    this.anchor = null;
    const selected = pitchState.getState().selected;
    const next = selected.includes(this.index) ? selected.filter((i) => i !== this.index) : [...selected, this.index].sort((a, b) => a - b);
    this.host.setSelected(next);
    return this.describeNote(this.index);
  }

  private clearSelection(): string | null {
    this.anchor = null;
    if (pitchState.getState().selected.length === 0) return null;
    this.host.setSelected([]);
    return 'Selection cleared';
  }

  /** The notes a change applies to: the selection, or the note under the cursor (which becomes the selection). */
  private notesToChange(): number[] {
    const selected = pitchState.getState().selected;
    if (selected.length > 0) return selected;
    this.host.setSelected([this.index]);
    return [this.index];
  }

  private retune(semitones: number): string {
    const clip = this.host.clip();
    if (!clip) return NO_NOTES;
    this.anchor = null;
    const indices = this.notesToChange();
    moveNotes(this.host.services, clip, indices, semitones, undefined, `${RETUNE_MERGE_KEY}:${clip.clipId}`);
    const note = this.currentNote();
    return `Retuned ${plural(indices.length, 'note')}. ${note ? this.describeNote(this.index) : ''}`.trim();
  }

  private putBackAsSung(): string {
    const clip = this.host.clip();
    if (!clip) return NO_NOTES;
    const indices = this.notesToChange();
    resetNotes(this.host.services, clip, new Set(indices));
    return `Put ${plural(indices.length, 'note')} back as sung. ${this.describeNote(this.index)}`;
  }

  private splitCursorNote(): boolean {
    const clip = this.host.clip();
    const note = this.currentNote();
    if (!clip || !note) return false;
    const middleSeconds = (note.fromMs + note.toMs) / 2000;
    const didSplit = splitAt(this.host.services, clip, middleSeconds);
    this.say(didSplit ? `Split into two notes. ${plural(this.host.notes().length, 'note')} now` : 'This note is too short to split.');
    this.host.redraw();
    return true;
  }

  private joinCursorNote(): boolean {
    const clip = this.host.clip();
    if (!clip || !this.currentNote()) return false;
    const didJoin = mergeAt(this.host.services, clip, this.index);
    this.say(didJoin ? `Joined with the next note. ${this.describeNote(this.index)}` : 'There is no next note to join with.');
    this.host.redraw();
    return true;
  }
}
