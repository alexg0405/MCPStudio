import { useState } from 'react';
import { useStore } from 'zustand';
import { djControllers } from '@app/dj/controllers';
import type { ControllersState, LearnState } from '@app/dj/controllers';
import { presetById } from '@core/midi-map/presets';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import { ControlsTab } from './ControlsTab';
import styles from './Controllers.module.css';
import { MappingFooter } from './MappingFooter';
import { TestTab } from './TestTab';
import { NO_DECKS_TEXT, NO_DEVICE_TEXT, SECTIONS, type Section } from './view';

type Tab = 'controls' | 'test';

/** The DJ controllers window: connect a controller, link its controls to the decks (MIDI learn), watch what it sends. */
export function ControllersWindow() {
  const dj = djControllers(useServices());
  const state = useStore(dj.store);
  const [tab, setTab] = useState<Tab>('controls');
  const [section, setSection] = useState<Section>('A');
  const device = state.selected;
  const mapping = device ? (state.mappings[device] ?? null) : null;
  const deviceInfo = state.devices.find((d) => d.name === device) ?? null;
  const preset = deviceInfo?.preset ? presetById(deviceInfo.preset) : null;

  return (
    <div className={styles.root} data-tour="dj-controllers">
      <ConnectBar state={state} />
      {state.learn && <LearnBanner learn={state.learn} />}
      {state.access !== 'ready' ? (
        <NotConnectedNote access={state.access} />
      ) : !device || !mapping ? (
        <div className={styles.empty}>
          <Icon name="plug" size={28} />
          <div className={styles.emptyTitle}>No controller found</div>
          <div className={styles.emptyText}>Plug in your controller (it appears here by itself), or check that no other program holds it.</div>
        </div>
      ) : (
        <>
          <ViewBar tab={tab} setTab={setTab} section={section} setSection={setSection} />
          {state.decks === 'missing' && <div className={styles.note}>{NO_DECKS_TEXT}</div>}
          {state.fakeDecks && (
            <div className={styles.note}>The live decks are not wired in yet, so controls drive a stand-in deck (shown in the Test tab). This message goes away once they are.</div>
          )}
          {tab === 'controls' ? <ControlsTab device={device} mapping={mapping} preset={preset} section={section} learning={state.learn} /> : <TestTab />}
          <MappingFooter device={device} mapping={mapping} preset={preset} />
        </>
      )}
    </div>
  );
}

/** The top bar: the controller picker (or the Connect button), Disconnect, the lights note and Learn. */
function ConnectBar({ state }: { state: ControllersState }) {
  const dj = djControllers(useServices());
  const device = state.selected;
  const deviceInfo = state.devices.find((d) => d.name === device) ?? null;
  const isLearning = state.learn !== null;
  return (
    <div className={styles.bar}>
      <span className={styles.label}>Controller</span>
      {state.access === 'ready' ? (
        state.devices.length > 0 ? (
          <select
            className={styles.select}
            value={device ?? ''}
            onChange={(e) => dj.select(e.target.value)}
            aria-label="Controller"
            data-hint="Which connected MIDI controller you are looking at"
          >
            {state.devices.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.dim}>No controller found</span>
        )
      ) : (
        <button
          className={styles.primary}
          onClick={() => void dj.enable()}
          disabled={state.access === 'asking' || state.access === 'unsupported'}
          data-hint="Asks the browser for MIDI access, then listens to your DJ controller and lights its buttons"
        >
          <Icon name="midi" size={14} /> Connect controllers
        </button>
      )}
      {state.access === 'ready' && (
        <button className={styles.small} onClick={() => dj.disable()} data-hint="Stop listening to controllers (their lights go out)">
          Disconnect
        </button>
      )}
      <span className={styles.spacer} />
      {deviceInfo && (
        <span className={styles.dim} data-hint={deviceInfo.hasOutput ? 'The controller’s lights follow the decks' : 'This controller has no MIDI output we can open, so its lights stay as they are'}>
          {deviceInfo.hasOutput ? 'Lights on' : 'No lights'}
        </span>
      )}
      {state.access === 'ready' && (
        <button
          className={isLearning ? styles.on : styles.button}
          onClick={() => (isLearning ? dj.cancelLearn() : dj.startLearn())}
          disabled={!device}
          data-hint="Link controls: click a control in the list below (or on a deck), then move or press it on your controller"
        >
          {isLearning ? 'Done' : 'Learn controls'}
        </button>
      )}
    </div>
  );
}

/** What learn mode is waiting for, with "That's enough" and Cancel once a control is picked. */
function LearnBanner({ learn }: { learn: LearnState }) {
  const dj = djControllers(useServices());
  return (
    <div className={styles.learn} role="status">
      <Icon name="midi" size={16} />
      <span className={styles.learnText}>{learn.message}</span>
      {learn.target && (
        <>
          <button className={styles.small} onClick={() => dj.finishLearn()} data-hint="Use what the controller has sent so far, even if the type of control is not certain">
            That’s enough
          </button>
          <button className={styles.small} onClick={() => dj.cancelLearn()} data-hint="Stop learning this control">
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

/** What the window says before MIDI is allowed: how to start, or why it can't. */
function NotConnectedNote({ access }: { access: ControllersState['access'] }) {
  const title = access === 'denied' ? 'MIDI is blocked' : access === 'unsupported' ? 'This browser has no MIDI' : 'Use a DJ controller';
  const text =
    access === 'denied'
      ? 'Allow MIDI for this site (the lock icon in the address bar), then press Connect again.'
      : access === 'unsupported'
        ? 'Web MIDI works in Chrome and Edge.'
        : NO_DEVICE_TEXT;
  return (
    <div className={styles.empty}>
      <Icon name="midi" size={28} />
      <div className={styles.emptyTitle}>{title}</div>
      <div className={styles.emptyText}>{text}</div>
    </div>
  );
}

/** The Controls / Test tabs, the deck section picker, and the song the browse encoder points at. */
function ViewBar({ tab, setTab, section, setSection }: { tab: Tab; setTab(tab: Tab): void; section: Section; setSection(section: Section): void }) {
  return (
    <div className={styles.bar}>
      <div className={styles.seg} role="tablist" aria-label="View">
        <button
          role="tab"
          aria-selected={tab === 'controls'}
          className={tab === 'controls' ? styles.segOn : styles.segItem}
          onClick={() => setTab('controls')}
          data-hint="The controls of the decks and the mixer, and which control of your controller drives each"
        >
          Controls
        </button>
        <button
          role="tab"
          aria-selected={tab === 'test'}
          className={tab === 'test' ? styles.segOn : styles.segItem}
          onClick={() => setTab('test')}
          data-hint="Watch the messages your controller sends, and what they did"
        >
          Test
        </button>
      </div>
      {tab === 'controls' && (
        <div className={styles.seg} role="radiogroup" aria-label="Section">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={section === s.id}
              className={section === s.id ? styles.segOn : styles.segItem}
              onClick={() => setSection(s.id)}
              data-hint={`Show the controls of ${s.label}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <span className={styles.spacer} />
      <BrowseLine />
    </div>
  );
}

/** The song the browse encoder has highlighted. */
function BrowseLine() {
  const dj = djControllers(useServices());
  // The cursor lives outside React: subscribing to its index re-renders this line when the encoder turns.
  useStore(dj.browse.store, (s) => s.index);
  const song = dj.browse.current();
  return (
    <span className={styles.dim} data-hint="The song the browse encoder points at: press a deck’s load button to put it on that deck">
      Library highlight: {song ? song.label : 'the music library is empty'}
    </span>
  );
}
