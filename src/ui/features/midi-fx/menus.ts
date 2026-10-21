/** The menus of the MIDI effects: add an effect, load a chain, load or save an effect's preset. */
import type { ChannelId, MidiFxSlot } from '@core/model/types';
import { midiFxDef } from '@core/midi-fx/registry';
import { hasActiveMidiFx, midiFxOf } from '@core/query/midi-fx';
import {
  addMidiEffect,
  applyMidiFxPreset,
  bakeMidiEffects,
  clearMidiEffects,
  FACTORY_CHAINS,
  loadMidiFxChain,
  MIDI_EFFECT_CHOICES,
  saveMidiFxChain,
  saveMidiFxPreset,
  savedMidiFxChains,
  fxPresetKey,
  type MidiFxResult,
} from '@app/actions/midi-fx';
import type { Services } from '@app/services';
import { resetMidiFx } from '@core/ops/midi-fx';
import { showDialog } from '../../controls/Dialog';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';

/** Says what an action did: a toast, red when it could not. */
export function report(s: Services, result: MidiFxResult): void {
  s.session.getState().toast(result.message, result.ok ? 'info' : 'error');
}

/** The "add an effect" choices: every effect with a line of what it does (the hint bar shows it). */
export function addEffectEntries(s: Services, channelId: ChannelId, onAdded?: () => void): MenuEntry[] {
  return MIDI_EFFECT_CHOICES.map((choice) => ({
    label: choice.name,
    hint: choice.description,
    onSelect: () => {
      if (addMidiEffect(s, channelId, choice.id)) onAdded?.();
    },
  }));
}

/** Asks for a name and saves the channel's chain under it. */
async function saveChainAs(s: Services, channelId: ChannelId): Promise<void> {
  const got = await showFormDialog({
    title: 'Save the MIDI effects chain',
    message: 'Saves these effects, in this order with their settings, so you can put them on any channel in any project.',
    fields: [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. Pluck arp' }],
    values: { name: '' },
    okLabel: 'Save',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name) return;
  report(s, saveMidiFxChain(s, channelId, name));
}

/** Asks before replacing a chain that has effects in it. */
async function confirmReplace(s: Services, channelId: ChannelId, name: string): Promise<boolean> {
  const chain = midiFxOf(s.doc.getState().project.channels[channelId]);
  if (chain.length === 0) return true;
  const answer = await showDialog({
    title: 'Replace the MIDI effects?',
    message: `Loading “${name}” replaces the ${chain.length} effect${chain.length === 1 ? '' : 's'} this channel has now.`,
    detail: 'It is one undo step: Undo brings them back.',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'replace', label: 'Replace', primary: true },
    ],
    cancelId: 'cancel',
  });
  return answer === 'replace';
}

/** The chain menu: ready-made chains, yours, saving the current one, rendering to notes and removing everything. */
export function chainEntries(s: Services, channelId: ChannelId): MenuEntry[] {
  const mine = savedMidiFxChains(s);
  const load = (name: string, slots: Parameters<typeof loadMidiFxChain>[3]) => async () => {
    if (await confirmReplace(s, channelId, name)) report(s, loadMidiFxChain(s, channelId, name, slots));
  };
  const channel = s.doc.getState().project.channels[channelId];
  const hasChain = midiFxOf(channel).length > 0;
  return [
    { kind: 'label', label: 'Ready-made chains' },
    ...FACTORY_CHAINS.map((chain): MenuEntry => ({ label: chain.name, hint: chain.description, onSelect: () => void load(chain.name, chain.slots)() })),
    ...(mine.length > 0
      ? [
          { kind: 'separator' } as const,
          { kind: 'label', label: 'Your chains' } as const,
          ...mine.map((chain): MenuEntry => ({
            label: chain.name,
            hint: `Your saved chain: ${chain.slots.map((slot) => midiFxDef(slot.effect)?.name ?? slot.effect).join(', ')}`,
            disabled: chain.slots.length === 0,
            onSelect: () => void load(chain.name, chain.slots)(),
          })),
        ]
      : []),
    { kind: 'separator' },
    { label: 'Save this chain…', disabled: !hasChain, hint: 'Keep these effects and their settings under a name', onSelect: () => void saveChainAs(s, channelId) },
    {
      label: 'Render MIDI effects to notes',
      disabled: !hasActiveMidiFx(channel),
      hint: 'Write what the effects make into the patterns as notes (one undo step) and take the effects out of the way',
      onSelect: () => report(s, bakeMidiEffects(s, channelId)),
    },
    { label: 'Remove all effects', danger: true, disabled: !hasChain, onSelect: () => clearMidiEffects(s, channelId) },
  ];
}

/** Asks for a name and saves one effect's settings as a preset of your own. */
async function savePresetAs(s: Services, channelId: ChannelId, slot: MidiFxSlot): Promise<void> {
  const def = midiFxDef(slot.effect);
  if (!def) return;
  const got = await showFormDialog({
    title: `Save ${def.name} preset`,
    message: 'Saves how this effect is set right now, so you can load it again on any channel in any project.',
    fields: [{ kind: 'text', key: 'name', label: 'Name', placeholder: 'e.g. Fast pluck' }],
    values: { name: '' },
    okLabel: 'Save',
  });
  const name = got ? String(got.name).trim() : '';
  if (!name) return;
  report(s, saveMidiFxPreset(s, channelId, slot.id, name));
}

/** One effect's preset menu: its ready-made presets, yours, saving the current settings and starting over. */
export function presetEntries(s: Services, channelId: ChannelId, slot: MidiFxSlot): MenuEntry[] {
  const def = midiFxDef(slot.effect);
  if (!def) return [];
  const mine = s.presets.forPlugin(fxPresetKey(slot.effect));
  return [
    { kind: 'label', label: `${def.name} presets` },
    ...def.presets.map((preset): MenuEntry => ({ label: preset.name, onSelect: () => applyMidiFxPreset(s, channelId, slot.id, preset) })),
    ...(mine.length > 0
      ? [
          { kind: 'separator' } as const,
          { kind: 'label', label: 'Your presets' } as const,
          ...mine.map((preset): MenuEntry => ({
            label: preset.name,
            onSelect: () => applyMidiFxPreset(s, channelId, slot.id, { name: preset.name, params: preset.params }),
          })),
        ]
      : []),
    { kind: 'separator' },
    { label: 'Save these settings…', hint: 'Keep this effect’s settings as a preset of your own', onSelect: () => void savePresetAs(s, channelId, slot) },
    { label: 'Reset to defaults', onSelect: () => s.history.transact(`${def.name}: reset`, (d) => resetMidiFx(d, channelId, slot.id)) },
  ];
}
