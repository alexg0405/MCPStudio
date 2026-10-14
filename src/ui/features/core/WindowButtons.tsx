import { CommandButton } from '../../shell/Toolbar';
import { useHistoryStatus } from '../../services-context';
import shellStyles from '../../shell/Shell.module.css';

/** Quick toggles for the main windows (FL keeps these at the right of the toolbar). */
export function WindowButtons() {
  return (
    <>
      <CommandButton command="view.playlist" icon="playlist" />
      <CommandButton command="view.channelRack" icon="channelRack" />
      <CommandButton command="view.pianoRoll" icon="pianoRoll" />
      <CommandButton command="view.mixer" icon="mixer" />
      <CommandButton command="view.browser" icon="browser" />
    </>
  );
}

export function UndoRedo() {
  // Re-render when history labels change so the buttons' hints stay current.
  useHistoryStatus();
  return (
    <>
      {/* Hidden on narrow windows; Edit > Undo/Redo and the shortcuts still work. */}
      <CommandButton command="edit.undo" icon="undo" className={shellStyles.hideNarrow} />
      <CommandButton command="edit.redo" icon="redo" className={shellStyles.hideNarrow} />
    </>
  );
}
