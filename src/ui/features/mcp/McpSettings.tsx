import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { devServerMissing } from '@app/local-server';
import { clientLabel } from '@app/mcp/common';
import type { Services } from '@app/services';
import {
  claudeCodeCommand,
  claudeDesktopConfig,
  claudeDesktopConfigPath,
  hostPlatformOf,
  maskToken,
  statusLine,
  urlClientConfig,
} from '@app/mcp/setup';
import { showDialog } from '../../controls/Dialog';
import { useServices } from '../../services-context';
import { Row, Section, Switch } from '../settings/parts';
import settings from '../settings/Settings.module.css';
import styles from './McpSettings.module.css';

/** How often the "calls in the last minute" count is read while this window is open (ms). */
const STATUS_REFRESH_MS = 4000;

/** While this window is open, the "calls in the last minute" count keeps up. */
function useMcpStatusRefresh(s: Services): void {
  useEffect(() => {
    void s.mcp.refresh();
    const id = window.setInterval(() => void s.mcp.refresh(), STATUS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [s]);
}

/** Copies text to the clipboard and says so (or that the browser did not allow it). */
function copyWithToast(s: Services, text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => s.session.getState().toast(`Copied ${what}`),
    () => s.session.getState().toast('The browser did not allow copying. Select the text and copy it by hand.', 'error'),
  );
}

/** Asks before making a new access token (apps with the old one are locked out), then makes it. */
async function makeNewToken(s: Services): Promise<void> {
  const choice = await showDialog({
    title: 'Make a new access token?',
    message: 'AI apps that have the old token are locked out until you give them the new setup line.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'new', label: 'Make a new token', primary: true },
    ],
    cancelId: 'cancel',
  });
  if (choice !== 'new') return;
  try {
    await s.mcp.regenerateToken();
    s.session.getState().toast('New token made. Copy the setup line again for your AI apps.');
  } catch (e) {
    s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** The status line: the dev server is missing, switched off, or which AI apps called lately. */
function statusText(isAvailable: boolean, isEnabled: boolean, status: Parameters<typeof statusLine>[0]): string {
  if (!isAvailable) return devServerMissing('Connecting AI apps') + ' Then open this window again.';
  if (!isEnabled) return 'Switched off: AI apps are turned away until you switch it on.';
  return statusLine(status, (name) => clientLabel({ name }));
}

/**
 * Settings → "Connect AI apps (MCP)": the switch, who is connected, the access token and the lines to
 * paste into Claude Code, Claude Desktop and other AI apps. Each line copies with its real token; the
 * text shows only the start of it.
 */
export function McpSettings() {
  const s = useServices();
  const enabled = useStore(s.prefs, (p) => p.mcpEnabled);
  const { available, token, root, exportsDir, platform, status } = useStore(s.mcp.store, (m) => m);
  useMcpStatusRefresh(s);

  const line = statusText(available, enabled, status);
  return (
    <Section
      title="Connect AI apps (MCP)"
      intro="Let an AI app such as Claude Code or Claude Desktop read and change this project, play it and export it, just like Studio does. Everything it changes shows up in Studio with an Undo button."
    >
      <Row label="Allow" hint="Only apps on this computer that have the access token can connect. Switching this off turns them all away.">
        <Switch checked={enabled} onChange={() => s.commands.run('options.mcp')} label="Let AI apps control AGstudio" />
      </Row>
      <Row
        label="Status"
        hint={
          available && status.tabs > 1
            ? `${status.tabs} AGstudio tabs are open: the one you used last answers the AI app.`
            : 'AI apps only reach AGstudio while this page is open in the browser.'
        }
      >
        <span className={styles.status} data-hint="Which AI apps have called AGstudio lately">
          <span className={`${styles.dot} ${available && enabled && status.clients.length ? styles.dotOn : ''}`} aria-hidden />
          {line}
        </span>
      </Row>
      {available && token && <SetupRows s={s} token={token} root={root} exportsDir={exportsDir} platform={platform} />}
    </Section>
  );
}

/** The access token and the setup lines for each kind of AI app, once the dev server has made a token. */
function SetupRows({ s, token, root, exportsDir, platform }: { s: Services; token: string; root: string; exportsDir: string; platform: string }) {
  const [isTokenShown, setIsTokenShown] = useState(false);
  const origin = window.location.origin;
  const hostPlatform = hostPlatformOf(platform, navigator.platform);
  const desktopConfig = claudeDesktopConfig(origin, root, hostPlatform);
  const code = claudeCodeCommand(origin, token);
  const shownCode = isTokenShown ? code : code.replace(token, maskToken(token));
  const terminalNote = hostPlatform === 'win32' ? ' (PowerShell or Command Prompt)' : '';
  return (
    <>
      <Row label="Access token" hint="Like a password for AI apps: it stays on this computer, in the .agstudio folder.">
        <code className={styles.token}>{isTokenShown ? token : maskToken(token)}</code>
        <button className={settings.button} onClick={() => setIsTokenShown((v) => !v)} data-hint="Show or hide the whole token">
          {isTokenShown ? 'Hide' : 'Show'}
        </button>
        <button className={settings.button} onClick={() => copyWithToast(s, token, 'the token')} data-hint="Copy the access token">
          Copy
        </button>
        <button className={settings.button} onClick={() => void makeNewToken(s)} data-hint="Make a new token; apps with the old one are locked out">
          New token…
        </button>
      </Row>
      <Row label="Claude Code" hint={`Run this once in a terminal${terminalNote}. Then start a new Claude Code session and ask it to make a beat.`}>
        <pre className={styles.code}>{shownCode}</pre>
        <button className={settings.button} onClick={() => copyWithToast(s, code, 'the Claude Code command')} data-hint="Copy the command, with the real token">
          Copy command
        </button>
      </Row>
      <Row
        label="Claude Desktop"
        hint={`Add this to claude_desktop_config.json (Claude → Settings → Developer → Edit Config opens it; usually ${claudeDesktopConfigPath(hostPlatform)}), then restart Claude Desktop. It starts a small helper that reads the token itself.`}
      >
        <pre className={styles.code}>{desktopConfig}</pre>
        <button className={settings.button} onClick={() => copyWithToast(s, desktopConfig, 'the Claude Desktop setup')} data-hint="Copy the Claude Desktop setup">
          Copy setup
        </button>
      </Row>
      <Row label="Other apps" hint="For apps that take a web address and headers (Cursor, VS Code…).">
        <button className={settings.button} onClick={() => copyWithToast(s, urlClientConfig(origin, token), 'the setup')} data-hint="Copy a JSON setup with the web address and the token">
          Copy JSON setup
        </button>
      </Row>
      <Row label="Exports" hint="export_audio saves audio files here, without asking where.">
        <span className={styles.path}>{exportsDir}</span>
      </Row>
    </>
  );
}
