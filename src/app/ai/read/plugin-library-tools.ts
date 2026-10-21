/**
 * Read tool for the musician's own plugins (the "My plugins" window): which ones exist, their state, where the song uses
 * them, the gallery of examples, and what is in the trash. Over MCP `prepare` reads the plugins folder first, so the answer
 * is current. Sharing, importing, duplicating and the rest are commands (`plugins.*`), which ask the musician.
 */
import { galleryIds } from '../../plugins/gallery';
import * as S from '../schema/parts';
import { tool, type ReadTool } from './tool';

export const getUserPlugins: ReadTool = {
  ...tool(
    'get_user_plugins',
    'The musician’s own plugins (code in the plugins/ folder): id, name, kind, version, author, whether it loaded, was switched off or failed (with the error), the files it has, and where the open song uses it; plus the plugins that were deleted to the trash (restore with plugins.restore), the ids of the example plugins in the gallery (install one with plugins.import and its id or name, e.g. "Tape Stop") and whether the dev server is there (sharing and installing need it). Share one with plugins.share, import a bundle with plugins.import: the musician is always shown what a plugin can do and says yes before it installs.',
    { plugin: S.str('Only this plugin (id or name).') },
    (services, args) => {
      const up = services.userPlugins;
      const state = up.store.getState();
      const wanted = typeof args.plugin === 'string' ? args.plugin.trim().toLowerCase() : '';
      const mine = up.rows().filter((row) => row.source === 'user' && (!wanted || row.id.toLowerCase() === wanted || row.name.toLowerCase() === wanted));
      if (wanted && mine.length === 0) return { error: `none of your plugins is "${args.plugin as string}"` };
      return {
        dev_server: state.server === 'ok' ? 'available' : state.server === 'missing' ? 'missing: sharing, installing and managing need `agstudio` running' : 'not asked yet',
        plugins: mine.map((row) => ({
          id: row.id,
          name: row.name,
          ...(row.kind ? { kind: row.kind } : {}),
          ...(row.version !== null ? { version: row.version } : {}),
          ...(row.author ? { author: row.author } : {}),
          state: row.state === 'loaded' ? 'working' : row.state === 'disabled' ? 'switched off' : 'did not load',
          ...(row.error ? { error: row.error } : {}),
          ...(row.problems.length > 0 ? { last_check_problems: row.problems } : {}),
          ...(row.folder ? { folder: row.folder } : {}),
          files: row.fileCount,
          used_in: {
            channels: row.usedIn.channels.map((channel) => channel.name),
            mixer_tracks: row.usedIn.inserts.map((insert) => insert.name),
          },
        })),
        ...(wanted
          ? {}
          : {
              trash: up.trashRows().map((row) => ({ id: row.id ?? row.folder, folder: row.folder })),
              gallery: galleryIds().map((id) => ({ id, installed: up.rows().some((row) => row.id === id) })),
            }),
      };
    },
  ),
  prepare: async (services) => {
    await services.userPlugins.refresh().catch(() => {});
  },
};
