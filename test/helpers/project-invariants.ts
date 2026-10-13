import { MASTER, type Project } from '@core/model/types';

/**
 * Referential and range rules every repaired project satisfies (an independent restatement of what
 * repairProject promises). Returns the violations; empty means the project is consistent.
 */
export function projectViolations(p: Project): string[] {
  const out: string[] = [];
  const has = (o: object, key: string) => Object.hasOwn(o, key);
  const inRange = (v: unknown, lo: number, hi: number) => typeof v === 'number' && v >= lo && v <= hi;
  const isInt = (v: unknown, lo: number, hi = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && inRange(v, lo, hi);

  const checkOrder = (name: string, order: readonly string[], records: Record<string, { id: string }>) => {
    if (new Set(order).size !== order.length) out.push(`${name}: duplicate ids in order`);
    for (const id of order) if (!has(records, id)) out.push(`${name}: order has unknown id ${id}`);
    for (const [key, record] of Object.entries(records)) {
      if (!order.includes(key)) out.push(`${name}: ${key} missing from order`);
      if (record.id !== key) out.push(`${name}: ${key} has id ${record.id}`);
    }
  };
  checkOrder('channels', p.channelOrder, p.channels);
  checkOrder('patterns', p.patternOrder, p.patterns);
  checkOrder('lanes', p.playlist.laneOrder, p.playlist.lanes);
  checkOrder('inserts', p.mixer.order, p.mixer.inserts);
  checkOrder('clips', Object.keys(p.playlist.clips), p.playlist.clips);
  checkOrder('samples', Object.keys(p.samples), p.samples);

  if (p.mixer.order[0] !== MASTER) out.push('mixer: master is not first');
  if (p.patternOrder.length < 1) out.push('patterns: none');
  if (typeof p.projectId !== 'string' || !p.projectId) out.push('projectId missing');
  if (!inRange(p.transport.bpm, 10, 522)) out.push(`transport: bpm ${p.transport.bpm}`);
  if (!inRange(p.transport.swing, 0, 1)) out.push(`transport: swing ${p.transport.swing}`);

  const sampleSlots = (where: string, samples: Record<string, string> | undefined) => {
    for (const [slot, id] of Object.entries(samples ?? {})) {
      if (!has(p.samples, id)) out.push(`${where}: sample slot ${slot} → missing ${id}`);
    }
  };
  for (const ch of Object.values(p.channels)) {
    if (ch.kind === 'automation') continue;
    if (!has(p.mixer.inserts, ch.output)) out.push(`channel ${ch.id}: output ${ch.output} missing`);
    if (!inRange(ch.volume, 0, 1.25)) out.push(`channel ${ch.id}: volume ${ch.volume}`);
    if (!inRange(ch.pan, -1, 1)) out.push(`channel ${ch.id}: pan ${ch.pan}`);
    if (ch.kind === 'instrument') {
      if (!isInt(ch.rootKey, 0, 127)) out.push(`channel ${ch.id}: rootKey ${ch.rootKey}`);
      sampleSlots(`channel ${ch.id}`, ch.plugin.samples);
    }
  }
  for (const ins of Object.values(p.mixer.inserts)) {
    if (!inRange(ins.volume, 0, Number.MAX_VALUE)) out.push(`insert ${ins.id}: volume ${ins.volume}`);
    if (!inRange(ins.pan, -1, 1)) out.push(`insert ${ins.id}: pan ${ins.pan}`);
    if (!Array.isArray(ins.fx)) out.push(`insert ${ins.id}: fx is not an array`);
    else {
      const ids = ins.fx.map((s) => s.id);
      if (new Set(ids).size !== ids.length) out.push(`insert ${ins.id}: duplicate slot ids`);
      for (const slot of ins.fx) {
        if (!inRange(slot.mix, 0, 1)) out.push(`insert ${ins.id}: slot ${slot.id} mix ${slot.mix}`);
        sampleSlots(`insert ${ins.id} slot ${slot.id}`, slot.plugin.samples);
      }
    }
  }
  for (const pat of Object.values(p.patterns)) {
    if (!isInt(pat.stepCount, 1, 512)) out.push(`pattern ${pat.id}: stepCount ${pat.stepCount}`);
    for (const [channelId, notes] of Object.entries(pat.notes)) {
      if (!has(p.channels, channelId)) out.push(`pattern ${pat.id}: notes for missing channel ${channelId}`);
      for (const [noteId, n] of Object.entries(notes)) {
        const where = `pattern ${pat.id} note ${noteId}`;
        if (n.id !== noteId) out.push(`${where}: id ${n.id}`);
        if (!isInt(n.tick, 0)) out.push(`${where}: tick ${n.tick}`);
        if (!isInt(n.length, 1)) out.push(`${where}: length ${n.length}`);
        if (!isInt(n.key, 0, 127)) out.push(`${where}: key ${n.key}`);
        if (!inRange(n.velocity, 0, 1)) out.push(`${where}: velocity ${n.velocity}`);
        if (n.pan !== undefined && !inRange(n.pan, -1, 1)) out.push(`${where}: pan ${n.pan}`);
      }
    }
  }
  for (const clip of Object.values(p.playlist.clips)) {
    const where = `clip ${clip.id}`;
    if (!has(p.playlist.lanes, clip.laneId)) out.push(`${where}: missing lane ${clip.laneId}`);
    if (!isInt(clip.start, 0) || !isInt(clip.length, 1)) out.push(`${where}: bad start/length`);
    if (clip.kind === 'pattern') {
      if (!has(p.patterns, clip.patternId)) out.push(`${where}: missing pattern ${clip.patternId}`);
    } else {
      const ch = has(p.channels, clip.channelId) ? p.channels[clip.channelId] : undefined;
      const want = clip.kind === 'audio' ? 'audioClip' : 'automation';
      if (ch?.kind !== want) out.push(`${where}: channel ${clip.channelId} is not an ${want} channel`);
    }
  }
  return out;
}
