import type { Services } from '@app/services';
import { addInstrumentChannel } from '@app/actions/channels';
import { addEffectToSelectedInsert } from '@app/actions/mixer';
import { devServerMissing } from '@app/local-server';
import { createPlugin, openInEditor, pluginSourceFile, type NewPluginKind, type NewPluginStyle } from '@app/plugins/new-plugin';
import { showFormDialog } from '../../controls/FormDialog';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { openWindow } from '../../workspace/registry';

const KINDS: readonly { value: NewPluginKind; label: string }[] = [
  { value: 'instrument', label: 'An instrument (plays notes)' },
  { value: 'effect', label: 'An effect (changes sound on a mixer track)' },
  { value: 'note-script', label: 'A piano-roll tool (changes notes)' },
];

const STYLES: readonly { value: NewPluginStyle; label: string }[] = [
  { value: 'faust', label: 'Faust: a few lines of a language made for DSP (easiest)' },
  { value: 'graph', label: 'Web Audio nodes: oscillators, filters, gains in TypeScript' },
  { value: 'worklet', label: 'Worklet: your own sample-by-sample DSP in TypeScript' },
];

/** Waits (up to `ms`) for hot reload to bring a new plugin into the registry. */
function whenRegistered(s: Services, id: string, ms = 15000): Promise<boolean> {
  if (s.plugins.get(id) || s.plugins.script(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, ms);
    const off = s.plugins.subscribe(() => {
      if (!s.plugins.get(id) && !s.plugins.script(id)) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/**
 * Making your own plugins without leaving the app: Add → New plugin… writes one from a template
 * into plugins/ (it hot-reloads into the browser and the project), and "Edit code" opens a user
 * plugin's file in your code editor.
 */
export function register(services: Services): void {
  const { commands } = services;
  commands.register<unknown>({
    id: 'plugins.new',
    title: 'New plugin…',
    category: 'Plugins',
    hint: 'Start your own instrument, effect or piano-roll tool from a template: it appears right away and opens in your code editor',
    argsHint: "{ name, kind: 'instrument' | 'effect' | 'note-script', style: 'faust' | 'graph' | 'worklet' }",
    run: async (s, args) => {
      const toast = s.session.getState().toast;
      const given = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
      let spec = given
        ? {
            name: String(given.name ?? 'My plugin'),
            kind: (['instrument', 'effect', 'note-script'].includes(String(given.kind)) ? given.kind : 'instrument') as NewPluginKind,
            style: (['faust', 'graph', 'worklet'].includes(String(given.style)) ? given.style : 'faust') as NewPluginStyle,
          }
        : null;
      let edit = true;
      if (!spec) {
        const got = await showFormDialog({
          title: 'New plugin',
          message:
            'Writes a working plugin from a template into your project’s plugins/ folder. Change its code and AGstudio picks up every save (your settings stay). The guide: docs/plugin-sdk.md.',
          fields: [
            { kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. Tape Stop' },
            { kind: 'choice', key: 'kind', label: 'What', options: KINDS },
            { kind: 'choice', key: 'style', label: 'Written as', options: STYLES },
            {
              kind: 'choice',
              key: 'edit',
              label: 'Then',
              options: [
                { value: 'yes', label: 'Open it in my code editor' },
                { value: 'no', label: 'Just add it' },
              ],
            },
          ],
          values: { name: '', kind: 'instrument', style: 'faust', edit: 'yes' },
          okLabel: 'Create',
        });
        if (!got) return;
        spec = { name: String(got.name).trim() || 'My plugin', kind: got.kind as NewPluginKind, style: got.style as NewPluginStyle };
        edit = got.edit !== 'no';
      }
      const made = await createPlugin(spec);
      if ('error' in made) return toast(made.error, 'error');
      toast(`Created “${spec.name}” in plugins/${made.folder}.`);
      if (edit) void openInEditor(made.main);
      if (!(await whenRegistered(s, made.id)))
        return toast(`plugins/${made.folder} was created but hasn’t loaded yet: check the browser’s Plugins section for errors.`, 'error');
      // Put it to use: an instrument gets a channel, an effect goes on the selected mixer track.
      const def = s.plugins.get(made.id);
      if (def?.kind === 'instrument') {
        const channelId = addInstrumentChannel(s, made.id);
        if (channelId) openWindow(s, 'plugin', { kind: 'channel', channelId });
      } else if (def?.kind === 'effect') {
        const added = addEffectToSelectedInsert(s, made.id);
        if (added) openWindow(s, 'plugin', { kind: 'fx', ...added });
      } else toast(`“${spec.name}” is in the piano roll’s Tools menu.`);
    },
  });
  commands.register<string>({
    id: 'plugins.editCode',
    title: 'Edit plugin code',
    category: 'Plugins',
    hint: 'Open one of your plugins’ files in your code editor (saving it hot-reloads the plugin)',
    argsHint: 'the plugin id (user.…)',
    palette: false,
    run: async (s, id) => {
      const want = String(id ?? '');
      const entry = s.plugins.entry(want) ?? s.plugins.scripts().find((e) => e.def.id === want);
      const file = entry && entry.source === 'user' ? pluginSourceFile(entry.path) : null;
      if (!file) return s.session.getState().toast('Only your own plugins (in plugins/) have code to edit here.', 'error');
      if (!(await openInEditor(file)))
        s.session.getState().toast(`${devServerMissing('Opening your code editor')} Or open ${file} yourself.`, 'error');
    },
  });
  addMenuItems('add', [sep(80), cmd('plugins.new', 81)]);
}
