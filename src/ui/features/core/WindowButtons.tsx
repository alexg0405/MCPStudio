import { CommandButton } from '../../shell/Toolbar';
import { useHistoryStatus } from '../../services-context';

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
      {/* Always shown: undo is the musician's safety net (for the Studio's changes too). */}
      <CommandButton command="edit.undo" icon="undo" />
      <CommandButton command="edit.redo" icon="redo" />
    </>
  );
}
