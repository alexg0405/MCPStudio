import type { StoreApi } from 'zustand/vanilla';
import type { PluginSpec } from '../ai/builder';
import type { AiFocus } from '../ai/focus';
import type { Services } from '../services';
import type { AssistantApi } from './api';
import type { BeatAssistant } from './assistant';
import type { AiBackend, AiStatus } from './claude';
import { playFocus } from './play-focus';
import { createAssistantCore, type AssistantCore, type AssistantState } from './state';

const loadModule = () => import('./assistant');

/**
 * The Studio assistant as the rest of the app sees it. The state store (what the toolbar button and the
 * windows subscribe to) exists from startup; the assistant itself (the AI ops, arrange, voice and mix
 * code, about a quarter of a megabyte) loads the first time something needs it, or at idle time after the
 * first paint (`prefetch`), so startup doesn't pay for code most sessions use late or never.
 *
 * Calls that need the real assistant wait for it, in order. Calls that only touch the store, and the few
 * that have an answer before anything has loaded (nothing is recording yet), answer at once.
 */
export class AssistantFacade implements AssistantApi {
  readonly store: StoreApi<AssistantState>;
  private readonly core: AssistantCore;
  private real: BeatAssistant | null = null;
  private loading: Promise<BeatAssistant> | null = null;

  constructor(private readonly s: Services) {
    this.core = createAssistantCore(s.history);
    this.store = this.core.store;
  }

  /** The real assistant once it has loaded (null before): for debugging and tests (`__ag.assistant.instance`). */
  get instance(): BeatAssistant | null {
    return this.real;
  }

  /** Fetches the assistant's code without starting it (idle time after first paint). */
  prefetch(): void {
    void loadModule().catch(() => undefined);
  }

  /** Loads and starts the real assistant (once). */
  load(): Promise<BeatAssistant> {
    return (this.loading ??= loadModule().then(
      (m) => (this.real = new m.BeatAssistant(this.s, { core: this.core })),
      (err: unknown) => {
        this.loading = null; // a network hiccup: the next call tries again
        throw err;
      },
    ));
  }

  /** Runs now when loaded, else once it has (calls keep their order). */
  private later(fn: (a: BeatAssistant) => void): void {
    if (this.real) fn(this.real);
    else void this.load().then(fn, () => undefined);
  }

  // ---- store only
  set(patch: Partial<AssistantState>): void {
    this.store.setState(patch);
  }
  setFocus(focus: AiFocus | null): void {
    if (this.store.getState().focus !== focus) this.store.setState({ focus });
  }
  clearUiRequests(): void {
    if (this.store.getState().uiRequests.length) this.store.setState({ uiRequests: [] });
  }
  playFocus(focus: AiFocus | null = this.store.getState().focus): boolean {
    return playFocus(this.s, focus);
  }

  // ---- nothing can be running before the assistant has loaded
  recordingLevel(): number {
    return this.real?.recordingLevel() ?? 0;
  }
  recordingPosition(): number | null {
    return this.real?.recordingPosition() ?? null;
  }
  cancel(): void {
    this.real?.cancel();
  }
  cancelBuild(): void {
    this.real?.cancelBuild();
  }
  stopRecording(): void {
    this.real?.stopRecording();
  }
  cancelRecording(): void {
    this.real?.cancelRecording();
  }

  // ---- need the assistant
  newBeat(): void {
    this.later((a) => a.newBeat());
  }
  clearTake(): void {
    this.later((a) => a.clearTake());
  }
  playTake(): void {
    this.later((a) => a.playTake());
  }
  async checkAi(): Promise<AiStatus> {
    return (await this.load()).checkAi();
  }
  async route(): Promise<AiBackend | null> {
    return (await this.load()).route();
  }
  async send(prompt: string, opts?: { focus?: AiFocus | null }): Promise<void> {
    return (await this.load()).send(prompt, opts);
  }
  async approve(messageId: number, choice: 'all' | 'part'): Promise<void> {
    return (await this.load()).approve(messageId, choice);
  }
  async record(): Promise<void> {
    return (await this.load()).record();
  }
  async importRecording(file: Pick<File, 'name' | 'arrayBuffer'>): Promise<void> {
    return (await this.load()).importRecording(file);
  }
  async listenAndAsk(request: string, fromUser: boolean, focus?: AiFocus | null): Promise<void> {
    return (await this.load()).listenAndAsk(request, fromUser, focus);
  }
  async checkMix(): Promise<void> {
    return (await this.load()).checkMix();
  }
  async balanceMix(): Promise<void> {
    return (await this.load()).balanceMix();
  }
  async buildPlugin(spec: PluginSpec): Promise<void> {
    return (await this.load()).buildPlugin(spec);
  }
  async installPlugin(messageId: number): Promise<void> {
    return (await this.load()).installPlugin(messageId);
  }
  async discardPlugin(messageId: number): Promise<void> {
    return (await this.load()).discardPlugin(messageId);
  }
}
