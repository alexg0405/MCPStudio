import { describe, expect, it } from 'vitest';
import { clientLabel } from './common';
import { claudeCodeCommand, claudeDesktopConfig, endpointOf, maskToken, statusLine, urlClientConfig } from './setup';

const token = 'agmcp_' + 'a'.repeat(43);

describe('setup lines', () => {
  it('is the Claude Code command', () => {
    expect(claudeCodeCommand('http://localhost:5390', token)).toBe(
      `claude mcp add --transport http agstudio http://localhost:5390/mcp --header "Authorization: Bearer ${token}"`,
    );
    expect(endpointOf('http://localhost:5390/')).toBe('http://localhost:5390/mcp');
  });

  it('runs the stdio helper for Claude Desktop, without the token in the file', () => {
    const config = JSON.parse(claudeDesktopConfig('http://localhost:5415', '/Users/me/AGstudio/')) as {
      mcpServers: { agstudio: { command: string; env: Record<string, string> } };
    };
    expect(config.mcpServers.agstudio).toEqual({ command: '/Users/me/AGstudio/bin/agstudio-mcp', env: { AGSTUDIO_URL: 'http://localhost:5415' } });
    expect(claudeDesktopConfig('http://localhost:5415', '/x')).not.toContain('agmcp_');
  });

  it('gives a URL and header for apps that take them', () => {
    expect(JSON.parse(urlClientConfig('http://localhost:5390', token))).toEqual({
      mcpServers: { agstudio: { type: 'http', url: 'http://localhost:5390/mcp', headers: { Authorization: `Bearer ${token}` } } },
    });
  });

  it('shows enough of a token to recognize it, not to use it', () => {
    expect(maskToken(token)).toBe('agmcp_aaaa…');
    expect(maskToken(token)).not.toContain(token);
  });

  it('reads "Connected: Claude Code · 3 calls in the last minute"', () => {
    const status = (n: number) => ({ clients: [{ name: 'claude-code', lastSeen: 1 }], callsLastMinute: n, tabs: 1 });
    expect(statusLine(status(3), (n) => clientLabel({ name: n }))).toBe('Connected: Claude Code · 3 calls in the last minute');
    expect(statusLine(status(1), (n) => clientLabel({ name: n }))).toBe('Connected: Claude Code · 1 call in the last minute');
    expect(statusLine(status(0), (n) => clientLabel({ name: n }))).toBe('Connected: Claude Code · no calls in the last minute');
    expect(statusLine({ clients: [], callsLastMinute: 0, tabs: 1 }, String)).toMatch(/^No AI app has connected yet/);
  });
});
