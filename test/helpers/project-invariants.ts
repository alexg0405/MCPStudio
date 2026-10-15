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
  for (const pat of Object.values(p.patterns)) {
    const d = pat.derived;
    if (!d) continue;
    if (d.from === pat.id || !has(p.patterns, d.from)) out.push(`pattern ${pat.id}: derived from missing ${d.from}`);
    if (!Array.isArray(d.steps) || d.steps.some((s) => !(s.to > s.from && s.from >= 0)))
      out.push(`pattern ${pat.id}: bad variant steps`);
    if (typeof d.seed !== 'number' || typeof d.hash !== 'string') out.push(`pattern ${pat.id}: bad derivation`);
  }
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
    if (ch.kind === 'automation') {
      for (let i = 0; i < ch.points.length; i++) {
        const pt = ch.points[i]!;
        if (!isInt(pt.tick, 0) || !inRange(pt.value, 0, 1)) out.push(`automation ${ch.id}: point ${i}`);
        if (i > 0 && pt.tick < ch.points[i - 1]!.tick) out.push(`automation ${ch.id}: points out of order`);
        if (pt.tension !== undefined && !inRange(pt.tension, -1, 1)) out.push(`automation ${ch.id}: tension`);
      }
      if (ch.range && !(ch.range.min < ch.range.max)) out.push(`automation ${ch.id}: range`);
      continue;
    }
    if (ch.kind === 'audioClip' && !has(p.samples, ch.sampleId))
      out.push(`channel ${ch.id}: missing sample ${ch.sampleId}`);
    if (!has(p.mixer.inserts, ch.output)) out.push(`channel ${ch.id}: output ${ch.output} missing`);
    if (!inRange(ch.volume, 0, 1.25)) out.push(`channel ${ch.id}: volume ${ch.volume}`);
    if (!inRange(ch.pan, -1, 1)) out.push(`channel ${ch.id}: pan ${ch.pan}`);
    if (ch.kind === 'instrument') {
      if (!isInt(ch.rootKey, 0, 127)) out.push(`channel ${ch.id}: rootKey ${ch.rootKey}`);
      if (ch.pitch !== undefined && !inRange(ch.pitch, -2400, 2400)) out.push(`channel ${ch.id}: pitch ${ch.pitch}`);
      sampleSlots(`channel ${ch.id}`, ch.plugin.samples);
    }
  }
  // Routing: one route per existing target (never itself), none from the master, no cycles through
  // routes or sidechains.
  const edges = new Map<string, string[]>();
  const addEdge = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);
  for (const ins of Object.values(p.mixer.inserts)) {
    if (!Array.isArray(ins.routes)) {
      out.push(`insert ${ins.id}: routes is not an array`);
      continue;
    }
    if (ins.id === MASTER && ins.routes.length) out.push('master: has routes');
    const targets = ins.routes.map((r) => r.to);
    if (new Set(targets).size !== targets.length) out.push(`insert ${ins.id}: repeated route targets`);
    for (const r of ins.routes) {
      if (!has(p.mixer.inserts, r.to) || r.to === ins.id) out.push(`insert ${ins.id}: bad route to ${r.to}`);
      if (!inRange(r.level, 0, 4)) out.push(`insert ${ins.id}: route level ${r.level}`);
      if (typeof r.pre !== 'boolean') out.push(`insert ${ins.id}: route pre ${String(r.pre)}`);
      addEdge(ins.id, r.to);
    }
    for (const slot of Array.isArray(ins.fx) ? ins.fx : []) {
      if (slot.sidechain === null) continue;
      if (!has(p.mixer.inserts, slot.sidechain) || slot.sidechain === ins.id)
        out.push(`insert ${ins.id}: slot ${slot.id} sidechain ${slot.sidechain}`);
      else addEdge(slot.sidechain, ins.id);
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const found = (edges.get(id) ?? []).some(cyclic);
    visiting.delete(id);
    done.add(id);
    return found;
  };
  if (Object.keys(p.mixer.inserts).some(cyclic)) out.push('mixer: routing has a cycle');

  if (typeof p.controllers !== 'object' || p.controllers === null) out.push('controllers missing');
  else
    for (const [id, link] of Object.entries(p.controllers)) {
      if (link.id !== id) out.push(`controller ${id}: id ${link.id}`);
      if (!isInt(link.cc, 0, 127)) out.push(`controller ${id}: cc ${link.cc}`);
      if (link.channel !== null && !isInt(link.channel, 0, 15)) out.push(`controller ${id}: channel ${link.channel}`);
      if (!inRange(link.min, 0, 1) || !inRange(link.max, 0, 1)) out.push(`controller ${id}: range`);
    }
  const key = p.transport.key;
  if (key !== undefined && (!isInt(key.root, 0, 11) || typeof key.scale !== 'string'))
    out.push(`transport: key ${JSON.stringify(key)}`);

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
        if (n.release !== undefined && !inRange(n.release, 0, 1)) out.push(`${where}: release ${n.release}`);
        if (n.fine !== undefined && !inRange(n.fine, -100, 100)) out.push(`${where}: fine ${n.fine}`);
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
