import type { AssistantMessage } from '@app/assistant/assistant';
import { Icon } from '../../controls/Icon';
import { useHistoryStatus, useServices } from '../../services-context';
import styles from './Assistant.module.css';

/** One message of the AI conversation: the text, what it changed or couldn't do, a plugin it built, Undo. */
export function Message({ m }: { m: AssistantMessage }) {
  const services = useServices();
  const status = useHistoryStatus();
  const undoAt = m.undo ?? m.beat?.cursor;
  const canUndo = undoAt !== undefined && status.cursor === undoAt;
  return (
    <div className={`${styles.message} ${m.from === 'you' ? styles.mine : ''} ${m.error ? styles.errorMessage : ''}`}>
      <div className={styles.bubble}>
        {m.from === 'assistant' && !m.error && <Icon name="sparkle" size={12} className={styles.spark} />}
        {m.text}
      </div>
      {m.changes && m.changes.length > 0 && (
        <ul className={styles.changes}>
          {m.changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {m.findings && m.findings.length > 0 && (
        <ul className={`${styles.changes} ${styles.findings}`}>
          {m.findings.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {m.warnings && m.warnings.length > 0 && (
        <ul className={`${styles.changes} ${styles.warnings}`}>
          {m.warnings.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {m.plugin && <PluginCard m={m} />}
      {(m.detail || m.offline || m.beat || undoAt !== undefined) && (
        <div className={styles.detail}>
          {m.detail}
          {m.offline && <span className={styles.badge}>offline</span>}
          {m.beat && (
            <button
              className={styles.link}
              onClick={() => {
                services.view.getState().setMode('pattern');
                services.engine.play();
              }}
            >
              Play
            </button>
          )}
          {undoAt !== undefined && (
            <button
              className={styles.link}
              disabled={!canUndo}
              onClick={() => services.history.undo()}
              data-hint={
                canUndo
                  ? 'Undo everything this answer did'
                  : 'Use Undo (Cmd+Z) to step back through later changes first'
              }
            >
              Undo
            </button>
          )}
        </div>
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
              className={styles.link}
              onClick={() => void services.assistant.discardPlugin(m.id)}
              data-hint="Throw this draft away"
            >
              Discard
            </button>
          </>
        )}
        {state === 'failed' && (
          <button
            className={styles.link}
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
