import { describe, expect, it } from 'vitest';
import { PluginBuilder } from './ai/builder';
import { ClaudeBeatChat, fetchAiStatus } from './assistant/claude';
import { AI_SERVER_MISSING, devServerMissing } from './local-server';
import { createPlugin } from './plugins/new-plugin';

/**
 * The installed app can start with no server behind it, or with only the production server (`agstudio --app`): every
 * feature that lives in a server says so and says what to run, instead of failing obscurely.
 */
const down = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof fetch;
const notThere = (async () => new Response('Not found', { status: 404 })) as typeof fetch;

describe('features that need the local server', () => {
  it('say what to run', () => {
    expect(AI_SERVER_MISSING).toMatch(/needs AGstudio's local server.*`agstudio --app`/);
    expect(devServerMissing('Creating plugins')).toMatch(/^Creating plugins needs AGstudio's dev server: run `agstudio`/);
  });

  it('the AI studio: no server is a plain message, not a stack trace', async () => {
    const status = await fetchAiStatus(down);
    for (const backend of Object.values(status)) {
      expect(backend.ok).toBe(false);
      expect(backend.reason).toMatch(/`agstudio --app`/);
    }
    await expect(
      new ClaudeBeatChat(down).request({ prompt: 'a beat', project: '{}', model: 'm', backend: 'subscription' }),
    ).rejects.toMatchObject({ kind: 'network', message: AI_SERVER_MISSING });
  });

  it('the plugin builder: neither a missing server nor the production server (404) is obscure', async () => {
    const smoke = async () => ({ problems: [], peakDb: null });
    for (const fetchImpl of [down, notThere]) {
      // The draft is posted to /api/plugins/draft; the AI turn before it is answered by a stand-in.
      const answering = (async (url: string, init?: RequestInit) =>
        url === '/api/ai/chat'
          ? new Response(
              JSON.stringify({
                session: 's',
                model: 'm',
                beat: { message: 'ok', plugin: { id: 'user.x', name: 'X', kind: 'effect', files: [{ path: 'index.ts', content: 'x' }] } },
              }),
              { status: 200 },
            )
          : fetchImpl(url, init)) as typeof fetch;
      const builder = new PluginBuilder({ fetch: answering, smoke });
      await expect(
        builder.build({ name: 'X', kind: 'effect', description: 'x' }, { model: 'm', backend: 'subscription', progress: () => {} }),
      ).rejects.toMatchObject({ kind: 'network', message: devServerMissing('The plugin builder') });
    }
  });

  it('new plugins: says the dev server is needed', async () => {
    for (const fetchImpl of [down, notThere])
      expect(await createPlugin({ kind: 'effect', style: 'graph', name: 'X' }, fetchImpl)).toEqual({
        error: devServerMissing('Creating plugins'),
      });
  });
});
