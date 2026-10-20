/**
 * Read tools for save points and your projects: the versions of the open project (what each changed, whether it is kept
 * forever, how much they take) and the list of projects AGstudio remembers. Both read what the app last read from
 * storage; over MCP `prepare` reads it again first, so the answer is current.
 */
import { formatSize } from '@core/gc/format';
import { filterProjects, sortProjects, type ListedProject } from '@core/projects/list';
import { formatAgo } from '@core/versions/time';
import { versionTitle } from '@core/versions/types';
import * as S from '../schema/parts';
import { num, str } from '../ops/values';
import { round2, tool, type ReadTool } from './tool';

/** Versions listed by default, and the most one reply lists. */
const DEFAULT_VERSIONS = 20;
const MAX_VERSIONS = 60;
const DEFAULT_PROJECTS = 20;
const MAX_PROJECTS = 60;

const clampCount = (value: unknown, fallback: number, max: number) => Math.min(max, Math.max(1, Math.round(num(value) ?? fallback)));

export const getVersions: ReadTool = {
  ...tool(
    'get_versions',
    'The saved versions (save points) of the open project, newest first: id, name or reason, when, whether it is kept forever, what changed since the version before it, and its size; plus whether save points are made automatically and how much storage they use. Restore one with the versions.restore command, save one with versions.save.',
    {
      limit: S.int(`Most versions listed (default ${DEFAULT_VERSIONS}, at most ${MAX_VERSIONS}).`),
      name: S.str('Only versions whose name or reason contains this.'),
    },
    (services, args) => {
      const now = Date.now();
      const wanted = str(args.name)?.toLowerCase();
      const all = services.versions.openProjectVersions();
      const matching = wanted ? all.filter((record) => versionTitle(record).toLowerCase().includes(wanted)) : all;
      const settings = services.versions.settings.getState();
      const versions = matching.slice(0, clampCount(args.limit, DEFAULT_VERSIONS, MAX_VERSIONS)).map((record) => ({
        id: record.id,
        title: versionTitle(record),
        ...(record.name ? { name: record.name } : {}),
        reason: record.reason,
        saved: new Date(record.createdAt).toISOString(),
        ago: formatAgo(record.createdAt, now),
        kept_forever: record.pinned,
        changes: record.summary,
        size: formatSize(record.size),
        bars: record.facts.bars,
        bpm: record.facts.bpm,
      }));
      return {
        versions,
        total: all.length,
        ...(matching.length !== all.length ? { matching: matching.length } : {}),
        automatic: settings.isAutomatic ? { every_minutes: settings.everyMinutes } : false,
        storage: { versions: all.length, size_mb: round2(all.reduce((sum, record) => sum + record.size, 0) / 1_048_576) },
        ...(!services.versions.isAvailable ? { note: 'This browser cannot keep versions (no private storage).' } : {}),
        ...(services.versions.isAvailable && all.length === 0
          ? { note: 'No versions yet: they are made on save, after minutes of editing and before big changes; versions.save makes one now.' }
          : {}),
      };
    },
  ),
  prepare: (services) => services.versions.refresh(),
};

/** One listed project as plain JSON. */
function projectJson(item: ListedProject, now: number) {
  const facts = item.facts;
  return {
    name: item.name,
    ...(item.isOpen ? { open: true } : {}),
    kept_as: item.source === 'file' ? 'file' : item.source === 'autosave' ? 'autosave (unsaved work)' : 'versions only',
    last_opened: new Date(item.lastOpenedAt).toISOString(),
    ago: formatAgo(item.lastOpenedAt, now),
    ...(facts ? { bpm: facts.bpm, key: facts.key, bars: facts.bars, length_sec: facts.lengthSec } : {}),
    versions: item.versionCount,
    ...(item.pinned ? { pinned: true } : {}),
    ...(item.hasUnsavedWork ? { unsaved_changes: true } : {}),
  };
}

export const getRecentProjects: ReadTool = {
  ...tool(
    'get_recent_projects',
    'The projects AGstudio remembers (files, autosaved work, projects that only have versions), most recently opened first, with tempo, key, length, how many versions each has and whether it is pinned. Open one with the projects.open command (by name).',
    {
      limit: S.int(`Most projects listed (default ${DEFAULT_PROJECTS}, at most ${MAX_PROJECTS}).`),
      query: S.str('Only projects matching these words (name, key like "A minor", tempo like "128 bpm").'),
    },
    (services, args) => {
      const now = Date.now();
      const all = services.projects.view.getState().items;
      const found = sortProjects(filterProjects(all, str(args.query) ?? ''), 'recent');
      return {
        projects: found.slice(0, clampCount(args.limit, DEFAULT_PROJECTS, MAX_PROJECTS)).map((item) => projectJson(item, now)),
        total: all.length,
        ...(all.length === 0 ? { note: 'No projects remembered yet: save one with the file.save command and it is listed here.' } : {}),
      };
    },
  ),
  prepare: (services) => services.projects.refresh(),
};
