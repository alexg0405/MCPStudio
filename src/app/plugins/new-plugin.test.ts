import { describe, expect, it } from 'vitest';
import { createPlugin, pluginIdFor, pluginSourceFile } from './new-plugin';

describe('new plugins', () => {
  it('makes a valid id from any name', () => {
    expect(pluginIdFor('Tape Stop')).toBe('user.tape-stop');
    expect(pluginIdFor('  My 808!! ')).toBe('user.my-808');
    expect(pluginIdFor('9 Lives')).toBe('user.lives');
    expect(pluginIdFor('X')).toBe('user.plugin-x');
    expect(pluginIdFor('???')).toBe('user.plugin-new');
    expect(pluginIdFor('a'.repeat(60))).toMatch(/^user\.[a-z][a-z0-9-]{1,40}$/);
  });

  it('asks the dev server and says plainly when it isn’t there', async () => {
    const posted: unknown[] = [];
    const ok = (async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ folder: 'tape-stop', main: 'plugins/tape-stop/dsp.worklet.ts' }), { status: 200 });
    }) as typeof fetch;
    expect(await createPlugin({ kind: 'effect', style: 'worklet', name: 'Tape Stop' }, ok)).toEqual({
      id: 'user.tape-stop',
      folder: 'tape-stop',
      main: 'plugins/tape-stop/dsp.worklet.ts',
    });
    expect(posted[0]).toEqual({ id: 'user.tape-stop', name: 'Tape Stop', kind: 'effect', style: 'worklet' });
    const missing = (async () => new Response('', { status: 404 })) as typeof fetch;
    expect(await createPlugin({ kind: 'effect', style: 'graph', name: 'X' }, missing)).toEqual({
      error: expect.stringMatching(/npm run dev/),
    });
    const taken = (async () => new Response(JSON.stringify({ error: 'There already is a plugin folder plugins/x.' }), { status: 409 })) as typeof fetch;
    expect(await createPlugin({ kind: 'effect', style: 'graph', name: 'X' }, taken)).toEqual({
      error: 'There already is a plugin folder plugins/x.',
    });
  });

  it('finds a user plugin’s source file from its module path', () => {
    expect(pluginSourceFile('/plugins/tape-stop/index.ts')).toBe('plugins/tape-stop/index.ts');
    expect(pluginSourceFile('/plugins/tape-stop/index.ts?t=123')).toBe('plugins/tape-stop/index.ts');
    expect(pluginSourceFile('/src/plugins/builtin/eq/index.ts')).toBeNull();
  });
});
