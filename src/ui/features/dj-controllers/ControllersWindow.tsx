import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { djControllers, pickMappingFile, saveMappingFile } from '@app/dj/controllers';
import type { DecksApi } from '@app/dj/decks-api';
import { CONTROLLER_PRESETS, presetById } from '@core/midi-map/presets';
import { REL_ENCODING_LABEL } from '@core/midi-map/relative';
import type { TargetInfo } from '@core/midi-map/targets';
import type { Binding } from '@core/midi-map/types';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import styles from './Controllers.module.css';
import { chipText, groupedTargets, NO_DECKS_TEXT, NO_DEVICE_TEXT, rowLabel, SECTIONS, TEST_EMPTY, type Section } from './view';

/** The DJ controllers window: connect a controller, link its controls to the decks (MIDI learn), watch what it sends. */
export function ControllersWindow() {
  const services = useServices();
  const dj = djControllers(services);
  const st = useStore(dj.store);
  const [tab, setTab] = useState<'controls' | 'test'>('controls');
  const [section, setSection] = useState<Section>('A');
  const device = st.selected;
  const mapping = device ? (st.mappings[device] ?? null) : null;
  const info = st.devices.find((d) => d.name === device) ?? null;
  const preset = info?.preset ? presetById(info.preset) : null;
  const learning = st.learn;

  const learnRow = (t: TargetInfo | 'shift', shifted = false) => dj.learnTarget(t === 'shift' ? 'shift' : t.id, shifted);

  return (
    <div className={styles.root} data-tour="dj-controllers">
      <div className={styles.bar}>
        <span className={styles.label}>Controller</span>
        {st.access === 'ready' ? (
          st.devices.length > 0 ? (
            <select
              className={styles.select}
              value={device ?? ''}
              onChange={(e) => dj.select(e.target.value)}
              aria-label="Controller"
              data-hint="Which connected MIDI controller you are looking at"
            >
              {st.devices.map((d) => (
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
            disabled={st.access === 'asking' || st.access === 'unsupported'}
            data-hint="Asks the browser for MIDI access, then listens to your DJ controller and lights its buttons"
          >
            <Icon name="midi" size={14} /> Connect controllers
          </button>
        )}
        {st.access === 'ready' && (
          <button className={styles.small} onClick={() => dj.disable()} data-hint="Stop listening to controllers (their lights go out)">
            Disconnect
          </button>
        )}
        <span className={styles.spacer} />
        {info && <span className={styles.dim} data-hint={info.hasOutput ? 'The controller’s lights follow the decks' : 'This controller has no MIDI output we can open, so its lights stay as they are'}>{info.hasOutput ? 'Lights on' : 'No lights'}</span>}
        {st.access === 'ready' && (
          <button
            className={learning ? styles.on : styles.button}
            onClick={() => (learning ? dj.cancelLearn() : dj.startLearn())}
            disabled={!device}
            data-hint="Link controls: click a control in the list below (or on a deck), then move or press it on your controller"
          >
            {learning ? 'Done' : 'Learn controls'}
          </button>
        )}
      </div>

      {learning && (
        <div className={styles.learn} role="status">
          <Icon name="midi" size={16} />
          <span className={styles.learnText}>{learning.message}</span>
          {learning.target && (
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
      )}

      {st.access !== 'ready' ? (
        <div className={styles.empty}>
          <Icon name="midi" size={28} />
          <div className={styles.emptyTitle}>
            {st.access === 'denied' ? 'MIDI is blocked' : st.access === 'unsupported' ? 'This browser has no MIDI' : 'Use a DJ controller'}
          </div>
          <div className={styles.emptyText}>
            {st.access === 'denied'
              ? 'Allow MIDI for this site (the lock icon in the address bar), then press Connect again.'
              : st.access === 'unsupported'
                ? 'Web MIDI works in Chrome and Edge.'
                : NO_DEVICE_TEXT}
          </div>
        </div>
      ) : !device || !mapping ? (
        <div className={styles.empty}>
          <Icon name="plug" size={28} />
          <div className={styles.emptyTitle}>No controller found</div>
          <div className={styles.emptyText}>Plug in your controller (it appears here by itself), or check that no other program holds it.</div>
        </div>
      ) : (
        <>
          <div className={styles.bar}>
            <div className={styles.seg} role="tablist" aria-label="View">
              <button role="tab" aria-selected={tab === 'controls'} className={tab === 'controls' ? styles.segOn : styles.segItem} onClick={() => setTab('controls')} data-hint="The controls of the decks and the mixer, and which control of your controller drives each">
                Controls
              </button>
              <button role="tab" aria-selected={tab === 'test'} className={tab === 'test' ? styles.segOn : styles.segItem} onClick={() => setTab('test')} data-hint="Watch the messages your controller sends, and what they did">
                Test
              </button>
            </div>
            {tab === 'controls' && (
              <div className={styles.seg} role="radiogroup" aria-label="Section">
                {SECTIONS.map((s) => (
                  <button key={s.id} role="radio" aria-checked={section === s.id} className={section === s.id ? styles.segOn : styles.segItem} onClick={() => setSection(s.id)} data-hint={`Show the controls of ${s.label}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <span className={styles.spacer} />
            <BrowseLine />
          </div>

          {st.decks === 'missing' && <div className={styles.note}>{NO_DECKS_TEXT}</div>}
          {st.fakeDecks && (
            <div className={styles.note}>The live decks are not wired in yet, so controls drive a stand-in deck (shown in the Test tab). This message goes away once they are.</div>
          )}

          {tab === 'controls' ? (
            <div className={styles.body}>
              <div className={styles.note}>
                {preset ? (
                  <>
                    Ready-made map for {preset.name}. {preset.notes} Source: {preset.source}.
                  </>
                ) : mapping.bindings.length ? (
                  <>Your own map for {device}: {mapping.bindings.length} controls linked.</>
                ) : (
                  <>No ready-made map for {device}. Press “Learn controls”, click a control below, then move or press it on your controller.</>
                )}
              </div>
              <div className={styles.group}>Shift key</div>
              <ShiftRow onLearn={() => learnRow('shift')} learningTarget={learning?.target ?? null} />
              {groupedTargets(section).map((g) => (
                <div key={g.group}>
                  <div className={styles.group}>{g.group}</div>
                  {g.targets.map((t) => (
                    <TargetRow key={t.id} t={t} device={device} learning={learning?.target === t.id} learnOn={!!learning} onLearn={(shifted) => learnRow(t, shifted)} />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <TestView />
          )}

          <div className={styles.footer}>
            <label className={styles.check} data-hint="Faders and knobs wait until they reach the value on screen, so nothing jumps when you touch one that is somewhere else">
              <input type="checkbox" checked={mapping.softTakeover} onChange={(e) => dj.setOptions(device, { softTakeover: e.target.checked })} />
              Pick up values (no jumps)
            </label>
            <label className={styles.check} data-hint="Light a button’s own light at the note it sends (for learned controllers; ready-made maps list their lights)">
              <input type="checkbox" checked={mapping.ledFromButtons} onChange={(e) => dj.setOptions(device, { ledFromButtons: e.target.checked })} />
              Lights at button notes
            </label>
            <span className={styles.spacer} />
            <select
              className={styles.select}
              value=""
              onChange={(e) => {
                if (e.target.value) dj.usePreset(device, e.target.value);
              }}
              aria-label="Use a ready-made map"
              data-hint="Replace this controller’s links with a ready-made map"
            >
              <option value="">Use a ready-made map…</option>
              {CONTROLLER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className={styles.small}
              onClick={() => saveMappingFile(device, dj.exportJson(device))}
              data-hint="Save this controller’s links as a file you can share or keep"
            >
              Export…
            </button>
            <button
              className={styles.small}
              onClick={() =>
                void pickMappingFile().then((text) => {
                  if (text === null) return;
                  const r = dj.importJson(device, text);
                  services.session
                    .getState()
                    .toast(
                      r ? `Imported ${r.bindings} links${r.dropped ? ` (${r.dropped} entries were not understood and skipped)` : ''}.` : 'That file is not a controller map.',
                      r ? 'info' : 'error',
                    );
                })
              }
              data-hint="Load links from a controller map file (replaces the current ones)"
            >
              Import…
            </button>
            <button className={styles.small} onClick={() => dj.resetMapping(device)} data-hint={preset ? 'Go back to the ready-made map' : 'Remove every link'}>
              {preset ? 'Reset' : 'Clear all'}
            </button>
            {preset && (
              <button className={styles.small} onClick={() => dj.clearMapping(device)} data-hint="Remove every link, to learn from scratch">
                Clear all
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The song the browse encoder has highlighted. */
function BrowseLine() {
  const services = useServices();
  const dj = djControllers(services);
  const index = useStore(dj.browse.store, (s) => s.index);
  const song = dj.browse.current();
  void index;
  return (
    <span className={styles.dim} data-hint="The song the browse encoder points at: press a deck’s load button to put it on that deck">
      Library highlight: {song ? song.label : 'the music library is empty'}
    </span>
  );
}

function ShiftRow({ onLearn, learningTarget }: { onLearn(): void; learningTarget: string | null }) {
  const services = useServices();
  const dj = djControllers(services);
  const device = useStore(dj.store, (s) => s.selected);
  const shifts = useStore(dj.store, (s) => (device ? (s.mappings[device]?.shifts ?? []) : []));
  return (
    <div className={learningTarget === 'shift' ? styles.rowLearning : styles.row}>
      <span className={styles.rowName} data-hint="The button that changes what other buttons do while you hold it">
        Shift button
      </span>
      <span className={styles.chips}>
        {shifts.length ? shifts.map((s, i) => <span key={i} className={styles.chip}>{chipText({ input: s.input, target: 'shift' })}</span>) : <span className={styles.unmapped}>not linked (only needed for “with Shift” controls)</span>}
      </span>
      <button className={styles.small} onClick={onLearn} data-hint="Click, then press your controller’s Shift button">
        Learn
      </button>
    </div>
  );
}

function TargetRow({ t, device, learning, learnOn, onLearn }: { t: TargetInfo; device: string; learning: boolean; learnOn: boolean; onLearn(shifted: boolean): void }) {
  const services = useServices();
  const dj = djControllers(services);
  const mapping = useStore(dj.store, (s) => s.mappings[device]);
  const bound = (mapping?.bindings ?? []).flatMap((binding, index) => (binding.target === t.id ? [{ binding, index }] : []));
  const hasShift = (mapping?.shifts.length ?? 0) > 0;
  const chipMenu = (e: React.MouseEvent, binding: Binding, index: number) => {
    const items: MenuEntry[] = [];
    if (binding.input.type === 'rel')
      items.push({ kind: 'label', label: REL_ENCODING_LABEL[binding.input.encoding] });
    if (t.kind !== 'button' && binding.input.type !== 'note')
      items.push({ label: 'Reverse the direction', checked: !!binding.invert, onSelect: () => dj.updateBinding(device, index, { invert: !binding.invert }) });
    if (binding.input.type === 'rel')
      for (const s of [0.5, 1, 2, 4])
        items.push({ label: `Speed ×${s}`, checked: (binding.scale ?? 1) === s, onSelect: () => dj.updateBinding(device, index, { scale: s }) });
    items.push({ kind: 'separator' }, { label: 'Remove this link', danger: true, onSelect: () => dj.removeBinding(device, index) });
    showContextMenu(e, items);
  };
  return (
    <div
      className={learning ? styles.rowLearning : styles.row}
      data-dj-target={t.id}
      onClick={() => learnOn && !learning && onLearn(false)}
      data-hint={`${t.hint}. ${learnOn ? 'Click to link it to a control.' : ''}`}
    >
      <span className={styles.rowName}>{rowLabel(t)}</span>
      <span className={styles.chips}>
        {bound.length ? (
          bound.map(({ binding, index }) => (
            <button
              key={index}
              className={styles.chip}
              onClick={(e) => {
                e.stopPropagation();
                chipMenu(e, binding, index);
              }}
              data-hint="A control linked to this. Click for options (reverse, speed, remove)"
            >
              {chipText(binding)}
            </button>
          ))
        ) : (
          <span className={styles.unmapped}>not linked</span>
        )}
      </span>
      <button
        className={styles.small}
        onClick={(e) => {
          e.stopPropagation();
          onLearn(false);
        }}
        data-hint={`Click, then ${t.kind === 'abs' ? 'move the fader or knob' : t.kind === 'rel' ? 'turn the wheel or dial' : 'press the button'} on your controller`}
      >
        Learn
      </button>
      <button
        className={styles.small}
        onClick={(e) => {
          e.stopPropagation();
          onLearn(true);
        }}
        disabled={!hasShift}
        data-hint={hasShift ? 'Learn what this control does while the Shift button is held' : 'Link the Shift button first (the “Shift button” row)'}
      >
        + Shift
      </button>
      <button
        className={styles.small}
        onClick={(e) => {
          e.stopPropagation();
          dj.clearTarget(device, t.id);
        }}
        disabled={!bound.length}
        data-hint="Remove the links of this control"
      >
        Clear
      </button>
    </div>
  );
}

/** Incoming messages and what they did, plus a peek at the decks. */
function TestView() {
  const services = useServices();
  const dj = djControllers(services);
  const log = useStore(dj.monitor, (s) => s.log);
  useEffect(() => dj.watch(), [dj]);
  return (
    <div className={styles.body}>
      <DecksPeek />
      <div className={styles.bar}>
        <span className={styles.dim}>{log.length ? `Last ${log.length} messages` : ''}</span>
        <span className={styles.spacer} />
        <button className={styles.small} onClick={() => dj.clearLog()} disabled={!log.length} data-hint="Empty the list">
          Clear
        </button>
      </div>
      {log.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyText}>{TEST_EMPTY}</div>
        </div>
      ) : (
        <div className={styles.log}>
          {log.map((l) => (
            <div key={l.n} className={styles.logRow}>
              <span>{l.text}</span>
              <span className={l.did === 'Not mapped' ? styles.logNone : styles.logDid}>→ {l.did}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DecksPeek() {
  const services = useServices();
  const dj = djControllers(services);
  const status = useStore(dj.store, (s) => s.decks);
  const decks = dj.liveDecks;
  return status === 'ready' && decks ? <DecksPeekInner decks={decks} /> : null;
}

function DecksPeekInner({ decks }: { decks: DecksApi }) {
  const state = useStore(decks.store);
  return (
    <div className={styles.state}>
      {(['A', 'B'] as const).map((id) => {
        const d = state.decks[id];
        return (
          <span key={id}>
            Deck {id}: {d.playing ? 'playing' : 'paused'}
            {d.song ? ` · ${d.song.title}` : ' · empty'} · volume {Math.round(d.volume * 100)}% · pitch {(d.pitch * 100).toFixed(1)}%
          </span>
        );
      })}
      <span>Crossfader {Math.round(state.crossfader * 100)}%</span>
    </div>
  );
}
