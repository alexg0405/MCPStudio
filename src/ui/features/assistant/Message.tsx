import { useState } from 'react';
import type { AssistantMessage } from '@app/assistant/assistant';
import { Icon } from '../../controls/Icon';
import { useHistoryStatus, useServices } from '../../services-context';
import styles from './Assistant.module.css';

/** Change lists this long or shorter show in full; longer ones fold into a one-line summary. */
const SHOWN_CHANGES = 2;
/** Mix findings are the answer itself: the first few show, the rest behind "Show all". */
const SHOWN_FINDINGS = 4;

/**
 * One message of the AI conversation. The musician's words sit on the right in a soft gold bubble;
 * the AI's answer is a card on the left: its text, what it changed (folded into "12 changes · Show"),
 * what it couldn't do (one amber line), a plugin it built, and small Play / Undo buttons.
 */
export function Message({ m }: { m: AssistantMessage }) {
  if (m.from === 'you') {
    return (
      <div className={`${styles.message} ${styles.mine}`}>
        <div className={styles.bubble}>{m.text}</div>
        {m.detail && <div className={styles.mineDetail}>{m.detail}</div>}
      </div>
    );
  }
  return <Answer m={m} />;
}

function Answer({ m }: { m: AssistantMessage }) {
  const services = useServices();
  const status = useHistoryStatus();
  const undoAt = m.undo ?? m.beat?.cursor;
  const canUndo = undoAt !== undefined && status.cursor === undoAt;
  const hasFooter = !!(m.detail || m.offline || m.beat || undoAt !== undefined);
  return (
    <div className={`${styles.message} ${m.error ? styles.errorMessage : ''}`}>
      <div className={styles.card}>
        <div className={styles.cardText}>
          {!m.error && <Icon name="sparkle" size={12} className={styles.spark} />}
          {m.text}
        </div>
        {m.findings && m.findings.length > 0 && (
          <Fold items={m.findings} shown={SHOWN_FINDINGS} className={styles.findings} noun="findings" />
        )}
        {m.changes && m.changes.length > 0 && <Changes changes={m.changes} />}
        {m.warnings && m.warnings.length > 0 && <Warnings warnings={m.warnings} />}
        {m.plugin && <PluginCard m={m} />}
        {hasFooter && (
          <div className={styles.cardFoot}>
            <span className={styles.detail}>
              {m.offline && <span className={styles.badge}>offline</span>}
              {m.detail}
            </span>
            {m.beat && (
              <button
                className={styles.iconButton}
                onClick={() => {
                  services.view.getState().setMode('pattern');
                  services.engine.play();
                }}
                data-hint="Play this beat (pattern mode)"
                aria-label="Play"
              >
                <Icon name="play" size={11} />
                <span>Play</span>
              </button>
            )}
            {undoAt !== undefined && (
              <button
                className={styles.iconButton}
                disabled={!canUndo}
                onClick={() => services.history.undo()}
                data-hint={
                  canUndo
                    ? 'Undo everything this answer did'
                    : 'Use Undo (Cmd+Z) to step back through later changes first'
                }
                aria-label="Undo"
              >
                <Icon name="undo" size={11} />
                <span>Undo</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** What an answer changed: short lists in full, long ones as "12 changes · Show". */
function Changes({ changes }: { changes: string[] }) {
  const [open, setOpen] = useState(false);
  if (changes.length <= SHOWN_CHANGES) {
    return (
      <ul className={styles.changes}>
        {changes.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    );
  }
  return (
    <div className={styles.fold}>
      <button
        className={styles.summary}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-hint={open ? 'Hide the list of changes' : 'Show every change this answer made'}
      >
        <span className={styles.summaryCount}>{changes.length} changes</span>
        <span className={styles.summaryAction}>{open ? 'Hide' : 'Show'}</span>
        <Icon name="chevronDown" size={10} className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} />
      </button>
      {open && (
        <ul className={styles.changes}>
          {changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the AI couldn't do: one subtle amber line, the details on click. */
function Warnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  const first = warnings[0]!;
  const more = warnings.length - 1;
  return (
    <div className={styles.warning}>
      <button
        className={styles.warningLine}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-hint={open ? 'Hide the details' : 'What the AI couldn’t do: click for the details'}
      >
        <span className={styles.warningDot} aria-hidden />
        <span className={open ? styles.warningFull : styles.warningText}>
          {open ? `${warnings.length === 1 ? 'Couldn’t do this' : `Couldn’t do ${warnings.length} things`}` : first}
        </span>
        {!open && more > 0 && <span className={styles.warningMore}>+{more}</span>}
      </button>
      {open && (
        <ul className={styles.warningList}>
          {warnings.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A list that shows its first `shown` items and the rest behind "Show all N". */
function Fold({ items, shown, className, noun }: { items: string[]; shown: number; className?: string; noun: string }) {
  const [open, setOpen] = useState(false);
  const visible = open ? items : items.slice(0, shown);
  return (
    <div className={styles.fold}>
      <ul className={`${styles.changes} ${className ?? ''}`}>
        {visible.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
      {items.length > shown && (
        <button
          className={styles.more}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-hint={open ? `Show only the first ${shown}` : `Show all ${items.length} ${noun}`}
        >
          {open ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/** A plugin the builder wrote: what it is, what the checks said, its code, Install and Discard. */
function PluginCard({ m }: { m: AssistantMessage }) {
  const services = useServices();
  const plugin = m.plugin!;
  const { draft, state } = plugin;
  return (
    <div className={styles.pluginCard}>
      <div className={styles.pluginHead}>
        <Icon name="plug" size={14} />
        <b>{draft.name}</b>
        <span className={styles.dim}>
          {draft.kind} · {draft.id}
        </span>
      </div>
      <details className={styles.pluginCode}>
        <summary data-hint="Show the plugin's source files">
          View the code ({draft.files.length} file{draft.files.length === 1 ? '' : 's'})
        </summary>
        {draft.files.map((f) => (
          <div key={f.path}>
            <div className={styles.pluginFile}>{f.path}</div>
            <pre className={styles.pluginPre}>{f.content}</pre>
          </div>
        ))}
      </details>
      <div className={styles.pluginActions}>
        {state === 'draft' && (
          <>
            <button
              className={styles.primaryButton}
              onClick={() => void services.assistant.installPlugin(m.id)}
              data-hint={`Add it to your plugins (plugins/${draft.folder}); it then appears in the browser`}
            >
              Install
            </button>
            <button
              className={styles.ghost}
              onClick={() => void services.assistant.discardPlugin(m.id)}
              data-hint="Throw this draft away"
            >
              Discard
            </button>
          </>
        )}
        {state === 'failed' && (
          <button
            className={styles.ghost}
            onClick={() => void services.assistant.discardPlugin(m.id)}
            data-hint="Throw this draft away (it didn't pass the checks)"
          >
            Discard draft
          </button>
        )}
        {state === 'installing' && <span className={styles.dim}>Installing…</span>}
        {state === 'installed' && <span className={styles.ok}>Installed ✓ It's in the browser under Plugins.</span>}
        {state === 'discarded' && <span className={styles.dim}>Discarded.</span>}
      </div>
    </div>
  );
}
