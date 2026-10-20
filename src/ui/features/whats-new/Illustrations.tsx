import type { ReactElement } from 'react';
import type { WhatsNewArt } from './entries';
import styles from './WhatsNew.module.css';

/**
 * The little pictures of the What's new list: plain shapes in the theme's own colors (no files to download), a few of them
 * moving a little (the meters, the playing launcher pad) unless "Less motion" is on. They only decorate: the text beside
 * each says everything, so they are hidden from screen readers.
 */

const bars = [14, 26, 20, 34, 24, 18];

const PICTURES: Record<WhatsNewArt, () => ReactElement> = {
  tour: () => (
    <>
      <rect className={styles.soft} x="8" y="10" width="64" height="36" rx="4" />
      <rect className={styles.ring} x="14" y="16" width="26" height="14" rx="3" />
      <rect className={styles.card} x="56" y="24" width="52" height="26" rx="4" />
      <rect className={styles.acc} x="62" y="30" width="22" height="3" rx="1.5" />
      <rect className={styles.line} x="62" y="37" width="38" height="2" rx="1" />
      <rect className={styles.acc} x="86" y="42" width="16" height="5" rx="2.5" />
    </>
  ),
  keys: () => (
    <>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect
          key={i}
          className={i === 3 ? styles.accSoft : styles.soft}
          x={10 + i * 14}
          y="14"
          width="12"
          height="30"
          rx="2"
        />
      ))}
      <rect className={styles.ring} x="52" y="12" width="16" height="34" rx="3" />
      <path className={styles.stroke} d="M96 40l8-8-8-8M104 32H86" />
    </>
  ),
  touch: () => (
    <>
      <rect className={styles.soft} x="16" y="8" width="88" height="42" rx="5" />
      <rect className={styles.line} x="22" y="16" width="30" height="8" rx="2" />
      <rect className={styles.line} x="58" y="16" width="40" height="8" rx="2" />
      <circle className={styles.accSoft} cx="46" cy="38" r="9" />
      <circle className={styles.acc} cx="46" cy="38" r="4" />
      <circle className={styles.accSoft} cx="74" cy="34" r="9" />
      <circle className={styles.acc} cx="74" cy="34" r="4" />
    </>
  ),
  versions: () => (
    <>
      <path className={styles.stroke} d="M12 30h96" />
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={i} className={i === 4 ? styles.acc : styles.dot} cx={16 + i * 22} cy="30" r={i === 4 ? 6 : 4} />
      ))}
      <rect className={styles.card} x="44" y="8" width="36" height="12" rx="3" />
      <path className={styles.stroke} d="M62 20v6" />
    </>
  ),
  video: () => (
    <>
      <rect className={styles.soft} x="14" y="8" width="64" height="40" rx="4" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect
          key={i}
          className={styles.acc}
          x={20 + i * 8}
          y={40 - (8 + ((i * 7) % 5) * 5)}
          width="5"
          height={8 + ((i * 7) % 5) * 5}
          rx="1.5"
        />
      ))}
      <rect className={styles.card} x="84" y="12" width="22" height="34" rx="4" />
      <path className={styles.play} d="M91 24l9 5-9 5z" />
    </>
  ),
  meters: () => (
    <>
      {bars.map((h, i) => (
        <rect
          key={i}
          className={`${styles.acc} ${styles.pulse}`}
          style={{ animationDelay: `${i * 0.18}s`, height: h }}
          x={14 + i * 14}
          y={46 - h}
          width="9"
          rx="2"
        />
      ))}
      <path className={styles.target} d="M8 20h104" />
      <rect className={styles.card} x="86" y="6" width="26" height="10" rx="3" />
    </>
  ),
  launcher: () => (
    <>
      {[0, 1, 2, 3].map((col) =>
        [0, 1, 2].map((row) => {
          const playing = col === 1 && row === 1;
          return (
            <rect
              key={`${col}-${row}`}
              className={playing ? `${styles.acc} ${styles.blink}` : (col + row) % 2 ? styles.accSoft : styles.soft}
              x={14 + col * 24}
              y={8 + row * 14}
              width="20"
              height="10"
              rx="3"
            />
          );
        }),
      )}
      <rect className={styles.line} x="14" y="50" width="92" height="2" rx="1" />
    </>
  ),
  decks: () => (
    <>
      <circle className={styles.soft} cx="30" cy="26" r="18" />
      <circle className={styles.ring} cx="30" cy="26" r="6" />
      <circle className={styles.soft} cx="90" cy="26" r="18" />
      <circle className={styles.ring} cx="90" cy="26" r="6" />
      <rect className={styles.line} x="46" y="48" width="28" height="2" rx="1" />
      <rect className={styles.acc} x="55" y="44" width="10" height="9" rx="2" />
    </>
  ),
  chords: () => (
    <>
      {['Am', 'F', 'C', 'G'].map((name, i) => (
        <g key={name}>
          <rect
            className={i === 1 ? styles.accSoft : styles.soft}
            x={10 + i * 26}
            y="8"
            width="24"
            height="14"
            rx="3"
          />
          <text className={styles.label} x={22 + i * 26} y="18" textAnchor="middle">
            {name}
          </text>
        </g>
      ))}
      <rect className={styles.acc} x="10" y="34" width="24" height="5" rx="2" />
      <rect className={styles.acc} x="36" y="30" width="24" height="5" rx="2" />
      <rect className={styles.acc} x="62" y="38" width="24" height="5" rx="2" />
      <rect className={styles.acc} x="88" y="32" width="24" height="5" rx="2" />
    </>
  ),
  vocal: () => (
    <>
      <path
        className={styles.wave}
        d="M8 28 Q14 8 20 28 T32 28 T44 28 Q50 4 56 28 T68 28 T80 28 Q86 16 92 28 T104 28"
      />
      <path className={styles.target} d="M8 34h100" />
      <rect className={styles.card} x="64" y="40" width="44" height="10" rx="3" />
      <rect className={styles.acc} x="68" y="43" width="14" height="4" rx="2" />
    </>
  ),
  samples: () => (
    <>
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect className={i === 1 ? styles.accSoft : styles.soft} x="10" y={8 + i * 11} width="76" height="9" rx="2" />
          <rect className={styles.line} x="14" y={11 + i * 11} width={30 + ((i * 13) % 22)} height="3" rx="1.5" />
        </g>
      ))}
      <rect className={styles.card} x="92" y="8" width="18" height="40" rx="4" />
      <path className={styles.play} d="M98 20l8 5-8 5z" />
    </>
  ),
  mcp: () => (
    <>
      <circle className={styles.acc} cx="60" cy="28" r="9" />
      {[
        [20, 12],
        [20, 44],
        [100, 12],
        [100, 44],
      ].map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <path className={styles.stroke} d={`M60 28L${x} ${y}`} />
          <circle className={styles.soft} cx={x} cy={y} r="7" />
        </g>
      ))}
    </>
  ),
};

/** The picture for a What's new entry. */
export function WhatsNewArtwork({ art }: { art: WhatsNewArt }) {
  return (
    <svg className={styles.art} viewBox="0 0 120 56" aria-hidden="true" focusable="false">
      {PICTURES[art]()}
    </svg>
  );
}
