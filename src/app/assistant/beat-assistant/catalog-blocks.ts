/**
 * What a turn tells the AI about the catalog. The system prompt carries the catalog index (a table of contents), so a turn
 * only adds:
 *  - `<details>`: the settings, ranges, presets and command arguments of the plugins and commands the request most likely
 *    needs (`predict.ts`), left out for anything this conversation already has;
 *  - `<catalog-changes>`: when plugins or commands were installed or removed since the conversation began, the lines that
 *    changed (its system prompt is the one it started with), or the whole new index when that is shorter or when only the
 *    version is known (after a page reload).
 *
 * What was sent is only remembered once the answer has come back (`commit`), so a request that failed is told again.
 */
import { detailsText, itemDetails, type ItemDetails } from '../../ai/catalog-details';
import { catalogIndex, diffIndex, itemKey, type CatalogIndex, type IndexLines } from '../../ai/catalog-index';
import type { ResolvedFocus } from '../../ai/focus';
import { predictItems } from '../../ai/predict';
import type { AiBackend } from '../claude';
import type { AssistantSession } from './session';

/** What one backend's conversation has been told about the catalog. */
export interface KnownCatalog {
  /** The index version its system prompt (or the last change it was sent) has. */
  version: string;
  /** The index lines behind that version; null after a reload, when only the version was saved. */
  lines: IndexLines | null;
  /** The details already sent: item key to the key of the details text. */
  details: Map<string, string>;
}

/** The blocks to add to a turn, and the call that records they were sent. */
export interface CatalogBlocks {
  blocks: string[];
  commit(): void;
}

/** A diff that touches more than this share of the index is sent as the whole new index instead. */
const WHOLE_INDEX_SHARE = 0.4;

/** "instrument:user.synth" becomes "user.synth (instrument)". */
const describeKey = (key: string): string => {
  const colon = key.indexOf(':');
  return `${key.slice(colon + 1)} (${key.slice(0, colon)})`;
};

/** The `<catalog-changes>` block, or the whole index when that is the better way to say it. */
function changeBlock(known: KnownCatalog, index: CatalogIndex): string {
  const change = known.lines ? diffIndex(known.lines, index.lines) : null;
  const touched = change ? change.added.length + change.changed.length + change.removed.length : Infinity;
  if (!change || touched > index.lines.size * WHOLE_INDEX_SHARE) {
    return `<catalog-changes>\nPlugins or commands were installed or removed since this conversation began. This index replaces the one in the system prompt:\n${index.text}\n</catalog-changes>`;
  }
  const lines = [
    `Plugins or commands were installed, changed or removed since this conversation began (the index is now v${index.version}). Use these lines with the index in the system prompt:`,
    ...(change.added.length ? ['added:', ...change.added.map((line) => `  ${line}`)] : []),
    ...(change.changed.length ? ['changed (replaces the old line):', ...change.changed.map((line) => `  ${line}`)] : []),
    ...(change.removed.length ? [`removed: ${change.removed.map(describeKey).join(', ')}`] : []),
  ];
  return `<catalog-changes>\n${lines.join('\n')}\n</catalog-changes>`;
}

/** The details of what the request needs, without the ones this conversation already has. */
function freshDetails(session: AssistantSession, known: KnownCatalog, request: string, focus: ResolvedFocus | null): ItemDetails[] {
  const { services } = session;
  const guessed = predictItems(services, { request, focus });
  return guessed
    .map((item) => itemDetails(item, services.presets))
    .filter((details) => known.details.get(itemKey(details.item)) !== details.key);
}

/**
 * The catalog blocks of this turn for `route`'s conversation. A new conversation (no history yet) starts from the current
 * index, which its system prompt has; a continuing one is told what changed since.
 */
export function catalogBlocks(
  session: AssistantSession,
  input: { route: AiBackend; request: string; focus: ResolvedFocus | null },
): CatalogBlocks {
  const { route, request, focus } = input;
  const index = catalogIndex(session.services);
  const isContinuing = session.chat.hasHistoryFor(route);
  const saved = session.catalogKnown[route];
  const known: KnownCatalog = isContinuing
    ? (saved ?? { version: session.catalogSent[route] ?? '', lines: null, details: new Map() })
    : { version: index.version, lines: index.lines, details: new Map() };

  const blocks: string[] = [];
  const hasChanged = isContinuing && known.version !== index.version;
  if (hasChanged) blocks.push(changeBlock(known, index));
  const details = freshDetails(session, known, request, focus);
  if (details.length) blocks.push(`<details>\n${detailsText(details)}\n</details>`);

  return {
    blocks,
    commit() {
      const next: KnownCatalog = {
        version: index.version,
        lines: index.lines,
        details: new Map(known.details),
      };
      for (const d of details) next.details.set(itemKey(d.item), d.key);
      session.catalogKnown[route] = next;
      session.catalogSent[route] = index.version;
    },
  };
}
