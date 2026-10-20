import { useEffect, useRef, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { Services } from '@app/services';
import { startFromTemplate, TEMPLATES } from '@app/template-list';
import { formatChord } from '@core/commands/keymap';
import { holdModal } from '../../controls/Dialog';
import { useDialogFocus } from '../../controls/dialog-focus';
import { Icon, type IconName } from '../../controls/Icon';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { helpStore } from './help-state';
import { startLesson } from './lesson-state';
import styles from './Help.module.css';

/** The welcome dialog (the guided tours are in features/tours). */

const PARTS: { icon: IconName; title: string; text: string; command: string }[] = [
  {
    icon: 'channelRack',
    title: 'Channel rack',
    text: 'Each row is a sound. Click the squares to make a beat.',
    command: 'view.channelRack',
  },
  {
    icon: 'play',
    title: 'Play',
    text: 'Space plays and stops. PAT loops the pattern, SONG plays the song.',
    command: 'transport.playPause',
  },
  {
    icon: 'pianoRoll',
    title: 'Piano roll',
    text: 'Draw melodies and chords for the selected sound.',
    command: 'view.pianoRoll',
  },
  {
    icon: 'playlist',
    title: 'Playlist',
    text: 'Arrange patterns into a song: click an empty spot to pick one, or drag to place the current pattern.',
    command: 'view.playlist',
  },
  {
    icon: 'mixer',
    title: 'Mixer',
    text: 'Volume, pan and effects such as reverb for every track.',
    command: 'view.mixer',
  },
  {
    icon: 'studio',
    title: 'Studio',
    text: 'Ask in your own words: “make a lo-fi beat”, “add reverb to the snare”.',
    command: 'view.assistant',
  },
];

function useChord() {
  const { keymap, platform } = useServices();
  return (command: string) => {
    const c = keymap.chordsFor(command)[0];
    return c ? formatChord(c, platform) : null;
  };
}

export function WelcomeOverlay() {
  const open = useStore(helpStore, (s) => s.welcome);
  return open ? <Welcome /> : null;
}

function Welcome() {
  const services = useServices();
  const chord = useChord();
  const ref = useRef<HTMLDivElement>(null);
  const installed = useStore(services.pwa.store, (p) => p.installed);
  const close = () => {
    helpStore.setState({ welcome: false });
    services.prefs.getState().set({ welcomeSeen: true });
  };
  const tour = () => {
    services.prefs.getState().set({ welcomeSeen: true });
    helpStore.setState({ welcome: false });
    services.commands.run('tour.start', 'overview');
  };
  const ai = () => {
    close();
    openWindow(services, 'assistant');
  };

  useWelcomeKeys(ref, services);

  const search = chord('help.palette');
  const undo = chord('edit.undo');
  return (
    <div className={styles.backdrop}>
      <div
        ref={ref}
        tabIndex={-1}
        className={styles.welcome}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-welcome-title"
      >
        <h2 id="ag-welcome-title" className={styles.title}>
          Welcome to AG<b>studio</b>
        </h2>
        <p className={styles.lead}>Make beats and songs right in your browser. Here is how it fits together:</p>
        <WelcomeParts chord={chord} />
        <p className={styles.tips}>
          Point at anything to see what it does.
          {search && (
            <>
              {' '}
              <kbd>{search}</kbd> finds any action.
            </>
          )}
          {undo && (
            <>
              {' '}
              <kbd>{undo}</kbd> undoes any change.
            </>
          )}
        </p>
        {!installed && (
          <p className={styles.installLine}>
            Want AGstudio in its own window, with its own icon in the dock or taskbar?{' '}
            <button
              className={styles.inlineLink}
              onClick={() => {
                close();
                services.commands.run('app.install');
              }}
              data-hint="Install AGstudio as an app: its own window, starts offline, opens project files (Help → Install AGstudio as an app)"
            >
              Install it as an app
            </button>
            .
          </p>
        )}
        <p className={styles.installLine}>
          Already made something?{' '}
          <button
            className={styles.inlineLink}
            onClick={() => {
              close();
              openWindow(services, 'projects');
            }}
            data-hint="Open the project list: every project AGstudio remembers, with its tempo, key, length and a picture (File → Projects)"
          >
            Open your projects
          </button>
          . AGstudio also keeps earlier versions of your song as you work (File → Versions).
        </p>
        <p className={styles.installLine}>
          Can’t find something?{' '}
          <button
            className={styles.inlineLink}
            onClick={() => {
              close();
              services.commands.run('help.open');
            }}
            data-hint="Search everything AGstudio explains: tours, what each window does, every action, shortcuts and gestures (Help → Help and tours)"
          >
            Search the help
          </button>
          , see{' '}
          <button
            className={styles.inlineLink}
            onClick={() => {
              close();
              services.commands.run('help.features');
            }}
            data-hint="Everything AGstudio can do, by area, with a button that starts each one (Help → Features)"
          >
            everything it can do
          </button>
          , or take a guided tour from the Help menu: a first song, recording a vocal, DJ mixing and more.
        </p>
        <TemplateChips services={services} close={close} />
        <div className={styles.buttons}>
          <button
            className={styles.button}
            onClick={() => {
              close();
              void startLesson(services, 'first-beat');
            }}
            data-hint="A 2-minute lesson: make a beat step by step (it starts a new project)"
          >
            Learn by doing
          </button>
          <button className={styles.button} onClick={tour}>
            Show me around
          </button>
          <button className={styles.button} onClick={ai}>
            <Icon name="studio" size={14} /> Ask Studio for a beat
          </button>
          <button className={`${styles.button} ${styles.primary}`} onClick={close}>
            Start making music
          </button>
        </div>
      </div>
    </div>
  );
}

/** The parts of the app, each with its icon, a line about it and its shortcut. */
function WelcomeParts({ chord }: { chord: (command: string) => string | null }) {
  return (
    <div className={styles.parts}>
      {PARTS.map((p) => {
        const c = chord(p.command);
        return (
          <div key={p.title} className={styles.part}>
            <Icon name={p.icon} size={20} className={styles.partIcon} />
            <div>
              <div className={styles.partTitle}>
                {p.title}
                {c && <kbd>{c}</kbd>}
              </div>
              <div className={styles.partText}>{p.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Ready-made beats to start from, in groups: each chip starts a new project from that template. */
function TemplateChips({ services, close }: { services: Services; close: () => void }) {
  return (
    <>
      {(
        [
          ['beats', 'Or start from a ready beat:'],
          ['dance', 'Dance and bass music:'],
        ] as const
      ).map(([group, label]) => (
        <div key={group} className={styles.templates}>
          <span className={styles.templatesLabel}>{label}</span>
          {TEMPLATES.filter((t) => t.group === group).map((t) => (
            <button
              key={t.id}
              className={styles.chip}
              data-hint={t.description}
              onClick={() => {
                close();
                void startFromTemplate(services, t.id);
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/** While the welcome shows it has the keyboard: Esc or Enter (when no button has the focus) closes it. */
function useWelcomeKeys(ref: RefObject<HTMLDivElement | null>, services: Services): void {
  useDialogFocus(ref);
  useEffect(() => {
    const release = holdModal();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      if (e.key === 'Enter' && document.activeElement instanceof HTMLButtonElement) return;
      e.preventDefault();
      e.stopPropagation();
      helpStore.setState({ welcome: false });
      services.prefs.getState().set({ welcomeSeen: true });
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      release();
    };
  }, [ref, services]);
}
