import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { formatChord } from '@core/commands/keymap';
import { announce } from '../../a11y/announce';
import { holdModal } from '../../controls/Dialog';
import { placeBeside } from '../../controls/place';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { isTouchLayout } from '../../touch/layout';
import helpStyles from '../help/Help.module.css';
import { boxOf, findTarget } from './target';
import { endTour, goToStep, tourStore } from './tour-state';
import type { Tour, TourStep } from './tour-types';
import styles from './Tours.module.css';

/** Space around the highlighted part, in px. */
const SPOT_PADDING = 6;
/** The card takes the top of the screen instead of the bottom when what it points at is below this share of the height. */
const DOCK_TOP_BELOW = 0.55;

/** The tour on screen: the dimmed page with a highlight on the step's target, and the card that explains it. */
export function TourOverlay() {
  const run = useStore(tourStore, (s) => s.run);
  const step = run?.tour.steps[run.step];
  return run && step ? <TourCard tour={run.tour} step={step} index={run.step} /> : null;
}

/** `{key:command}` in a step's text becomes that command's shortcut on this computer (nothing when it has none). */
export function withShortcuts(text: string, chordOf: (command: string) => string | null): string {
  return text.replace(/\{key:([\w.]+)\}/g, (_, command: string) => chordOf(command) ?? 'its shortcut');
}

function TourCard({ tour, step, index }: { tour: Tour; step: TourStep; index: number }) {
  const services = useServices();
  const holeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const isFirst = index === 0;
  const isLast = index === tour.steps.length - 1;
  const isSpotlight = tour.steps.length === 1;
  const chordOf = (command: string) => {
    const chord = services.keymap.chordsFor(command)[0];
    return chord ? formatChord(chord, services.platform) : null;
  };
  const body = withShortcuts(step.body, chordOf);
  const isOnDemo = useStore(services.demo.store, (s) => s.active);

  // Shortcuts stand down while the tour has the keyboard, and the focus goes back where it was when the tour ends.
  useEffect(() => {
    const release = holdModal();
    const opener = document.activeElement;
    return () => {
      release();
      // After the project and its windows are back (they may take the focus as they are drawn again).
      requestAnimationFrame(() => {
        if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) opener.focus();
      });
    };
  }, []);

  // A new card: make its target appear, then tell the screen reader. The first card takes the focus, so the reader says
  // its name and text as a dialog; later cards keep the focus where it is (on Next) and are announced instead.
  useEffect(() => {
    step.prepare?.(services);
    const count = `Step ${index + 1} of ${tour.steps.length}`;
    if (isFirst) cardRef.current?.focus();
    else announce(`${count}: ${step.title}. ${body}`);
  }, [services, step, index, isFirst, tour.steps.length, body]);

  // Arrow keys and Escape work from anywhere in the page, in the capture phase so nothing else sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key;
      if (key !== 'Escape' && key !== 'ArrowRight' && key !== 'ArrowLeft') return;
      e.preventDefault();
      e.stopPropagation();
      const now = tourStore.getState().run?.step ?? 0;
      if (key === 'Escape') endTour(services);
      else goToStep(services, key === 'ArrowLeft' ? Math.max(0, now - 1) : now + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [services]);

  // Keep Tab inside the card: the page behind it is dimmed and out of reach.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const buttons = [...card.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === card)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onTab, true);
    return () => window.removeEventListener('keydown', onTab, true);
  }, []);

  // The highlight follows its target (windows open, move and resize) without re-rendering.
  useEffect(() => {
    let hasScrolledToTarget = false;
    return onFrame(() => {
      const hole = holeRef.current;
      const card = cardRef.current;
      if (!hole || !card) return;
      const element = findTarget(step.target);
      const box = boxOf(element);
      // A menu or toolbar part that a narrow screen scrolls out of view is brought in once (floating windows stay put).
      if (element && box && !hasScrolledToTarget && !step.target.startsWith('window:')) {
        hasScrolledToTarget = true;
        if (box.left < 0 || box.right > window.innerWidth)
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (box) {
        hole.style.display = '';
        hole.style.transform = `translate(${box.left - SPOT_PADDING}px, ${box.top - SPOT_PADDING}px)`;
        hole.style.width = `${box.width + SPOT_PADDING * 2}px`;
        hole.style.height = `${box.height + SPOT_PADDING * 2}px`;
      } else hole.style.display = 'none';
      card.classList.toggle(helpStyles.cardAlone!, !box);
      const docked = isTouchLayout();
      card.classList.toggle(styles.docked!, docked);
      if (docked) {
        card.dataset.dock = box && box.top + box.height / 2 > window.innerHeight * DOCK_TOP_BELOW ? 'top' : 'bottom';
        card.style.transform = '';
        return;
      }
      delete card.dataset.dock;
      // Beside the highlighted part if there is room, else below or above, else inside it.
      const { x, y } = placeBeside(box, card.offsetWidth, card.offsetHeight, window.innerWidth, window.innerHeight);
      card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });
  }, [step.target]);

  const tryIt = step.tryIt;
  return (
    <div className={helpStyles.tour} data-tour-overlay={tour.id}>
      <div ref={holeRef} className={helpStyles.hole} aria-hidden="true" />
      <div
        ref={cardRef}
        className={`${helpStyles.card} ${styles.card}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-tour-count ag-tour-title"
        aria-describedby="ag-tour-body"
        tabIndex={-1}
        data-step={step.id}
      >
        <div id="ag-tour-count" className={helpStyles.stepCount}>
          {isSpotlight ? 'Here it is' : `${tour.title}: step ${index + 1} of ${tour.steps.length}`}
        </div>
        {!isSpotlight && (
          <div className={styles.dots} aria-hidden="true">
            {tour.steps.map((s, i) => (
              <span key={s.id} className={i === index ? styles.dotOn : i < index ? styles.dotDone : styles.dot} />
            ))}
          </div>
        )}
        <h3 id="ag-tour-title" className={helpStyles.cardTitle}>
          {step.title}
        </h3>
        <p id="ag-tour-body" className={helpStyles.cardBody}>
          {body}
        </p>
        {tryIt && (
          <button
            className={`${helpStyles.button} ${styles.tryIt}`}
            onClick={() => void services.commands.run(tryIt.command, tryIt.args)}
            data-hint={`${tryIt.label}: runs the same command as its menu entry`}
          >
            {tryIt.label}
          </button>
        )}
        {isOnDemo && (
          <p className={styles.note}>This tour uses a demo song. Your own project comes back when you finish.</p>
        )}
        <div className={helpStyles.cardButtons}>
          {!isSpotlight && (
            <button
              className={helpStyles.link}
              onClick={() => endTour(services)}
              data-hint="Stop the tour and get your project back (Esc)"
            >
              Skip tour
            </button>
          )}
          <span className={helpStyles.spacer} />
          {index > 0 && (
            <button
              className={helpStyles.button}
              onClick={() => goToStep(services, index - 1)}
              data-hint="The step before (←)"
            >
              Back
            </button>
          )}
          <button
            className={`${helpStyles.button} ${helpStyles.primary}`}
            onClick={() => goToStep(services, isLast ? -1 : index + 1)}
            data-hint={isLast ? 'Finish the tour and get your project back' : 'The next step (→)'}
          >
            {isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
