import type { Services } from '@app/services';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar } from '@core/time/ppq';
import { showFormDialog } from '../../controls/FormDialog';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What is in the project, in plain words (the Project info dialog, and a quick sanity check). */
export function projectSummary(s: Services): string[] {
  const p = s.doc.getState().project;
  const channels = Object.values(p.channels);
  const instruments = channels.filter((c) => c.kind === 'instrument').length;
  const audio = channels.filter((c) => c.kind === 'audioClip').length;
  const automation = channels.filter((c) => c.kind === 'automation').length;
  const notes = Object.values(p.patterns).reduce(
    (n, pat) => n + Object.values(pat.notes).reduce((m, byCh) => m + Object.keys(byCh).length, 0),
    0,
  );
  const clips = Object.values(p.playlist.clips);
  const end = clips.reduce((t, c) => Math.max(t, c.start + c.length), 0);
  const bar = ticksPerBar(p.transport.timeSig);
  const seconds = end > 0 ? tempoMapOf(p, 'song').tickToSeconds(end) : 0;
  const length =
    end > 0
      ? `${Math.round((end / bar) * 10) / 10} bars (${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')})`
      : 'nothing on the playlist yet';
  const effects = Object.values(p.mixer.inserts).reduce((n, ins) => n + ins.fx.length, 0);
  const { timeSig, bpm, key } = p.transport;
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return [
    `${bpm} BPM · ${timeSig.num}/${timeSig.den}${key ? ` · ${NOTE[key.root]} ${key.scale.replace(/-/g, ' ')}` : ''}`,
    `Song length: ${length}`,
    `${plural(instruments, 'instrument')}, ${plural(audio, 'audio clip channel')}, ${plural(automation, 'automation')}`,
    `${plural(Object.keys(p.patterns).length, 'pattern')} with ${plural(notes, 'note')}; ${plural(clips.length, 'clip')} on the playlist; ${plural(Object.keys(p.playlist.markers).length, 'marker')}`,
    `${plural(effects, 'effect')} on the mixer; ${plural(Object.keys(p.samples).length, 'sample')}`,
    `Created ${new Date(p.meta.createdAt).toLocaleDateString()} with AGstudio ${p.meta.appVersion}`,
  ];
}

/** File → Project info…: the title and author (editable) and what is in the project. */
export async function showProjectInfo(s: Services): Promise<void> {
  const p = s.doc.getState().project;
  const values = await showFormDialog({
    title: 'Project info',
    message: `File: ${s.files.store.getState().name}${s.history.status().dirty ? ' (unsaved changes)' : ''}`,
    fields: [
      { kind: 'text', key: 'title', label: 'Title', placeholder: 'Untitled' },
      { kind: 'text', key: 'author', label: 'Author', placeholder: 'Your name' },
      ...projectSummary(s).map((text) => ({ kind: 'info' as const, text })),
    ],
    values: { title: p.meta.title, author: p.meta.author ?? '' },
    okLabel: 'Save info',
  });
  if (!values) return;
  const title = String(values.title).trim().slice(0, 120);
  const author = String(values.author).trim().slice(0, 120);
  if (title === p.meta.title && author === (p.meta.author ?? '')) return;
  s.history.transact('Project info', (d) => {
    d.meta.title = title || 'Untitled';
    if (author) d.meta.author = author;
    else delete d.meta.author;
  });
}
