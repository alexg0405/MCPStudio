import { CommandButton } from '../../shell/Toolbar';

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
