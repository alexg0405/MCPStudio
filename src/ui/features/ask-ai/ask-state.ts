/**
 * The Ask AI card ("Ask AI about this part"): which part it asks about, what it sits next to, and
 * which of the AI studio's messages are its replies. The entry points (the playlist's ✦ pill, a
 * marker's ✦, menus, Alt+A) open it through these functions.
 */
import { createStore } from 'zustand/vanilla';
import { loopToNextMarker } from '@app/actions/markers';
import type { AiFocus } from '@app/ai/focus';
import { focusFromClips, focusFromMarker, focusFromNotes, focusFromPlaylist, focusFromRange } from '@app/ai/focus-capture';
import type { Services } from '@app/services';
import type { ChannelId, ClipId, MarkerId, NoteId, PatternId } from '@core/model/types';
import { revealAnchor, type AskAnchor } from './anchors';

export interface AskState {
  open: boolean;
  /** The part the card asks about (null: the whole song). */
  focus: AiFocus | null;
  anchor: AskAnchor | null;
  /** AI studio messages after this id are the card's own conversation. */
  since: number;
}

export const askStore = createStore<AskState>(() => ({ open: false, focus: null, anchor: null, since: 0 }));

/** Opens the card for a part, next to `anchor`. */
export function openAsk(s: Services, focus: AiFocus | null, anchor: AskAnchor | null): void {
  const last = s.assistant.store.getState().messages.at(-1);
  if (anchor) revealAnchor(anchor);
  askStore.setState({ open: true, focus, anchor, since: last?.id ?? 0 });
}

export function closeAsk(): void {
  if (askStore.getState().open) askStore.setState({ open: false });
}

/** The card's part changed (cleared with ×, or the answer gave it a copy of a pattern). */
export function setAskFocus(focus: AiFocus | null): void {
  askStore.setState({ focus });
}

const focusedType = (s: Services): string | null => {
  const v = s.view.getState();
  return v.focusedId ? (v.windows[v.focusedId]?.type ?? null) : null;
};

/**
 * The selection the musician means: in the piano roll its notes, else the playlist's selected clips
 * or its loop region. Says what to select first when there is nothing.
 */
export function askAboutSelection(s: Services, anchor?: AskAnchor | null): boolean {
  if (focusedType(s) === 'piano-roll') return askAboutNotes(s, undefined, anchor);
  const focus = focusFromPlaylist(s);
  if (!focus) {
    s.session
      .getState()
      .toast('Select some clips in the playlist, or drag on its ruler to loop some bars; then ✦ Ask AI (Alt+A) changes just that part.');
    return false;
  }
  openAsk(s, focus, anchor ?? { kind: 'pill' });
  return true;
}

/** A marker's whole section: it loops, and the card opens on its flag. */
export function askAboutMarker(s: Services, markerId: MarkerId, anchor?: AskAnchor | null): boolean {
  const focus = focusFromMarker(s, markerId);
  if (!focus) {
    s.session.getState().toast('That marker is no longer on the ruler.', 'error');
    return false;
  }
  loopToNextMarker(s, markerId);
  openAsk(s, focus, anchor ?? { kind: 'marker', markerId });
  return true;
}

/** Bars of the song (a marker section when they match one exactly). */
export function askAboutRange(s: Services, from: number, to: number, anchor?: AskAnchor | null): boolean {
  const focus = focusFromRange(s, from, to);
  if (!focus) return false;
  openAsk(s, focus, anchor ?? { kind: 'span', from, to });
  return true;
}

/** Some playlist clips. */
export function askAboutClips(s: Services, clipIds: readonly ClipId[], anchor?: AskAnchor | null): boolean {
  const focus = focusFromClips(s, clipIds);
  if (!focus) return false;
  openAsk(s, focus, anchor ?? { kind: 'pill' });
  return true;
}

/** Notes of one channel in a pattern (default: the piano roll's selection, or all its notes). */
export function askAboutNotes(
  s: Services,
  at?: { patternId: PatternId; channelId: ChannelId; noteIds?: readonly NoteId[] },
  anchor?: AskAnchor | null,
): boolean {
  const focus = focusFromNotes(s, at);
  if (!focus) {
    s.session.getState().toast('Select some notes in the piano roll first (or draw a few), then ask the AI about them.');
    return false;
  }
  openAsk(s, focus, anchor ?? { kind: 'element', selector: '[data-window-type="piano-roll"]' });
  return true;
}
