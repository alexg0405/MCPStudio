import type { Services } from '@app/services';
import { addActionProvider } from '../../shell/actions';
import { addMenuItems, cmd } from '../../shell/menus';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { lazyWindow } from '../../workspace/lazy';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';

/**
 * Pro meters: the Meters window (loudness in LUFS, true peak, stereo, spectrum) and the offline loudness report. The
 * numbers come from a meter on the audio thread that exists only while the window (or the mixer's master readout) is
 * open. Studio has `get_loudness` and `loudness_report`.
 */
export function register(services: Services): void {
  registerWindowType({
    type: 'meters',
    title: () => 'Meters',
    component: lazyWindow(() => import('./MetersWindow'), (m) => m.MetersWindow),
    defaultRect: (ws) => ({ x: Math.max(0, Math.round(ws.w / 2 - 400)), y: 44, w: Math.min(800, ws.w), h: Math.min(640, ws.h - 70) }),
    minSize: { w: 340, h: 300 },
  });
  registerWindowToggle(services, {
    command: 'view.meters',
    type: 'meters',
    title: 'Meters',
    hint: 'Loudness (LUFS), true peak, stereo correlation, spectrum and spectrogram of the master, live',
    chords: ['Alt+Shift+M'],
    menuOrder: 56,
  });
  services.commands.register({
    id: 'meters.report',
    title: 'Loudness report…',
    category: 'File',
    hint: 'Renders the song offline and reports its integrated loudness, loudness range, true peak and what streaming services will do to it (opens the Meters window)',
    run: (s) => {
      openWindow(s, 'meters');
      void s.meters.showReport();
    },
  });
  services.commands.register({
    id: 'meters.reset',
    title: 'Restart the loudness measurement',
    category: 'View',
    hint: 'Starts the integrated loudness, loudness range, true-peak hold and history graph of the Meters window again, from now',
    enabled: (s) => s.meters.openCount > 0,
    run: (s) => s.meters.reset(),
  });
  addMenuItems('file', [cmd('meters.report', 74)]);
  addActionProvider('meters', (s) => [
    {
      key: 'meters.open',
      label: 'Check loudness and stereo (Meters)',
      path: ['View', 'Meters'],
      hint: 'LUFS, true peak, correlation, spectrum: is the mix loud enough, clipping, or out of phase in mono',
      keywords: ['loudness', 'lufs', 'true peak', 'meter', 'stereo', 'phase', 'correlation', 'spectrum', 'spectrogram', 'mastering', 'streaming', 'level'],
      run: () => openWindow(s, 'meters'),
    },
  ]);
  setWindowHelp('meters', {
    intro: 'Loudness, peaks and stereo of the master, measured the way streaming services and broadcasters do. It only runs while this window is open.',
    moves: [
      ['Short-term / Integrated', 'Loudness of the last 3 seconds, and of everything since you pressed play (LUFS). Compare with the dashed target line'],
      ['True peak', 'The highest level between samples (dBTP), held until Reset. Keep it under −1'],
      ['Range', 'Loudness range in LU: very low means squashed'],
      ['Goniometer and correlation', 'Straight up is mono; +1 is mono, −1 cancels in mono. A red warning means the bass is out of phase'],
      ['Spectrum / Spectrogram', '1/6-octave bands with peak hold; with a reference song set, a dashed line shows its tone'],
      ['Target', 'Reference song, your song style, or streaming (−14), Apple Music (−16), broadcast (−23)'],
      ['Loudness report…', 'Renders the song offline and reports LUFS, range, true peak with bar positions and what Spotify, YouTube and others do; copy as text'],
      ['Mixer', 'The master strip shows the short-term loudness and true peak; click it to open this window'],
    ],
  });
}
