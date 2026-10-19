import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { canChooseOutput, listOutputs, onDevicesChange, revealDevices, type AudioOutput } from '@app/audio-devices';
import type { AudioBufferChoice } from '@app/stores/prefs';
import { useServices } from '../../services-context';
import { testSoundWav } from './test-sound';
import { Row, Section } from './parts';
import styles from './Settings.module.css';

/** What the Play through row says when something is off: no device choice in this browser, or the saved device is not connected. */
function playThroughHint(isSupported: boolean, isMissing: boolean): string | null {
  if (!isSupported) {
    return 'This browser always plays through the system output; choose it in your computer’s sound settings (Chrome and Edge can choose here).';
  }
  if (isMissing) return 'That device isn’t connected right now, so the system default plays. Plug it in, or pick another one.';
  return null;
}

/** Where the sound plays: the output device, a test sound, and the rate and delay the browser reports. */
export function SoundOutputSection() {
  const s = useServices();
  const chosen = useStore(s.prefs, (p) => p.outputDevice);
  const buffer = useStore(s.prefs, (p) => p.audioBuffer);
  const autoSize = useStore(s.prefs, (p) => p.autoBufferSize);
  const [list, setList] = useState<{ outputs: AudioOutput[]; complete: boolean } | null>(null);
  const refresh = useCallback(() => void listOutputs().then(setList), []);
  useEffect(() => {
    refresh();
    return onDevicesChange(refresh);
  }, [refresh]);
  const subscribe = useCallback(
    (fn: () => void) => {
      const id = window.setInterval(fn, 1000);
      const off = s.engine.subscribe(fn);
      return () => {
        window.clearInterval(id);
        off();
      };
    },
    [s],
  );
  const info = useSyncExternalStore(subscribe, () => {
    const st = s.engine.stats();
    const rate = `${(st.sampleRate / 1000).toFixed(st.sampleRate % 1000 ? 1 : 0)} kHz`;
    if (st.state !== 'running') return `${rate} · sound starts after your first click or key press`;
    return `${rate} · about ${Math.round((st.baseLatency + st.outputLatency) * 1000)} ms from AGstudio to your ears`;
  });

  const supported = canChooseOutput();
  const outputs = list?.outputs ?? [{ id: '', label: 'System default' }];
  // A saved device that isn't plugged in stays listed, so the choice doesn't change behind your back.
  const missing = !!chosen && !!list && !outputs.some((o) => o.id === chosen);
  const showAll = async () => {
    if (await revealDevices()) refresh();
    else s.session.getState().toast('The browser didn’t allow it, so only the system default is listed.', 'error');
  };
  const test = () => {
    void s.engine.resume().then(() => s.engine.previewAudio(testSoundWav(s.engine.sampleRate).slice().buffer));
  };

  return (
    <Section title="Sound output" intro="Where AGstudio plays: your speakers, headphones or audio interface.">
      <Row
        label="Play through"
        hint={playThroughHint(supported, missing)}
      >
        <select
          className={styles.select}
          value={chosen}
          disabled={!supported}
          onChange={(e) => s.prefs.getState().set({ outputDevice: e.target.value })}
          data-hint="The device AGstudio plays through (remembered in this browser)"
        >
          {outputs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          {missing && <option value={chosen}>The device you chose before (not connected)</option>}
        </select>
        <button className={styles.button} onClick={test} data-hint="A chime in the left speaker, then the right">
          ▶ Test sound
        </button>
      </Row>
      {supported && list && !list.complete && (
        <Row
          label=""
          hint="Browsers list your other speakers and headphones only after a site may use the microphone. AGstudio turns it off again right away and records nothing."
        >
          <button className={styles.button} onClick={() => void showAll()}>
            Show all my devices…
          </button>
        </Row>
      )}
      <Row
        label="Audio buffer"
        hint={`Auto starts small, so keys and Play answer fastest, and moves to a bigger buffer by itself if a busy song crackles (it remembers what works on this computer${buffer === 'auto' ? `; now ${autoSize}` : ''}). Large plays the busiest songs without dropouts. Changing it restarts the sound for a moment.`}
      >
        <select
          className={styles.select}
          value={buffer}
          onChange={(e) => {
            const choice = e.target.value as AudioBufferChoice;
            // A picked size is kept; choosing Auto starts again from the smallest.
            s.prefs
              .getState()
              .set(choice === 'auto' ? { audioBuffer: choice, autoBufferSize: 'small' } : { audioBuffer: choice, audioBufferPicked: true });
          }}
          data-hint="How much audio the browser prepares ahead: Auto picks the smallest that plays without crackles; large is smoothest, small answers fastest (about 21, 10 or 5 ms)"
        >
          <option value="auto">Auto: fastest that plays smoothly (recommended)</option>
          <option value="large">Large: smoothest playback</option>
          <option value="medium">Medium</option>
          <option value="small">Small: fastest response for playing live</option>
        </select>
      </Row>
      <Row label="Status" hint="Bluetooth headphones add a lot of delay; wired ones are best for recording and playing live.">
        <span className={styles.value}>{info}</span>
      </Row>
    </Section>
  );
}
