/** "Import MusicXML…": choose a file, say whether it replaces the channel's notes in the pattern or is added to them, import. */
import { importMusicXmlText, pickMusicXmlFile } from '@app/notation/actions';
import type { Services } from '@app/services';
import { p } from '@agstudio/sdk';
import { showFormDialog } from '../../controls/FormDialog';
import { report } from './sheet-menu';

const FIELDS = [{ kind: 'param', key: 'replace', spec: p.bool(true, { label: 'Replace the channel’s notes in this pattern' }) }] as const;

/** Asks for a file and imports its first part into the piano roll's channel and the current pattern. */
export async function importMusicXmlDialog(s: Services): Promise<void> {
  const file = await pickMusicXmlFile();
  if (!file) return;
  const values = await showFormDialog({
    title: `Import ${file.name}`,
    message: 'The notes of the first part go into the selected channel in the current pattern, as one undo step.',
    fields: FIELDS,
    values: { replace: true },
    okLabel: 'Import',
  });
  if (!values) return;
  report(s, importMusicXmlText(s, await file.text(), { replace: values.replace === true }));
}
