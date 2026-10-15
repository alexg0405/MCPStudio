/**
 * "Ask AI about …" (with the Studio mark) in the right-click menus: a playlist clip (or the selection it belongs to), a
 * marker, the ruler's loop region and piano-roll notes.
 */
import { barSpan } from '@core/time/bars';
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
          label: many ? `Ask AI about the ${sel.length} selected clips…` : 'Ask AI about this clip…',
          hint: many
            ? 'Tell the AI what to change in the selected clips: only they change (patterns they share with the rest of the song are copied first)'
            : 'Tell the AI what to change in this clip: only it changes (a pattern it shares with the rest of the song is copied first)',
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
          label: `Ask AI about “${m.name}”…`,
          hint: 'Loops this section and opens a box: tell the AI what to change in it (only this section changes, as one undo step)',
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
          label: `Ask AI about ${span}…`,
          hint: `Tell the AI what to change in the loop region (${span}); only those bars change`,
          onSelect: () => void askAboutRange(s, loop.start, loop.end),
        },
      ];
    }),
    addContextMenuItems('pianoRoll.note', (ctx, s) => {
      const n = ctx.noteIds.length;
      const at = lastPointer();
      return [
        {
          icon: 'studio',
          label: n === 1 ? 'Ask AI about this note…' : `Ask AI about these ${n} notes…`,
          hint: 'Tell the AI what to change in the selected notes (timing, groove, melody…): only they change',
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
