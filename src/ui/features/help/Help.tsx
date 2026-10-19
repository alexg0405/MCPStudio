import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { startFromTemplate, TEMPLATES } from '@app/template-list';
import { formatChord } from '@core/commands/keymap';
import { holdModal } from '../../controls/Dialog';
import { placeBeside } from '../../controls/place';
import { Icon, type IconName } from '../../controls/Icon';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { helpStore, startTour } from './help-state';
import { startLesson } from './lesson-state';
import { TOUR } from './tour';
import styles from './Help.module.css';

/** What help is on screen: the welcome dialog, or the tour at a step. */

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
    startTour();
  };
  const ai = () => {
    close();
    openWindow(services, 'assistant');
  };

  useEffect(() => {
    const release = holdModal();
    ref.current?.focus();
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
  }, [services]);

  const search = chord('help.palette');
  const undo = chord('edit.undo');
  return (
    <div className={styles.backdrop}>
      <div ref={ref} tabIndex={-1} className={styles.welcome} role="dialog" aria-modal="true" aria-labelledby="ag-welcome-title">
        <h2 id="ag-welcome-title" className={styles.title}>
          Welcome to AG<b>studio</b>
        </h2>
        <p className={styles.lead}>Make beats and songs right in your browser. Here is how it fits together:</p>
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

export function TourOverlay() {
  const step = useStore(helpStore, (s) => s.tour);
  return step === null ? null : <Tour index={step} />;
}

function Tour({ index }: { index: number }) {
  const services = useServices();
  const chord = useChord();
  const holeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = TOUR[index]!;
  const last = index === TOUR.length - 1;
  const go = (i: number) => helpStore.setState({ tour: i < 0 || i >= TOUR.length ? null : i });

  useEffect(() => holdModal(), []);

  useEffect(() => {
    step.prepare?.(services);
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k !== 'Escape' && k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Enter') return;
      if (k === 'Enter' && document.activeElement instanceof HTMLButtonElement) return;
      e.preventDefault();
      e.stopPropagation();
      const now = helpStore.getState().tour ?? 0;
      if (k === 'Escape') helpStore.setState({ tour: null });
      else helpStore.setState({ tour: k === 'ArrowLeft' ? Math.max(0, now - 1) : now + 1 < TOUR.length ? now + 1 : null });
    };
    window.addEventListener('keydown', onKey, true);
    // The highlight follows its target (windows open, move and resize) without re-rendering.
    const stop = onFrame(() => {
      const hole = holeRef.current;
      const card = cardRef.current;
      if (!hole || !card) return;
      const el = document.querySelector(step.anchor);
      const raw = el?.getBoundingClientRect();
      const r = raw && raw.width > 0 && raw.height > 0 ? raw : null;
      if (r) {
        const pad = 6;
        hole.style.display = '';
        hole.style.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
        hole.style.width = `${r.width + pad * 2}px`;
        hole.style.height = `${r.height + pad * 2}px`;
      } else hole.style.display = 'none';
      card.classList.toggle(styles.cardAlone!, !r);
      // Beside the highlighted area if there is room, else below/above, else inside it.
      const { x, y } = placeBeside(r, card.offsetWidth, card.offsetHeight, window.innerWidth, window.innerHeight);
      card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      stop();
    };
  }, [services, step]);

  return (
    <div className={styles.tour}>
      <div ref={holeRef} className={styles.hole} />
      <div ref={cardRef} className={styles.card} role="dialog" aria-labelledby="ag-tour-title">
        <div className={styles.stepCount}>
          {index + 1} of {TOUR.length}
        </div>
        <h3 id="ag-tour-title" className={styles.cardTitle}>
          {step.title}
        </h3>
        <p className={styles.cardBody}>
          {step.body.replace(/\{key:([\w.]+)\}/g, (_, command: string) => chord(command) ?? '')}
        </p>
        <div className={styles.cardButtons}>
          <button className={styles.link} onClick={() => go(-1)}>
            Skip tour
          </button>
          <span className={styles.spacer} />
          {index > 0 && (
            <button className={styles.button} onClick={() => go(index - 1)}>
              Back
            </button>
          )}
          <button className={`${styles.button} ${styles.primary}`} onClick={() => go(last ? -1 : index + 1)} autoFocus>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
