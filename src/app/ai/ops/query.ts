/**
 * `query`: Studio looks before it acts. It names a read tool (`app/ai/read.ts`) and gets the result with
 * the request again, in the next turn. Nothing changes: no undo step. The tools are the same ones the MCP
 * server offers.
 */
import type { Services } from '../../services';
import { readTools, runReadTool } from '../read';
import type { AiAnswer } from '../schema';
import * as S from '../schema/parts';
import type { AnswerState, OpModule } from './context';
import { isObj, str } from './values';

/** Most look-ups one answer may ask for. */
export const MAX_QUERIES = 4;

const toolLine = (t: (typeof readTools)[number]) => {
  const args = Object.keys(t.schema.properties).join(', ');
  const brief = t.description.split(/\.\s/)[0]!.replace(/\.$/, '');
  return `- ${t.name}${args ? ` {${args}}` : ''}: ${brief}`;
};

export const query: OpModule = {
  schemas: [
    S.op(
      'query',
      'Looks at the project before you act: runs a read tool and you get its result with the request again. Use it alone (message such as "Let me look…") when you need what the project summary leaves out: every note of a pattern, one channel’s settings, the whole mixer, automation curves.',
      {
        tool: { type: 'string', enum: readTools.map((t) => t.name) },
        args_json: S.str('The tool’s arguments as a JSON object, e.g. {"pattern":"Drop","channel":"Kick"}; {} for none.'),
      },
      ['tool'],
    ),
  ],
  prompt: {
    id: 'query',
    order: 41,
    text: `Looking things up (query action, alone in an answer; the result comes back with the request, then answer for real). Read tools:\n${readTools.map(toolLine).join('\n')}`,
  },
  handlers: {},
};

/** Runs the answer's look-ups (after its edits), for the next turn. */
export function queryAfter(s: Services, answer: AiAnswer, state: AnswerState): void {
  let n = 0;
  for (const a of answer.actions) {
    if (a.op !== 'query') continue;
    const tool = str(a.tool) ?? '';
    if (++n > MAX_QUERIES) {
      state.warnings.push(`query: only ${MAX_QUERIES} look-ups at a time`);
      break;
    }
    let args: Record<string, unknown> = {};
    const text = str(a.args_json);
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!isObj(parsed)) throw new Error('not an object');
        args = parsed;
      } catch {
        state.warnings.push(`query: args_json must be a JSON object (got ${text.slice(0, 40)})`);
        continue;
      }
    }
    if (!readTools.some((t) => t.name === tool)) {
      state.warnings.push(`query: there is no read tool "${tool}"`);
      continue;
    }
    state.queries.push({ tool, args, result: runReadTool(s, tool, args) });
  }
}
