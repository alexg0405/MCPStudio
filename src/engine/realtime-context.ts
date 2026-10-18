/**
 * True for a realtime AudioContext (not an OfflineAudioContext, and not a missing AudioContext such as Node's).
 * Only realtime contexts have output latency, an output device and a running clock to follow.
 */
export function isRealtimeContext(ctx: BaseAudioContext): ctx is AudioContext {
  return typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
}
