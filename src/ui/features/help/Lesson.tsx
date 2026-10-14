import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { onFrame } from '../../frame-loop';
import { useServices } from '../../services-context';
import { lessonStore, stopLesson } from './lesson-state';
import { LESSONS } from './lessons';
import styles from './Help.module.css';

export function LessonOverlay() {
  const id = useStore(lessonStore, (s) => s.id);
  return id ? <LessonCard id={id} /> : null;
}

/**
 * The lesson card (bottom left, never in the way of clicking) and a pulsing outline around where to
 * look. The step's check runs a few times a second; when it passes, the card says so and moves on.
 */
function LessonCard({ id }: { id: string }) {
  const services = useServices();
  const { step, passed } = useStore(lessonStore);
  const lesson = LESSONS.find((l) => l.id === id)!;
  const current = lesson.steps[step];
  const finished = step >= lesson.steps.length;
  const ringRef = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);

  // Prepare the step, then watch for it to be done.
  useEffect(() => {
    if (!current) return;
    current.prepare?.(services);
    let advance = 0;
    const timer = window.setInterval(() => {
      if (lessonStore.getState().passed || !current.done(services)) return;
      lessonStore.setState({ passed: true });
      advance = window.setTimeout(() => lessonStore.setState({ step: step + 1, passed: false }), 900);
    }, 250);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(advance);
    };
  }, [current, services, step]);

  // The outline follows its target (windows move, open and close).
  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    return onFrame(() => {
      const selector = current?.anchor?.(services);
      const r = selector ? document.querySelector(selector)?.getBoundingClientRect() : undefined;
      if (!r || r.width === 0 || finished) {
        ring.style.display = 'none';
        return;
      }
      ring.style.display = '';
      ring.style.transform = `translate(${r.left - 4}px, ${r.top - 4}px)`;
      ring.style.width = `${r.width + 8}px`;
      ring.style.height = `${r.height + 8}px`;
    });
  }, [current, services, finished, nudge]);

  return (
    <>
      <div ref={ringRef} className={`${styles.lessonRing} ${passed ? styles.lessonRingDone : ''}`} />
      <div className={styles.lessonCard} role="status" aria-live="polite">
        <div className={styles.lessonHead}>
          <span>
            Lesson · <b>{lesson.title}</b>
          </span>
          <span className={styles.lessonDots} aria-label={`Step ${Math.min(step + 1, lesson.steps.length)} of ${lesson.steps.length}`}>
            {lesson.steps.map((_, i) => (
              <i key={i} className={i < step || (i === step && passed) ? styles.dotDone : i === step ? styles.dotNow : ''} />
            ))}
          </span>
        </div>
        {finished ? (
          <p className={styles.lessonText}>
            <b>Done!</b> {lesson.next}
          </p>
        ) : (
          <p className={styles.lessonText}>
            {passed ? <b className={styles.lessonNice}>✓ Nice! </b> : null}
            {current?.text}
          </p>
        )}
        <div className={styles.lessonButtons}>
          {!finished && (
            <>
              <button
                className={styles.link}
                onClick={() => setNudge((n) => n + 1)}
                data-hint="Point at where to do this step again"
              >
                Show me
              </button>
              <button
                className={styles.link}
                onClick={() => lessonStore.setState({ step: step + 1, passed: false })}
                data-hint="Go on to the next step without doing this one"
              >
                Skip step
              </button>
            </>
          )}
          <span className={styles.spacer} />
          <button className={styles.button} onClick={stopLesson} data-hint="End the lesson (your work stays)">
            {finished ? 'Close' : 'Stop lesson'}
          </button>
        </div>
      </div>
    </>
  );
}
