/// <reference types="node" />
/**
 * docs/shortcuts.md is generated from the live keymap so it can't drift. Regenerate with
 *   UPDATE_DOCS=1 npx vitest run --project unit test/unit/shortcuts-doc.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createTestServices } from '@app/testing';
import { formatChord } from '@core/commands/keymap';
import { registerFeatures } from '@ui/features';

const PATH = new URL('../../docs/shortcuts.md', import.meta.url);

function render(): string {
  const s = createTestServices();
  registerFeatures(s);
  const scopes = new Map<string, { title: string; chords: string[] }[]>();
  for (const b of s.keymap.all()) {
    const def = s.commands.get(b.command);
    if (!def) continue;
    const scope = b.when?.focus?.length ? b.when.focus.join(', ') : 'Everywhere';
    const label = b.args !== undefined && def.id.endsWith('transpose') ? `${def.title} (${String(b.args)})` : def.title;
    const rows = scopes.get(scope) ?? [];
    let row = rows.find((r) => r.title === label);
    if (!row) {
      row = { title: label, chords: [] };
      rows.push(row);
    }
    const mac = formatChord(b.chord.replace(/Mod/g, 'Meta'), 'mac');
    const other = formatChord(b.chord.replace(/Mod/g, 'Ctrl'), 'other');
    const text = mac === other ? `\`${mac}\`` : `\`${mac}\` / \`${other}\``;
    if (!row.chords.includes(text)) row.chords.push(text);
    scopes.set(scope, rows);
  }
  const order = ['Everywhere', ...[...scopes.keys()].filter((k) => k !== 'Everywhere').sort()];
  const lines = [
    '# Keyboard shortcuts',
    '',
    'Generated from the app\'s keymap (`test/unit/shortcuts-doc.test.ts`). In the app, press F1 for the same list.',
    'On macOS, F-keys may need Fn; every window toggle also has an Alt+number alternate.',
    '',
  ];
  for (const scope of order) {
    const rows = scopes.get(scope);
    if (!rows?.length) continue;
    lines.push(`## ${scope === 'Everywhere' ? 'Everywhere' : `When the ${scope} window is focused`}`, '', '| Action | Keys |', '|---|---|');
    for (const r of rows.sort((a, b) => a.title.localeCompare(b.title))) lines.push(`| ${r.title} | ${r.chords.join(', ')} |`);
    lines.push('');
  }
  return lines.join('\n');
}

describe('docs/shortcuts.md', () => {
  it('matches the keymap', () => {
    const text = render();
    if (process.env.UPDATE_DOCS || !existsSync(PATH)) writeFileSync(PATH, text);
    expect(readFileSync(PATH, 'utf8')).toBe(text);
  });
});
