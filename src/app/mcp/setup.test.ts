import { describe, expect, it } from 'vitest';
import { clientLabel } from './common';
import {
  claudeCodeCommand,
  claudeDesktopConfig,
  claudeDesktopConfigPath,
  endpointOf,
  hostPlatformOf,
  maskToken,
  statusLine,
  urlClientConfig,
} from './setup';

const token = 'agmcp_' + 'a'.repeat(43);

describe('setup lines', () => {
  it('is the Claude Code command', () => {
    expect(claudeCodeCommand('http://localhost:5390', token)).toBe(
      `claude mcp add --transport http agstudio http://localhost:5390/mcp --header "Authorization: Bearer ${token}"`,
    );
    expect(endpointOf('http://localhost:5390/')).toBe('http://localhost:5390/mcp');
  });

  it('runs the stdio helper for Claude Desktop, without the token in the file', () => {
    const config = JSON.parse(claudeDesktopConfig('http://localhost:5415', '/Users/me/AGstudio/', 'darwin')) as {
      mcpServers: { agstudio: { command: string; env: Record<string, string> } };
    };
    expect(config.mcpServers.agstudio).toEqual({ command: '/Users/me/AGstudio/bin/agstudio-mcp', env: { AGSTUDIO_URL: 'http://localhost:5415' } });
    expect(claudeDesktopConfig('http://localhost:5415', '/x', 'linux')).not.toContain('agmcp_');
  });

  describe('on Windows', () => {
    it('points Claude Desktop at the .cmd launcher, with backslashes, whichever way the folder was written', () => {
      for (const root of ['C:\\Users\\Ana Smith\\AGstudio', 'C:/Users/Ana Smith/AGstudio/', 'C:\\Users\\Ana Smith\\AGstudio\\']) {
        const config = JSON.parse(claudeDesktopConfig('http://localhost:5390', root, 'win32')) as {
          mcpServers: { agstudio: { command: string } };
        };
        expect(config.mcpServers.agstudio.command).toBe('C:\\Users\\Ana Smith\\AGstudio\\bin\\agstudio-mcp.cmd');
      }
    });

    it('writes the backslashes as valid JSON (doubled) in the text to copy', () => {
      const text = claudeDesktopConfig('http://localhost:5390', 'C:\\AGstudio', 'win32');
      expect(text).toContain('"command": "C:\\\\AGstudio\\\\bin\\\\agstudio-mcp.cmd"');
    });

    it('names the Claude Desktop config file under %APPDATA%', () => {
      expect(claudeDesktopConfigPath('win32')).toBe('%APPDATA%\\Claude\\claude_desktop_config.json');
      expect(claudeDesktopConfigPath('darwin')).toBe('~/Library/Application Support/Claude/claude_desktop_config.json');
    });

    it('gives a Claude Code line that PowerShell, cmd and shells all read the same way: double quotes only, no escapes', () => {
      const line = claudeCodeCommand('http://localhost:5390', token);
      expect(line).not.toMatch(/['\\^`$]/);
      expect(line.match(/"/g)).toHaveLength(2);
    });
  });

  it('knows which system AGstudio runs on: what the server said, else what the browser says', () => {
    expect(hostPlatformOf('win32', 'MacIntel')).toBe('win32');
    expect(hostPlatformOf('darwin', 'Win32')).toBe('darwin');
    expect(hostPlatformOf('', 'Win32')).toBe('win32');
    expect(hostPlatformOf('', 'Windows')).toBe('win32');
    expect(hostPlatformOf('', 'MacIntel')).toBe('darwin');
    expect(hostPlatformOf('', 'Linux x86_64')).toBe('linux');
    expect(hostPlatformOf('', '')).toBe('linux');
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
