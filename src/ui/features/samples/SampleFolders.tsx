import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { progressText } from './view';
import { addSampleChannels, importAudioFile } from '@app/actions/samples';
import {
  addSampleFolder,
  canPickFolders,
  reconnectSampleFolder,
  refreshSampleFolder,
  removeSampleFolder,
  sampleFolders,
  type AudioFileEntry,
  type FolderState,
} from '@app/persistence/sample-folders';
import { startAudioFileDrag } from '../../audio-drag';
import { showContextMenu } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import styles from '../../shell/Browser.module.css';

/** A folder level in the tree: its subfolders and its files. */
interface Node {
  name: string;
  path: string;
  dirs: Node[];
  files: AudioFileEntry[];
}

function buildTree(name: string, files: readonly AudioFileEntry[]): Node {
  const root: Node = { name, path: '', dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.dirs.find((d) => d.path === path);
      if (!next) {
        next = { name: parts[i] as string, path, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

const indent = (depth: number) => ({ paddingLeft: 24 + depth * 12 });

/** The user's sample folders: click a file to preview it, drag it onto the rack or playlist. */
export function SampleFoldersSection() {
  const services = useServices();
  const folders = useStore(sampleFolders, (s) => s.folders);
  const loaded = useStore(sampleFolders, (s) => s.loaded);
  const progress = useStore(services.sampleBrowser.store, (s) => s.progress);
  const status = progressText(progress);
  return (
    <>
      {folders.length > 0 && (
        <button
          className={styles.item}
          onClick={() => services.commands.run('samples.open')}
          data-hint="Search and filter your samples by type, tempo and key, hear them and drag them into the project"
        >
          <Icon name="wave" size={12} /> Open the sample browser
        </button>
      )}
      {status && <div className={styles.empty}>{status}</div>}
      {folders.map((f) => (
        <Folder key={f.key} folder={f} />
      ))}
      {loaded && folders.length === 0 && <div className={styles.empty}>No sample folders yet</div>}
      {canPickFolders() ? (
        <button
          className={styles.item}
          onClick={() => void addSampleFolder()}
          data-hint="Add a folder of samples from your computer (it stays in the browser)"
        >
          <Icon name="plus" size={12} /> Add folder…
        </button>
      ) : (
        <div className={styles.empty}>Sample folders need Chrome or Edge</div>
      )}
    </>
  );
}

/** Folders with more files than this are searched in the sample browser window instead of listed here. */
const TREE_MAX = 300;

function Folder({ folder }: { folder: FolderState }) {
  const services = useServices();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(['']));
  const tree = useMemo(() => buildTree(folder.name, (folder.files?.length ?? 0) > TREE_MAX ? [] : (folder.files ?? [])), [folder.name, folder.files]);
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu(e, [
      { label: 'Open the sample browser', onSelect: () => services.commands.run('samples.open') },
      { label: 'Refresh', onSelect: () => void refreshSampleFolder(folder.key) },
      { label: 'Analyze again', onSelect: () => void services.sampleBrowser.reanalyze(folder.key), hint: 'Work out the type, tempo and key of every sound in this folder again' },
      { kind: 'separator' },
      { label: 'Remove from browser', danger: true, onSelect: () => void removeSampleFolder(folder.key) },
    ]);
  };
  const rootOpen = open.has('');
  return (
    <>
      <button
        className={`${styles.item} ${styles.folderRow}`}
        style={indent(-1)}
        onClick={() => toggle('')}
        onContextMenu={menu}
        data-hint={`${folder.name}: click to open or close, right-click for options`}
      >
        <Icon name={rootOpen ? 'chevronDown' : 'chevronRight'} size={12} />
        <Icon name="folder" size={13} />
        {folder.name}
        {folder.files && <span className={styles.badge}>{folder.files.length}</span>}
      </button>
      {rootOpen && folder.access !== 'granted' && (
        <button
          className={styles.item}
          onClick={() => void reconnectSampleFolder(folder.key)}
          data-hint="The browser needs your permission again to read this folder"
        >
          Reconnect…
        </button>
      )}
      {rootOpen && folder.loading && <div className={styles.empty}>Scanning…</div>}
      {rootOpen && folder.error && <div className={styles.error}>{folder.error}</div>}
      {rootOpen && folder.access === 'granted' && folder.files && folder.files.length > TREE_MAX && (
        <button
          className={styles.item}
          onClick={() => services.commands.run('samples.open')}
          data-hint="This folder is too big for a list in the side panel: the sample browser window searches and filters it"
        >
          {folder.files.length.toLocaleString('en')} sounds: find them in the sample browser
        </button>
      )}
      {rootOpen && folder.access === 'granted' && !(folder.files && folder.files.length > TREE_MAX) && <Level node={tree} depth={0} open={open} toggle={toggle} />}
    </>
  );
}

function Level({
  node,
  depth,
  open,
  toggle,
}: {
  node: Node;
  depth: number;
  open: ReadonlySet<string>;
  toggle(path: string): void;
}) {
  return (
    <>
      {node.dirs.map((d) => (
        <div key={d.path}>
          <button
            className={`${styles.item} ${styles.folderRow}`}
            style={indent(depth - 1)}
            onClick={() => toggle(d.path)}
          >
            <Icon name={open.has(d.path) ? 'chevronDown' : 'chevronRight'} size={12} />
            <Icon name="folder" size={13} />
            {d.name}
          </button>
          {open.has(d.path) && <Level node={d} depth={depth + 1} open={open} toggle={toggle} />}
        </div>
      ))}
      {node.files.map((f) => (
        <SampleFile key={f.path} file={f} depth={depth} />
      ))}
    </>
  );
}

function SampleFile({ file, depth }: { file: AudioFileEntry; depth: number }) {
  const services = useServices();
  const preview = async () => {
    try {
      const ok = await services.engine.previewAudio(await (await file.handle.getFile()).arrayBuffer());
      if (!ok) services.session.getState().toast(`Can't play "${file.name}"`, 'error');
    } catch (e) {
      services.session.getState().toast(`Can't read "${file.name}": ${e instanceof Error ? e.message : e}`, 'error');
    }
  };
  const addChannel = async () => {
    const ref = await importAudioFile(services, await file.handle.getFile());
    if (ref) addSampleChannels(services, [ref]);
  };
  return (
    <button
      className={styles.item}
      style={indent(depth)}
      onClick={() => void preview()}
      onDoubleClick={() => void addChannel()}
      draggable
      onDragStart={(e) => startAudioFileDrag(e.dataTransfer, file.handle)}
      data-hint={`${file.path}: click to preview, double-click to add a channel, drag onto the channel rack or playlist`}
    >
      <Icon name="wave" size={12} />
      {file.name.replace(/\.[^.]+$/, '')}
    </button>
  );
}
