import { useState } from 'react';
import { useStore } from 'zustand';
import type { ApprovalMessage, AssistantMessage } from '@app/assistant/assistant';
import type { Services } from '@app/services';
import { showDialog } from '../../controls/Dialog';
import { Icon } from '../../controls/Icon';
import { useHistoryStatus, useServices } from '../../services-context';
import { sharePluginDraft } from '../plugin-manager/flows';
import { shortcutLabel } from '../../shortcut-label';
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
export function Message({ message }: { message: AssistantMessage }) {
  if (message.from === 'you') {
    return (
      <div className={`${styles.message} ${styles.mine}`}>
        <div className={styles.bubble}>{message.text}</div>
        {message.detail && <div className={styles.mineDetail}>{message.detail}</div>}
      </div>
    );
  }
  return <Answer message={message} />;
}

/**
 * Undo of one answer: back to the step before it. Changes made after it are undone too (they were
 * made on top of it), so the musician sees which first; Redo brings everything back.
 */
async function undoAnswer(services: Services, before: number, later: readonly string[]): Promise<void> {
  if (later.length) {
    const shown = later.slice(-6).reverse();
    const choice = await showDialog({
      title: 'Undo this answer?',
      message: `Changes made after it are undone too:\n${shown.map((undoneLabel) => `• ${undoneLabel}`).join('\n')}${later.length > shown.length ? `\n• and ${later.length - shown.length} more` : ''}`,
      detail: `Redo (${shortcutLabel(services, 'edit.redo') ?? 'Edit → Redo'}) brings them all back.`,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'undo', label: later.length === 1 ? 'Undo both' : `Undo all ${later.length + 1}`, primary: true },
      ],
      cancelId: 'cancel',
    });
    if (choice !== 'undo') return;
  }
  services.history.goTo(before);
}

/** The Undo button's tooltip: already undone, or how much undoing this answer takes with it. */
function undoHint(canUndo: boolean, laterCount: number): string {
  if (!canUndo) return 'Already undone (Redo brings it back)';
  if (laterCount === 0) return 'Undo everything this answer did (Redo brings it back)';
  const laterChanges = laterCount === 1 ? 'change' : `${laterCount} changes`;
  return `Undo everything this answer did, and the ${laterChanges} made after it (Redo brings them back)`;
}

function Answer({ message }: { message: AssistantMessage }) {
  const services = useServices();
  const status = useHistoryStatus();
  // (a negative point is one from before a page reload: its step is gone)
  const point = message.undo ?? message.beat?.cursor;
  const undoAt = point !== undefined && point >= 0 ? point : undefined;
  // Still in the history as done (not undone already, not dropped by opening another project).
  const done = undoAt !== undefined && status.canUndo ? services.history.steps().done : [];
  const at = undoAt === undefined ? -1 : done.findIndex((step) => step.id === undoAt);
  const canUndo = at >= 0;
  const later = canUndo ? done.slice(at + 1) : [];
  const hasFooter = !!(message.detail || message.offline || message.beat || undoAt !== undefined);
  return (
    <div className={`${styles.message} ${message.error ? styles.errorMessage : ''}`}>
      <div className={styles.card}>
        <div className={styles.cardText}>
          {!message.error && <Icon name="studio" size={13} className={styles.spark} />}
          {message.text}
        </div>
        {message.findings && message.findings.length > 0 && (
          <Fold items={message.findings} shown={SHOWN_FINDINGS} className={styles.findings} noun="findings" />
        )}
        {message.changes && message.changes.length > 0 && <Changes changes={message.changes} />}
        {message.warnings && message.warnings.length > 0 && <Warnings warnings={message.warnings} />}
        {message.plugin && <PluginCard message={message} />}
        {message.approval && <ApprovalCard id={message.id} approval={message.approval} />}
        {hasFooter && (
          <div className={styles.cardFoot}>
            <span className={styles.detail}>
              {message.offline && <span className={styles.badge}>offline</span>}
              {message.detail}
            </span>
            {message.beat && (
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
                onClick={() => void undoAnswer(services, done[at - 1]?.id ?? 0, later.map((step) => step.label))}
                data-hint={undoHint(canUndo, later.length)}
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
        {changes.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    );
  }
  return (
    <div className={styles.fold}>
      <button
        className={styles.summary}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        data-hint={open ? 'Hide the list of changes' : 'Show every change this answer made'}
      >
        <span className={styles.summaryCount}>{changes.length} changes</span>
        <span className={styles.summaryAction}>{open ? 'Hide' : 'Show'}</span>
        <Icon name="chevronDown" size={10} className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} />
      </button>
      {open && (
        <ul className={styles.changes}>
          {changes.map((line, index) => (
            <li key={index}>{line}</li>
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
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        data-hint={open ? 'Hide the details' : 'What Studio couldn’t do: click for the details'}
      >
        <span className={styles.warningDot} aria-hidden />
        <span className={open ? styles.warningFull : styles.warningText}>
          {open ? `${warnings.length === 1 ? 'Couldn’t do this' : `Couldn’t do ${warnings.length} things`}` : first}
        </span>
        {!open && more > 0 && <span className={styles.warningMore}>+{more}</span>}
      </button>
      {open && (
        <ul className={styles.warningList}>
          {warnings.map((line, index) => (
            <li key={index}>{line}</li>
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
        {visible.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {items.length > shown && (
        <button
          className={styles.more}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
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
function PluginCard({ message }: { message: AssistantMessage }) {
  const services = useServices();
  const plugin = message.plugin!;
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
        {draft.files.map((file) => (
          <div key={file.path}>
            <div className={styles.pluginFile}>{file.path}</div>
            <pre className={styles.pluginPre}>{file.content}</pre>
          </div>
        ))}
      </details>
      <div className={styles.pluginActions}>
        {state === 'draft' && (
          <>
            <button
              className={styles.primaryButton}
              onClick={() => void services.assistant.installPlugin(message.id)}
              data-hint={`Add it to your plugins (plugins/${draft.folder}); it then appears in the browser`}
            >
              Install
            </button>
            <button
              className={styles.ghost}
              onClick={() => void services.assistant.discardPlugin(message.id)}
              data-hint="Throw this draft away"
            >
              Discard
            </button>
          </>
        )}
        {state === 'failed' && (
          <button
            className={styles.ghost}
            onClick={() => void services.assistant.discardPlugin(message.id)}
            data-hint="Throw this draft away (it didn't pass the checks)"
          >
            Discard draft
          </button>
        )}
        {(state === 'draft' || state === 'installed') && (
          <button
            className={styles.ghost}
            onClick={() => void sharePluginDraft(services, { id: draft.id, name: draft.name, kind: draft.kind, files: draft.files })}
            data-hint="Save this plugin as one .agplugin file to send to a friend (they see what it can do before installing it)"
          >
            Share…
          </button>
        )}
        {state === 'installing' && <span className={styles.dim}>Installing…</span>}
        {state === 'installed' && <span className={styles.ok}>Installed ✓ It's in the browser under Plugins.</span>}
        {state === 'discarded' && <span className={styles.dim}>Discarded.</span>}
      </div>
    </div>
  );
}

/** What an approval card says: asking, what was applied, or why it can't be applied any more. */
function approvalHeadline(approval: ApprovalMessage): string {
  switch (approval.state) {
    case 'ask':
      return `This also changes things outside ${approval.part}:`;
    case 'all':
      return `Applied everything, outside ${approval.part} too.`;
    case 'part':
      return `Applied only what stays in ${approval.part}.`;
    case 'expired':
      return 'This can’t be applied any more (you asked something else, or another project is open). Ask again.';
  }
}

/**
 * An answer that also changes things outside the part being worked on: what reaches outside, and the
 * musician's choice (everything, or the part only). Nothing changed until they pick.
 */
function ApprovalCard({ id, approval }: { id: number; approval: ApprovalMessage }) {
  const services = useServices();
  // Choosing waits while Studio is busy with something else.
  const busy = useStore(services.assistant.store, (state) => state.phase !== 'idle');
  return (
    <div className={styles.approval}>
      <div className={styles.approvalHead}>{approvalHeadline(approval)}</div>
      {approval.state === 'ask' && (
        <>
          <Fold items={approval.outside} shown={2} className={styles.approvalList} noun="more" />
          <div className={styles.pluginActions}>
            <button
              className={styles.primaryButton}
              disabled={busy}
              onClick={() => void services.assistant.approve(id, 'all')}
              data-hint="Make every change in the answer, outside the part too (one undo step)"
            >
              Apply everything
            </button>
            <button
              className={styles.ghost}
              disabled={busy}
              onClick={() => void services.assistant.approve(id, 'part')}
              data-hint={`Make only the changes inside ${approval.part}; the rest of the song stays as it is`}
            >
              Only {approval.part}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
