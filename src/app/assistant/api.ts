import type { StoreApi } from 'zustand/vanilla';
import type { PluginSpec } from '../ai/builder';
import type { AiFocus } from '../ai/focus';
import type { AiBackend, AiStatus } from './claude';
import type { AssistantState } from './state';

/**
 * What the UI and the commands use of the Studio assistant. `BeatAssistant` implements it; the app talks to
 * `AssistantFacade` (same surface), which loads the real thing on first use.
 */
export interface AssistantApi {
  readonly store: StoreApi<AssistantState>;
  set(patch: Partial<AssistantState>): void;
  checkAi(): Promise<AiStatus>;
  route(): Promise<AiBackend | null>;
  send(prompt: string, opts?: { focus?: AiFocus | null }): Promise<void>;
  cancel(): void;
  newBeat(): void;
  approve(messageId: number, choice: 'all' | 'part'): Promise<void>;
  setFocus(focus: AiFocus | null): void;
  playFocus(focus?: AiFocus | null): boolean;
  clearUiRequests(): void;
  record(): Promise<void>;
  recordingLevel(): number;
  recordingPosition(): number | null;
  stopRecording(): void;
  cancelRecording(): void;
  importRecording(file: Pick<File, 'name' | 'arrayBuffer'>): Promise<void>;
  clearTake(): void;
  playTake(): void;
  listenAndAsk(request: string, fromUser: boolean, focus?: AiFocus | null): Promise<void>;
  checkMix(): Promise<void>;
  balanceMix(): Promise<void>;
  buildPlugin(spec: PluginSpec): Promise<void>;
  cancelBuild(): void;
  installPlugin(messageId: number): Promise<void>;
  discardPlugin(messageId: number): Promise<void>;
}
