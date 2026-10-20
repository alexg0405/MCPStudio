import type { Tour } from '../tour-types';
import { showWindow } from './prepare';

/** Studio (the chat that changes the project) and MCP (other apps doing the same). */
export const STUDIO_MCP: Tour = {
  id: 'studio-mcp',
  title: 'Studio and MCP',
  summary:
    'Ask for changes in your own words, change only part of a song, and let Claude Code or other apps control AGstudio.',
  minutes: 3,
  area: 'Studio',
  keywords: [
    'studio',
    'assistant',
    'chat',
    'claude',
    'mcp',
    'ask',
    'prompt',
    'claude code',
    'plugin builder',
    'connect',
    'codex',
    'chatgpt',
  ],
  windows: ['assistant'],
  steps: [
    {
      id: 'button',
      target: 'tour:assistant',
      title: '1. Studio',
      body: 'This button opens Studio, a chat that works inside your project. Ask for a beat, a melody, a mix change, an arrangement or any command in the app, in your own words.',
    },
    {
      id: 'chat',
      target: 'window:assistant',
      title: '2. Ask, then undo',
      body: 'Type what you want and press Enter. Everything Studio does is one undo step, and every answer has an Undo button under it. The picker at the top chooses who answers: your Claude subscription, ChatGPT through Codex, an API key, or the built-in offline generator.',
      prepare: showWindow('assistant'),
    },
    {
      id: 'part',
      target: 'menu:edit',
      title: '3. Change only one part',
      body: 'Select notes or clips, or drag across the playlist ruler, then Edit → Ask Studio about the selection… Studio changes only that part and leaves the rest of the song as it was. Click the ✦ on a section marker to ask about a whole section.',
    },
    {
      id: 'connect',
      target: 'menu:options',
      title: '4. Connect other apps (MCP)',
      body: 'Options → Connect Claude Code or other apps (MCP)… shows the one line that lets Claude Code, Claude Desktop or Cursor read and change your project with the same tools Studio uses. Each change shows up in Studio with an Undo button.',
      tryIt: { label: 'Open the MCP settings', command: 'options.connectAi' },
    },
    {
      id: 'safety',
      target: 'window:settings',
      title: '5. You stay in control',
      body: 'The MCP section of Settings has the access token, a copy button for each app, and one switch that turns every app away at once. Only programs on this computer can connect, and only with the token.',
      prepare: showWindow('settings'),
    },
    {
      id: 'plugins',
      target: 'menu:add',
      title: '6. Build your own instrument or effect',
      body: 'Add → New plugin… writes a starting point for your own instrument, effect or piano-roll tool into the plugins folder, and Studio can write a whole plugin for you from a description. It reloads while you play.',
    },
  ],
};
