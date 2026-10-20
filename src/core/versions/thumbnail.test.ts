import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { makeLane } from '../model/defaults';
import { newId } from '../model/ids';
import { emptySong, songWithClips, withClip } from './test-songs';
import { arrangementThumbnail, isThumbnail, THUMBNAIL_MAX_ROWS, thumbnailRects } from './thumbnail';

describe('arrangementThumbnail', () => {
  it('has no rows for an empty playlist', () => {
    expect(arrangementThumbnail(emptySong())).toEqual({ v: 1, columns: 96, rows: [] });
  });

  it('marks where clips play, merging clips that touch', () => {
    const song = songWithClips(4); // bars 1-4 on track 1, one clip each
    const thumbnail = arrangementThumbnail(song, 8);
    expect(thumbnail.rows).toHaveLength(1);
    // The song is 4 bars long, so 8 columns are 2 per bar and the clips fill all of it as one span.
    expect(thumbnail.rows[0]!.spans).toEqual([0, 8]);
  });

  it('shows a gap where nothing plays, on the track it belongs to', () => {
    let song = emptySong();
    const patternId = song.patternOrder[0]!;
    song = withClip(song, patternId, 0, 1);
    song = withClip(song, patternId, 3, 1);
    const [row] = arrangementThumbnail(song, 8).rows;
    expect(row!.spans).toEqual([0, 2, 6, 8]);
  });

  it('keeps tracks in playlist order and skips empty ones', () => {
    let song = emptySong();
    const patternId = song.patternOrder[0]!;
    song = produce(song, (draft) => {
      draft.playlist.lanes[draft.playlist.laneOrder[2]!]!.color = '#ff0000';
    });
    song = withClip(song, patternId, 0, 2);
    song = produce(song, (draft) => {
      const laneId = draft.playlist.laneOrder[2]!;
      const id = newId.clip();
      draft.playlist.clips[id] = { kind: 'pattern', id, laneId, patternId, start: 0, length: 3840, offset: 0 };
    });
    const { rows } = arrangementThumbnail(song, 4);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.color).toBe('#ff0000');
    expect(rows[0]!.spans).toEqual([0, 4]);
    expect(rows[1]!.spans).toEqual([0, 2]);
  });

  it('keeps the busiest tracks when there are more than fit', () => {
    let song = emptySong();
    const patternId = song.patternOrder[0]!;
    song = produce(song, (draft) => {
      for (let i = 0; i < 20; i++) {
        const lane = makeLane(`Extra ${i}`);
        draft.playlist.lanes[lane.id] = lane;
        draft.playlist.laneOrder.push(lane.id);
      }
    });
    song = produce(song, (draft) => {
      draft.playlist.laneOrder.forEach((laneId, index) => {
        const id = newId.clip();
        // Later tracks are busier: they play for more bars.
        draft.playlist.clips[id] = { kind: 'pattern', id, laneId, patternId, start: 0, length: (1 + index) * 3840, offset: 0 };
      });
    });
    const thumbnail = arrangementThumbnail(song, 32);
    expect(thumbnail.rows).toHaveLength(THUMBNAIL_MAX_ROWS);
    expect(isThumbnail(thumbnail)).toBe(true);
  });
});

describe('thumbnailRects', () => {
  const gapSong = produce(songWithClips(4), (draft) => {
    // Remove the third clip, leaving a gap in bar 3.
    const third = Object.values(draft.playlist.clips).find((c) => c.start === 2 * 3840)!;
    delete draft.playlist.clips[third.id];
  });
  const thumbnail = arrangementThumbnail(gapSong, 8);

  it('is whole pixels and the same every time', () => {
    const first = thumbnailRects(thumbnail, 120, 40);
    const second = thumbnailRects(structuredClone(thumbnail), 120, 40);
    expect(second).toEqual(first);
    for (const rect of first) {
      for (const value of [rect.x, rect.y, rect.width, rect.height]) expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('draws one mark per span inside the picture', () => {
    const rects = thumbnailRects(thumbnail, 80, 20);
    expect(rects.length).toBe(thumbnail.rows.reduce((n, row) => n + row.spans.length / 2, 0));
    expect(rects.length).toBeGreaterThan(1);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(80);
      expect(rect.y + rect.height).toBeLessThanOrEqual(20);
    }
  });

  it('draws nothing for an empty song or a picture with no room', () => {
    expect(thumbnailRects({ v: 1, columns: 8, rows: [] }, 80, 20)).toEqual([]);
    expect(thumbnailRects(thumbnail, 0, 20)).toEqual([]);
  });
});

describe('isThumbnail', () => {
  it('accepts what arrangementThumbnail makes and refuses damaged data', () => {
    expect(isThumbnail(arrangementThumbnail(songWithClips(2)))).toBe(true);
    expect(isThumbnail({ v: 1, columns: 8, rows: [{ color: null, spans: [0] }] })).toBe(false);
    expect(isThumbnail({ v: 2, columns: 8, rows: [] })).toBe(false);
    expect(isThumbnail(null)).toBe(false);
  });
});
