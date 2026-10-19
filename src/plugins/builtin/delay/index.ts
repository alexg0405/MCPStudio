import { defineEffect } from '@agstudio/sdk';
import { createTiming, buildNetwork } from './network';
import { delayParams } from './params';

/** The longest the echoes are reported to ring, seconds (a feedback near 95 % at a slow tempo would be much longer). */
const MAX_TAIL_SEC = 30;
/** An echo is inaudible once it falls below this gain (−60 dB). */
const AUDIBLE_FLOOR = 0.001;

/**
 * Tempo-synced stereo delay with optional ping-pong and low/high cut filters inside the feedback
 * loop. Both the straight and the ping-pong network always exist; switching crossfades their inputs
 * so echoes already in flight ring out.
 *
 * Timing: the browser breaks every feedback cycle by reading one link one render quantum late, so
 * each trip around a loop is a quantum longer than its DelayNode says. The straight loop is set one
 * quantum short with a one-quantum pre-delay in front (first echo and every repeat land on time);
 * in the ping-pong loop the late link is on the left → right hop, so the right delay is one quantum
 * short. test/browser/mixer.test.ts checks the echo positions.
 */
export default defineEffect({
  id: 'agstudio.delay',
  name: 'Delay',
  version: 1,
  category: 'Delay',
  description: 'Tempo-synced echo with feedback, ping-pong and tone filters.',
  params: delayParams,
  presets: [
    { name: 'Eighth echo', params: { time: '1/8', feedback: 0.35, mix: 0.3 } },
    { name: 'Dotted ping-pong', params: { time: '1/8d', feedback: 0.45, pingPong: true, mix: 0.3 } },
    { name: 'Triplet bounce', params: { time: '1/8t', feedback: 0.4, pingPong: true, mix: 0.3 } },
    { name: 'Slapback', params: { time: '1/16', feedback: 0.08, mix: 0.25, highCut: 6000 } },
    { name: 'Dub', params: { time: '1/4', feedback: 0.7, lowCut: 300, highCut: 2500, mix: 0.35 } },
  ],

  create(host) {
    const timing = createTiming(host);
    const network = buildNetwork(host, timing);
    const params = host.params;

    params.time.onChange((_, time) => network.retime(time, host.transport.tempoAt(time)));
    // Tempo automation: follow the tempo from the time it changes (scheduled ahead, like notes).
    const offTempo = host.transport.onTempo((bpm, time) =>
      network.retime(Math.max(time, host.audioContext.currentTime), bpm),
    );

    return {
      input: network.input,
      output: network.output,
      get tailTime() {
        const feedback = params.feedback.value;
        const repeats = feedback > AUDIBLE_FLOOR ? Math.log(AUDIBLE_FLOOR) / Math.log(feedback) : 0;
        return Math.min(MAX_TAIL_SEC, (repeats + 1) * timing.seconds());
      },
      dispose() {
        offTempo();
        network.dispose();
      },
    };
  },
});
