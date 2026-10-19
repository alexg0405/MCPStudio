import type { DocChange } from '@core/history/history';
import type { ChannelId, Project } from '@core/model/types';
import { automatedOwners } from '@core/automation/owners';
import { effectivelyMuted } from '@core/query/queries';
import type { TransportView } from './api';
import type { AutomationDriver } from './automation/driver';
import type { ChannelStrip } from './channel-strip';
import { syncChannelStrips } from './channel-strip-sync';
import type { EngineCore } from './engine-core';
import type { MixerGraph } from './mixer-graph';
import type { NoteFeedHub } from './note-feed';
import type { SampleResidency } from './sample-residency';
import { SchedulingWatch, residencyInputsChanged } from './scheduling-watch';
import type { TempoInfo } from './tempo-info';

/** What the project mirror drives and asks of the engine. */
export interface ProjectMirrorHost {
  /** The engine itself, as channel strips see it. */
  readonly core: EngineCore;
  readonly strips: Map<ChannelId, ChannelStrip>;
  readonly mixer: MixerGraph;
  readonly noteFeed: NoteFeedHub;
  readonly residency: SampleResidency;
  readonly automation: AutomationDriver;
  readonly tempo: TempoInfo;
  /** What the transport is looking at (the automation driver plans for it). */
  view(): TransportView;
  isPlaying(): boolean;
  /** Plans what the transport plays again (the notes, the clips or the shifts changed). */
  replan(): void;
}

/**
 * Keeps the Web Audio graph in line with the project document: each change the history makes arrives here and is
 * applied to the mixer, the channel strips, the automation and the transport's plan, in the order that works (inserts
 * first, because channels connect to them; removals last).
 */
export class ProjectMirror {
  /** The project as last applied, or null before the first one. */
  project: Project | null = null;
  private readonly schedulingWatch = new SchedulingWatch();
  /** Inside `apply`: a change of the compensation is applied at its end, once the strips are up to date. */
  private applying = 0;
  private realign = false;
  /** A channel's shift changed during this change (a re-plan follows while playing). */
  private shiftsMoved = false;

  constructor(private readonly host: ProjectMirrorHost) {}

  /** Applies a document change: a load starts from nothing, any other change is applied on top of what is there. */
  applyDocChange(change: DocChange): void {
    const prev = change.origin === 'load' ? null : this.project;
    this.apply(prev, change.next, change.origin === 'load' ? 0 : (change.glideSec ?? 0));
  }

  /**
   * The mixer's delay compensation was recomputed: every channel (and its automation and plugin anchors) is scheduled
   * later by what its insert is held back. While playing, what was already handed to the audio thread with the old
   * shift is planned again. During a change it waits until the strips are up to date.
   */
  alignChannels(): void {
    if (this.applying > 0) {
      this.realign = true;
      return;
    }
    if (this.applyAlignment() && this.host.isPlaying()) this.host.replan();
  }

  /** Returns whether any channel's shift changed. */
  private applyAlignment(): boolean {
    let moved = false;
    for (const strip of this.host.strips.values()) {
      if (strip.setShift(this.host.mixer.shiftSeconds(strip.outputId))) moved = true;
    }
    // Insert and effect lanes were moved by the mixer itself; either way the driver plans the moved lanes again.
    this.host.automation.retime();
    return moved;
  }

  private apply(prev: Project | null, next: Project, glideSec = 0): void {
    if (prev === next) return;
    this.applying++;
    this.shiftsMoved = false;
    try {
      this.applyChange(prev, next, glideSec);
    } finally {
      this.applying--;
    }
    if (this.realign) {
      this.realign = false;
      if (this.applyAlignment()) this.shiftsMoved = true;
    }
    // Scheduling changes were re-planned at the end of applyChange; a moved shift needs a re-plan of its own.
    if (this.shiftsMoved && this.host.isPlaying()) this.host.replan();
    this.shiftsMoved = false;
  }

  private applyChange(prev: Project | null, next: Project, glideSec: number): void {
    const { mixer, noteFeed, residency, automation } = this.host;
    this.project = next;
    if (!prev || prev.transport.bpm !== next.transport.bpm) this.host.tempo.setBpm(next.transport.bpm);

    // Inserts first (channels connect to them), removals last.
    const removedInserts = mixer.reconcile(prev, next, glideSec);
    const muted = effectivelyMuted(next.channels);
    if (syncChannelStrips(this.host.core, this.host.strips, prev, next, muted)) this.shiftsMoved = true;
    // Anything still routed to a removed insert falls back to the master.
    mixer.removeStrips(removedInserts);
    this.rebuildNewlyAutomatedPlugins(prev, next);

    if (!prev || prev.channels !== next.channels || prev.channelOrder !== next.channelOrder) noteFeed.setProject(next);
    const schedulingChanged = this.schedulingWatch.update(prev, next, muted);
    if (residencyInputsChanged(prev, next)) residency.setProject(next);
    // Automation first: a re-planning transport then schedules segments with the new curves.
    automation.update(next, this.host.view());
    if (schedulingChanged) this.host.replan();
  }

  /** First automation on a plugin that ran without AudioParams: it gets them (a new instance). */
  private rebuildNewlyAutomatedPlugins(prev: Project | null, next: Project): void {
    if (!prev || prev.channels === next.channels) return;
    if (automatedOwners(prev.channels) === automatedOwners(next.channels)) return;
    for (const strip of this.host.strips.values()) strip.automationChanged(next);
    this.host.mixer.automationChanged(next);
  }
}
