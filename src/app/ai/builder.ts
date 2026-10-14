/**
 * The plugin builder: Claude writes a new instrument or effect as an AGstudio plugin, the dev server
 * checks it (tools/ai/drafts.ts: file names, imports, no network/eval, TypeScript), a hidden test
 * page renders it (it must load, make sound, stay finite and at a sane level), and whatever fails
 * goes back to Claude, at most three times. The musician installs the result with one click.
 */
import { AiError, ClaudeChat, type AiBackend } from '../assistant/claude';
import { BUILDER_PROMPT, BUILDER_SCHEMA, readBuilderAnswer, type BuiltPluginFiles } from './builder-prompt';

export const MAX_FIX_ROUNDS = 3;

export interface PluginSpec {
  name: string;
  kind: 'instrument' | 'effect';
  /** What it should do and sound like, in detail. */
  description: string;
}

/** What the test render found. */
export interface SmokeReport {
  problems: string[];
  /** Loudest sample of the test render (dBFS), null when it didn't render. */
  peakDb: number | null;
}

export interface PluginDraft extends BuiltPluginFiles {
  /** The folder under plugins/ it installs to. */
  folder: string;
  message: string;
  report: SmokeReport | null;
  /** Fix rounds it took (0 = right the first time). */
  rounds: number;
}

export type BuildStage = 'writing' | 'checking' | 'testing' | 'fixing';

export type BuildResult = { ok: true; draft: PluginDraft } | { ok: false; problems: string[]; draft: PluginDraft | null };

async function post<T>(fetchImpl: typeof fetch, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/plugins/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agstudio': '1' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new AiError("Couldn't reach the AGstudio server. Is `npm run dev` running?", 'network');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new DraftRejected(data.error ?? `The server refused the draft (${res.status}).`);
  return data;
}

/** The server refused the files themselves (a bad name, too large…): Claude can fix that too. */
class DraftRejected extends Error {}

export class PluginBuilder {
  private readonly chat: ClaudeChat;

  constructor(
    private readonly deps: {
      fetch: typeof fetch;
      /** Renders the draft in isolation (src/app/ai/smoke.ts in the app). */
      smoke(folder: string): Promise<SmokeReport>;
    },
  ) {
    this.chat = new ClaudeChat(deps.fetch);
  }

  async build(
    spec: PluginSpec,
    opts: {
      model: string;
      backend: AiBackend;
      signal?: AbortSignal;
      progress?(stage: BuildStage, round: number): void;
      /** Ids already taken (built-ins and installed plugins), so a new plugin doesn't replace one by accident. */
      taken?: readonly string[];
    },
  ): Promise<BuildResult> {
    // Every plugin is its own conversation.
    this.chat.reset();
    let text = [
      `<request>\nBuild this ${spec.kind}: ${spec.name}.\n${spec.description}\n</request>`,
      opts.taken?.length ? `<taken-ids>\n${opts.taken.join(', ')}\n</taken-ids>` : '',
    ]
      .filter(Boolean)
      .join('\n');
    let draft: PluginDraft | null = null;
    let problems: string[] = [];
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      opts.progress?.(round === 0 ? 'writing' : 'fixing', round);
      const answer = await this.chat.ask({
        system: BUILDER_PROMPT,
        schema: BUILDER_SCHEMA,
        text,
        model: opts.model,
        backend: opts.backend,
        ...(opts.signal ? { signal: opts.signal } : {}),
        read: readBuilderAnswer,
      });
      opts.progress?.('checking', round);
      let folder = '';
      try {
        const res = await post<{ folder: string; problems: string[] }>(
          this.deps.fetch,
          'draft',
          { id: answer.plugin.id, files: answer.plugin.files },
          opts.signal,
        );
        folder = res.folder;
        problems = res.problems;
      } catch (e) {
        if (!(e instanceof DraftRejected)) throw e;
        problems = [e.message];
      }
      let report: SmokeReport | null = null;
      if (problems.length === 0 && folder) {
        opts.progress?.('testing', round);
        report = await this.deps.smoke(folder);
        problems = report.problems;
      }
      draft = { ...answer.plugin, folder, message: answer.message, report, rounds: round };
      if (problems.length === 0) return { ok: true, draft };
      text = `The checks found problems. Fix all of them and send every file again, complete:\n- ${problems.join('\n- ')}`;
    }
    return { ok: false, problems, draft };
  }
}

/** Moves a checked draft into plugins/ (hot reload then loads it). */
export function installDraft(fetchImpl: typeof fetch, id: string): Promise<{ folder: string; replaced: boolean }> {
  return post(fetchImpl, 'install', { id });
}

export function discardDraft(fetchImpl: typeof fetch, id: string): Promise<{ folder: string }> {
  return post(fetchImpl, 'discard', { id });
}
