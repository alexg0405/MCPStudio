/** Renaming a marker right on its flag. */
import { renameMarkerTo } from '@app/actions/markers';
import type { MarkerId } from '@core/model/types';
import { HEADER_WIDTH, MARKER_LANE_Y, RULER_HEIGHT } from '../layout';
import type { PlaylistContext } from './context';
import { currentProject } from './lanes';
import { editInline } from './inline-field';
import { markerBoxInView } from './marker-hit';

/** The rename field is at least this wide (px), even over a narrow flag. */
const MIN_FIELD_WIDTH = 120;
/** The field starts this far (px) in from the flag's left edge, over its name. */
const FIELD_INSET = 3;

/** Shows the inline rename field on a marker's flag. */
export function renameMarker(ctx: PlaylistContext, id: MarkerId): void {
  const marker = currentProject(ctx).playlist.markers[id];
  const box = markerBoxInView(ctx, id);
  if (!marker) return;
  const { vp } = ctx;
  const input = ctx.els.markerRename;
  const left = box ? box.x0 + FIELD_INSET : vp.tickToX(marker.tick);
  input.style.left = `${HEADER_WIDTH + Math.max(0, Math.min(vp.width - MIN_FIELD_WIDTH, left))}px`;
  input.style.top = `${MARKER_LANE_Y}px`;
  input.style.height = `${RULER_HEIGHT - MARKER_LANE_Y - 1}px`;
  input.style.width = `${Math.max(MIN_FIELD_WIDTH, box ? box.x1 - box.x0 : 0)}px`;
  editInline(input, marker.name, (name) => renameMarkerTo(ctx.s, id, name));
}
