import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useStore } from 'zustand';
import { trackAnalyzer } from '@app/dj/analyzer';
import {
  analyzeLibrary,
  library,
  loadLibrary,
  moveSong,
  pickSongFiles,
  pickSongFolder,
  removeSongs,
  setSelection,
  songsToMix,
  stopMaking,
  togglePin,
  type LibrarySong,
} from '@app/dj/library';
import { DEFAULT_DJ_OPTIONS, planOfCurrentMix, transitionLabel, tweakTransition } from '@app/dj/mix';
import type { TrackAnalysis } from '@core/dj/types';
import type { DjMixOptions } from '@core/model/types';
import type { TransitionRecipe } from '@core/dj/plan';
import { canPickFolders } from '@app/persistence/sample-folders';
import { showContextMenu } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useDoc, useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import styles from './Dj.module.css';
import {
  bpmText,
  EMPTY_TEXT,
  ENERGY_CHOICES,
  formatLength,
  keyBadge,
  LENGTH_CHOICES,
  libraryLine,
  ORDER_CHOICES,
  RECIPE_CHOICES,
  sparkPoints,
  statusText,
  TRANSITION_CHOICES,
} from './dj-view';
import { makeMixFromUi } from './run';

/** Re-renders when an analysis lands. */
function useAnalysisVersion(): number {
  const services = useServices();
  const [v, setV] = useState(0);
  useEffect(() => trackAnalyzer(services)?.subscribe(() => setV((x) => x + 1)), [services]);
  return v;
}

function Segmented<T extends string>({ value, choices, onChange, label }: { value: T; choices: readonly { value: T; label: string; hint: string }[]; onChange(v: T): void; label: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.seg} role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <button
            key={c.value}
            role="radio"
            aria-checked={value === c.value}
            className={value === c.value ? styles.segOn : styles.segItem}
            onClick={() => onChange(c.value)}
            data-hint={`${label}: ${c.label}. ${c.hint}`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The DJ window: your music, the mix options, "Make the mix", and the transitions of the mix. */
export function DjWindow() {
  const services = useServices();
  const st = useStore(library);
  const version = useAnalysisVersion();
  const dj = useDoc((p) => p.dj);
  const [options, setOptions] = useState<DjMixOptions>(() => services.doc.getState().project.dj?.options ?? DEFAULT_DJ_OPTIONS);
  const [dropAt, setDropAt] = useState<number | null>(null);
  useEffect(() => {
    void loadLibrary().then(() => analyzeLibrary(services));
  }, [services]);

  const analyzer = trackAnalyzer(services);
  const analysisOf = (x: LibrarySong): TrackAnalysis | null => analyzer?.peek(x.key) ?? null;
  const selected = new Set(st.selected);
  const toMix = songsToMix(st);
  const total = toMix.reduce((sum, x) => sum + (x.durationSec ?? 0), 0);
  const set = (patch: Partial<DjMixOptions>) => setOptions((o) => ({ ...o, ...patch }));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the analyses change under `version`
  const plan = useMemo(() => (dj ? planOfCurrentMix(services, services.doc.getState().project) : null), [dj, services, version]);

  const toggle = (key: string, e: { shiftKey: boolean }) => {
    if (e.shiftKey && st.selected.length) {
      const keys = st.songs.map((x) => x.key);
      const a = keys.indexOf(st.selected[st.selected.length - 1]!);
      const b = keys.indexOf(key);
      setSelection([...st.selected, ...keys.slice(Math.min(a, b), Math.max(a, b) + 1)]);
    } else setSelection(selected.has(key) ? st.selected.filter((k) => k !== key) : [...st.selected, key]);
  };
  const onDrop = (e: DragEvent, index: number) => {
    e.preventDefault();
    const key = e.dataTransfer.getData('text/x-ag-song');
    setDropAt(null);
    if (key) {
      const from = st.songs.findIndex((x) => x.key === key);
      void moveSong(key, from < index ? index - 1 : index);
    }
  };
  const rowMenu = (e: React.MouseEvent, x: LibrarySong) => {
    e.preventDefault();
    const keys = selected.has(x.key) ? st.selected : [x.key];
    showContextMenu(e, [
      { label: x.pinned ? 'Unpin' : 'Pin to this place', onSelect: () => void togglePin(x.key) },
      { label: 'Move to the top', onSelect: () => void moveSong(x.key, 0) },
      { label: 'Move to the end', onSelect: () => void moveSong(x.key, st.songs.length) },
      { kind: 'separator' },
      { label: keys.length > 1 ? `Remove ${keys.length} songs from the library` : 'Remove from the library', danger: true, onSelect: () => void removeSongs(keys) },
    ]);
  };

  const busy = st.adding !== null || st.making !== null;
  const songTitle = (sampleId: string) => dj?.songs.find((x) => x.sampleId === sampleId)?.title ?? '?';

  return (
    <div className={styles.dj} data-tour="dj">
      <div className={styles.bar}>
        <span className={styles.label}>Music</span>
        <button className={styles.button} onClick={() => void pickSongFiles(services)} disabled={busy} data-hint="Add song files from your computer (MP3, AAC/M4A, WAV, FLAC, OGG). They stay in this browser">
          <Icon name="plus" size={12} /> Add files…
        </button>
        {canPickFolders() && (
          <button className={styles.button} onClick={() => void pickSongFolder(services)} disabled={busy} data-hint="Add every song in a folder (and its subfolders), up to 500">
            <Icon name="folder" size={13} /> Add folder…
          </button>
        )}
        <span className={styles.spacer} />
        {st.adding && (
          <span className={styles.dim}>
            Adding {st.adding.done + 1} of {st.adding.total}: {st.adding.name}
          </span>
        )}
        {st.songs.length > 0 && (
          <span className={styles.dim} data-hint={st.selected.length ? 'The selected songs go in the mix' : 'Select songs to mix only those; with none selected, every song goes in'}>
            {st.selected.length ? `${st.selected.length} selected · ` : ''}
            {libraryLine(toMix.length, total)}
          </span>
        )}
      </div>

      {st.loaded && st.songs.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="note" size={28} />
          <div className={styles.emptyTitle}>Make a party mix from your own songs</div>
          <div className={styles.emptyText}>{EMPTY_TEXT}</div>
          <div className={styles.emptyText}>Then press “Make the mix”: Studio orders the songs, matches their beats and builds every transition on the playlist.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={styles.primary} onClick={() => void pickSongFiles(services)} data-hint="Add song files from your computer">
              Add music files…
            </button>
            {canPickFolders() && (
              <button className={styles.button} onClick={() => void pickSongFolder(services)} data-hint="Add every song in a folder">
                Add a folder…
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={st.songs.length > 0 && st.selected.length === st.songs.length}
                    onChange={(e) => setSelection(e.target.checked ? st.songs.map((x) => x.key) : [])}
                    data-hint="Select every song (or none: then every song goes in the mix anyway)"
                  />
                </th>
                <th className={styles.num}>#</th>
                <th>Song</th>
                <th className={styles.right} data-hint="Length (minutes:seconds)">Length</th>
                <th className={styles.right} data-hint="Tempo in beats per minute">BPM</th>
                <th data-hint="Key on the Camelot wheel: neighbours (±1, or A↔B) mix smoothly">Key</th>
                <th data-hint="Energy along the song (loud, busy parts are high)">Energy</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {st.songs.map((x, i) => {
                const a = analysisOf(x);
                const key = keyBadge(a);
                const status = statusText(a, st.analysis[x.key], st.analyzerMissing);
                return (
                  <tr
                    key={x.key}
                    className={`${styles.row} ${selected.has(x.key) ? styles.selected : ''} ${dropAt === i ? styles.dropBefore : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/x-ag-song', x.key);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes('text/x-ag-song')) return;
                      e.preventDefault();
                      setDropAt(i);
                    }}
                    onDragLeave={() => setDropAt(null)}
                    onDrop={(e) => onDrop(e, i)}
                    onClick={(e) => toggle(x.key, e)}
                    onContextMenu={(e) => rowMenu(e, x)}
                    data-hint={`${x.label}: click to select (Shift for a range), drag to reorder, right-click for more`}
                  >
                    <td>
                      <input type="checkbox" aria-label={`Select ${x.label}`} checked={selected.has(x.key)} onChange={() => {}} tabIndex={-1} />
                    </td>
                    <td className={styles.num}>{i + 1}</td>
                    <td className={styles.title} title={x.fileName}>
                      {x.title}
                      {x.artist && <span className={styles.artist}>{x.artist}</span>}
                    </td>
                    <td className={styles.right}>{formatLength(x.durationSec)}</td>
                    <td className={styles.right} data-hint={a?.grid ? `${bpmText(a)} BPM (${Math.round(a.grid.confidence * 100)} % sure of the beat grid)` : 'Tempo: not known yet'}>
                      {bpmText(a)}
                    </td>
                    <td>
                      <span
                        className={styles.badge}
                        style={key.color ? { background: `color-mix(in srgb, ${key.color} 70%, var(--ag-surface-1))`, color: 'var(--ag-on-light)' } : undefined}
                        data-hint={key.hint}
                      >
                        {key.text}
                      </span>
                    </td>
                    <td>
                      {a ? (
                        <svg className={styles.spark} width={64} height={16} aria-hidden data-hint="Energy along the song">
                          <polyline points={sparkPoints(a.energy, 64, 16)} fill="none" stroke="currentColor" strokeWidth={1.2} />
                        </svg>
                      ) : (
                        <span className={styles.status}>{status}</span>
                      )}
                    </td>
                    <td>
                      <button
                        className={x.pinned ? styles.pinOn : styles.pin}
                        onClick={(e) => {
                          e.stopPropagation();
                          void togglePin(x.key);
                        }}
                        data-hint={x.pinned ? 'Pinned: auto order keeps this song at this place. Click to unpin' : 'Pin: auto order keeps this song at this place in the list'}
                      >
                        {x.pinned ? 'Pinned' : 'Pin'}
                      </button>
                    </td>
                    <td>
                      <button
                        className={styles.pin}
                        aria-label="Remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeSongs([x.key]);
                        }}
                        data-hint="Remove from the library (the file on your computer stays)"
                      >
                        <Icon name="close" size={10} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.options}>
        <Segmented label="Order" value={options.order} choices={ORDER_CHOICES} onChange={(order) => set({ order })} />
        <Segmented label="Energy" value={options.energy} choices={ENERGY_CHOICES} onChange={(energy) => set({ energy })} />
        <Segmented label="Transitions" value={options.transition} choices={TRANSITION_CHOICES} onChange={(transition) => set({ transition })} />
        <div className={styles.field}>
          <span className={styles.label}>Mix tempo</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div className={styles.seg}>
              <button
                className={options.mixTempo === 'follow' ? styles.segOn : styles.segItem}
                onClick={() => set({ mixTempo: 'follow' })}
                data-hint="Each song plays at its own tempo; the tempo glides from one to the next during the transitions"
              >
                Follow songs
              </button>
              <button
                className={options.mixTempo !== 'follow' ? styles.segOn : styles.segItem}
                onClick={() => set({ mixTempo: options.mixTempo === 'follow' ? 124 : options.mixTempo })}
                data-hint="The whole mix plays at one tempo (every song is time-stretched to it)"
              >
                Fixed
              </button>
            </div>
            {options.mixTempo !== 'follow' && (
              <input
                className={styles.input}
                type="number"
                min={50}
                max={250}
                step={0.5}
                value={options.mixTempo}
                onChange={(e) => set({ mixTempo: Math.min(250, Math.max(50, Number(e.target.value) || 124)) })}
                data-hint="The mix's tempo in BPM (50–250)"
              />
            )}
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Length</span>
          <input
            className={styles.input}
            type="number"
            min={0}
            max={600}
            placeholder="all"
            value={options.lengthTargetMin ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value);
              setOptions((o) => {
                const { lengthTargetMin: _drop, ...rest } = o;
                void _drop;
                return v > 0 ? { ...rest, lengthTargetMin: Math.min(600, v) } : rest;
              });
            }}
            data-hint="Aim for about this many minutes (songs mix out earlier, by whole phrases). Empty: every song plays through"
          />
        </div>
        <span className={styles.spacer} />
        {st.making ? (
          <button className={styles.button} onClick={stopMaking} data-hint="Stop making the mix">
            Stop
          </button>
        ) : null}
        <button
          className={styles.primary}
          disabled={busy || toMix.length === 0}
          onClick={() => void makeMixFromUi(services, options)}
          data-hint={
            toMix.length === 0
              ? 'Add songs first'
              : `Make a mix of ${toMix.length === st.songs.length ? 'every song' : `the ${toMix.length} selected songs`} on the playlist (one undo step; making it again replaces it)`
          }
        >
          <Icon name="sparkle" size={13} /> Make the mix
        </button>
      </div>
      {st.making && (
        <div className={styles.progress}>
          <span>{st.making.label}</span>
          <div className={styles.meter}>
            <div className={styles.meterFill} style={{ width: `${Math.round(st.making.fraction * 100)}%` }} />
          </div>
        </div>
      )}

      {dj && (
        <div className={styles.transitions}>
          <div className={styles.bar}>
            <span className={styles.label}>Transitions</span>
            <span className={styles.dim}>{dj.songs.length} songs on the playlist</span>
            <span className={styles.spacer} />
            <button className={styles.button} onClick={() => openWindow(services, 'playlist')} data-hint="Show the mix on the playlist">
              <Icon name="playlist" size={13} /> Playlist
            </button>
            <button className={styles.button} onClick={() => void services.commands.run('dj.exportMix')} data-hint="Export the whole mix to a WAV, FLAC or MP3 file">
              Export mix…
            </button>
          </div>
          {!plan && <div className={styles.warning}>The songs of this mix aren’t analyzed in this browser yet: add them to the library to change transitions.</div>}
          {plan?.warnings.map((w) => (
            <div key={w} className={styles.warning}>
              {w}
            </div>
          ))}
          {plan?.transitions.map((t) => {
            const to = t.to;
            const bar = Math.floor(t.start / 3840) + 1;
            const tweak = (patch: { bars?: number; recipe?: TransitionRecipe; riser?: boolean } | null) => {
              try {
                tweakTransition(services, to, patch);
              } catch (e) {
                services.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
              }
            };
            const from = services.doc.getState().project.samples[t.from as never];
            const into = services.doc.getState().project.samples[t.to as never];
            const fa = from && analyzer ? analyzer.peek(from.source.kind === 'embedded' ? from.source.hash : '') : null;
            const ta = into && analyzer ? analyzer.peek(into.source.kind === 'embedded' ? into.source.hash : '') : null;
            return (
              <div key={`${t.from}>${t.to}`} className={styles.transition}>
                <span className={styles.num}>{t.index + 1}</span>
                <span className={styles.transitionNames} data-hint={`${transitionLabel(t, fa, ta)}. Why: ${t.why}`}>
                  {songTitle(t.from)} → {songTitle(t.to)}
                  <span className={styles.artist}>bar {bar}</span>
                </span>
                <select
                  className={styles.select}
                  value={t.bars}
                  onChange={(e) => tweak({ bars: Number(e.target.value) })}
                  data-hint="How long both songs play together (bars); 0 = a cut"
                >
                  {[0, ...LENGTH_CHOICES].map((b) => (
                    <option key={b} value={b}>
                      {b === 0 ? 'Cut' : `${b} bars`}
                    </option>
                  ))}
                </select>
                <select
                  className={styles.select}
                  value={t.recipe}
                  onChange={(e) => tweak({ recipe: e.target.value as TransitionRecipe })}
                  data-hint={RECIPE_CHOICES.find((r) => r.value === t.recipe)?.hint ?? 'How the songs change over'}
                >
                  {RECIPE_CHOICES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <label className={styles.dim} data-hint="A riser sound building into the moment the next song takes over">
                  <input type="checkbox" checked={t.riser} onChange={(e) => tweak({ riser: e.target.checked })} /> Riser
                </label>
                <button
                  className={styles.ghost}
                  onClick={() => {
                    services.view.getState().setMode('song');
                    services.engine.play(Math.max(0, t.start - 2 * 3840));
                  }}
                  data-hint="Play from 2 bars before this transition"
                >
                  <Icon name="play" size={12} />
                </button>
                <button className={styles.ghost} onClick={() => tweak(null)} disabled={!dj.tweaks[t.to]} data-hint="Back to what Studio picked for this transition">
                  Reset
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
