/**
 * "Ask AI about …" (with the Studio mark) in the right-click menus: a playlist clip (or the selection it belongs to), a
 * marker, the ruler's loop region, the bar of an empty playlist spot and piano-roll notes.
 */
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import { addContextMenuItems } from '../../context-menus';
import { lastPointer } from './anchors';
import { askAboutClips, askAboutMarker, askAboutNotes, askAboutRange } from './ask-state';

export function registerAskMenus(): () => void {
  const offs = [
    addContextMenuItems('playlist.clip', ({ clip }, s) => {
      const sel = s.editor.getState().clipSelection;
      const many = sel.length > 1 && sel.includes(clip.id);
      const at = lastPointer();
      return [
        {
          icon: 'studio',
          label: many ? `Ask Studio about the ${sel.length} selected clips…` : 'Ask Studio about this clip…',
          hint: many
            ? 'Tell Studio what to change in the selected clips: only they change (patterns they share with the rest of the song are copied first)'
            : 'Tell Studio what to change in this clip: only it changes (a pattern it shares with the rest of the song is copied first)',
          onSelect: () => {
            const ids = many ? [...sel] : [clip.id];
            s.editor.getState().selectClips(ids);
            askAboutClips(s, ids, { kind: 'pill', ...(at ? { fallback: at } : {}) });
          },
        },
      ];
    }),
    addContextMenuItems('playlist.marker', ({ markerId }, s) => {
      const m = s.doc.getState().project.playlist.markers[markerId];
      if (!m) return [];
      return [
        {
          icon: 'studio',
          label: `Ask Studio about “${m.name}”…`,
          hint: 'Loops this section and opens a box: tell Studio what to change in it (only this section changes, as one undo step)',
          onSelect: () => void askAboutMarker(s, markerId),
        },
      ];
    }),
    addContextMenuItems('playlist.ruler', (_ctx, s) => {
      const loop = s.view.getState().loop;
      if (!loop) return [];
      const span = barSpan(loop.start, loop.end, s.doc.getState().project.transport.timeSig);
      return [
        {
          icon: 'studio',
          label: `Ask Studio about ${span}…`,
          hint: `Tell Studio what to change in the loop region (${span}); only those bars change`,
          onSelect: () => void askAboutRange(s, loop.start, loop.end),
        },
      ];
    }),
    // A click on an empty spot of the playlist: the bar there.
    addContextMenuItems('playlist.empty', ({ tick }, s) => {
      const bar = ticksPerBar(s.doc.getState().project.transport.timeSig);
      const from = Math.floor(tick / bar) * bar;
      const n = from / bar + 1;
      const at = lastPointer();
      return [
        {
          icon: 'studio',
          label: `Ask Studio about bar ${n}…`,
          hint: `Opens a box: tell Studio what to put or change in bar ${n} (only that bar changes, as one undo step)`,
          onSelect: () =>
            void askAboutRange(s, from, from + bar, {
              kind: 'span',
              from,
              to: from + bar,
              ...(at ? { fallback: at } : {}),
            }),
        },
      ];
    }),
    addContextMenuItems('pianoRoll.note', (ctx, s) => {
      const n = ctx.noteIds.length;
      const at = lastPointer();
      return [
        {
          icon: 'studio',
          label: n === 1 ? 'Ask Studio about this note…' : `Ask Studio about these ${n} notes…`,
          hint: 'Tell Studio what to change in the selected notes (timing, groove, melody…): only they change',
          onSelect: () =>
            void askAboutNotes(
              s,
              { patternId: ctx.patternId, channelId: ctx.channelId, noteIds: ctx.noteIds },
              at ? { kind: 'point', x: at.x, y: at.y } : null,
            ),
        },
      ];
    }),
  ];
  return () => offs.forEach((off) => off());
}
