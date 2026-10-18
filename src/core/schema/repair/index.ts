/**
 * Project repair: fixes the content of a structurally valid project (see `migrateProject`): dangling
 * references, order arrays, out-of-range values. It never throws on a structurally valid project and
 * reports each kind of fix in plain words.
 *
 * One file per part of the project (mixer, channels, patterns, ...). `repairProject` runs them in a fixed
 * order, which matters twice over: later steps rely on earlier ones (channels read the repaired mixer
 * tracks) and the messages come out in that order.
 */
import type { Project } from '../../model/types';
import type { JsonObject } from '../json-values';
import { repairChannels } from './channels';
import { repairChords } from './chords';
import { repairControllers } from './controllers';
import { repairDj } from './dj';
import { repairLauncher } from './launcher';
import { RepairLog } from './log';
import { repairMixer } from './mixer';
import { repairPatterns } from './patterns';
import { repairPlaylist } from './playlist';
import { repairMeta, repairTransport } from './project-details';
import { repairReference } from './reference';
import { repairSamples } from './samples';

export { CHANNEL_VOLUME_MAX, INSERT_VOLUME_MAX, BPM_MIN, BPM_MAX } from './limits';
export { isParamTarget } from './automation';

/**
 * Returns a repaired deep copy of a structurally valid project (see migrateProject) and one
 * human-readable line per kind of fix. Never mutates the input. A project that needs no repair comes
 * back deep-equal to the input with no messages, and repairing a repaired project changes nothing.
 */
export function repairProject(project: Project): { project: Project; repairs: string[] } {
  const copy = JSON.parse(JSON.stringify(project)) as JsonObject;
  const log = new RepairLog();
  repairMeta(copy, log);
  repairTransport(copy, log);
  repairSamples(copy, log);
  repairMixer(copy, log);
  repairChannels(copy, log);
  repairPatterns(copy, log);
  repairPlaylist(copy, log);
  repairControllers(copy, log);
  repairDj(copy, log);
  repairReference(copy, log);
  repairLauncher(copy, log);
  repairChords(copy, log);
  log.flush();
  return { project: copy as unknown as Project, repairs: log.messages };
}
