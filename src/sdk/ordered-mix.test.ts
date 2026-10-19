import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderedMix } from './ordered-mix';

/** A stand-in for an AudioNode that remembers its connections (Node has no Web Audio). */
class FakeNode {
  readonly inputs = new Set<FakeNode>();
  readonly outputs = new Set<FakeNode>();

  connect(to: FakeNode): FakeNode {
    this.outputs.add(to);
    to.inputs.add(this);
    return to;
  }

  disconnect(to?: FakeNode): void {
    if (to && !this.outputs.has(to)) throw new Error('not connected');
    for (const target of to ? [to] : [...this.outputs]) {
      this.outputs.delete(target);
      target.inputs.delete(this);
    }
  }
}

let gainsMade = 0;

class FakeGain extends FakeNode {
  constructor() {
    super();
    gainsMade++;
  }
}

beforeEach(() => {
  gainsMade = 0;
  vi.stubGlobal('GainNode', FakeGain);
});

afterEach(() => vi.unstubAllGlobals());

const asContext = {} as BaseAudioContext;
const asNode = (n: FakeNode) => n as unknown as AudioNode;

/** Every node reachable from `from` going backwards through inputs, `from` included. */
function upstream(from: FakeNode): Set<FakeNode> {
  const seen = new Set<FakeNode>();
  const visit = (n: FakeNode) => {
    if (seen.has(n)) return;
    seen.add(n);
    n.inputs.forEach(visit);
  };
  visit(from);
  return seen;
}

describe('OrderedMix', () => {
  it('feeds every source to the target without any node having more than two inputs', () => {
    const into = new FakeNode();
    const mix = new OrderedMix(asContext, asNode(into), { ordered: true });
    const sources = Array.from({ length: 9 }, () => new FakeNode());
    for (const source of sources) mix.attach(asNode(source));
    const reachable = upstream(into);
    for (const source of sources) expect(reachable.has(source)).toBe(true);
    for (const node of reachable) expect(node.inputs.size).toBeLessThanOrEqual(2);
  });

  it('puts the first source straight into the target and builds one stage per further source', () => {
    const into = new FakeNode();
    const mix = new OrderedMix(asContext, asNode(into), { ordered: true });
    const first = new FakeNode();
    mix.attach(asNode(first));
    expect(into.inputs.has(first)).toBe(true);
    expect(gainsMade).toBe(0);
    for (let i = 0; i < 3; i++) mix.attach(asNode(new FakeNode()));
    expect(gainsMade).toBe(3);
  });

  it('gives a freed place to the next source instead of making the ladder longer', () => {
    const into = new FakeNode();
    const mix = new OrderedMix(asContext, asNode(into), { ordered: true });
    const [a, b, c, d] = [new FakeNode(), new FakeNode(), new FakeNode(), new FakeNode()];
    mix.attach(asNode(a));
    const detachB = mix.attach(asNode(b));
    mix.attach(asNode(c));
    const stagesBefore = gainsMade;
    const placeOfB = [...b.outputs][0];
    detachB();
    expect(b.outputs.size).toBe(0);
    mix.attach(asNode(d));
    expect(gainsMade).toBe(stagesBefore);
    // d took b's place: the same stage, so the same position in the sum.
    expect([...d.outputs]).toEqual([placeOfB]);
  });

  it('puts the same sources in the same places however often the mix is built', () => {
    const placesOf = () => {
      const into = new FakeNode();
      const mix = new OrderedMix(asContext, asNode(into), { ordered: true });
      const sources = Array.from({ length: 6 }, () => new FakeNode());
      const detach = sources.map((source) => mix.attach(asNode(source)));
      detach[1]!();
      detach[4]!();
      const late = [new FakeNode(), new FakeNode()];
      late.forEach((source) => mix.attach(asNode(source)));
      // Depth of each source below the target: its position in the sum.
      const depth = (n: FakeNode): number => (n === into ? 0 : 1 + depth([...n.outputs][0]!));
      return [...sources, ...late].map((source) => (source.outputs.size ? depth(source) : -1));
    };
    expect(placesOf()).toEqual(placesOf());
  });

  it('detaching twice is harmless, and dispose lets everything go', () => {
    const into = new FakeNode();
    const mix = new OrderedMix(asContext, asNode(into), { ordered: true });
    const sources = [new FakeNode(), new FakeNode(), new FakeNode()];
    const detach = sources.map((source) => mix.attach(asNode(source)));
    detach[2]!();
    detach[2]!();
    mix.dispose();
    expect(into.inputs.size).toBe(0);
    for (const source of sources) expect(source.outputs.size).toBe(0);
  });

  it('connects directly when not ordered (live contexts)', () => {
    const into = new FakeNode();
    const mix = new OrderedMix(asContext, asNode(into), { ordered: false });
    const sources = [new FakeNode(), new FakeNode(), new FakeNode()];
    const detach = sources.map((source) => mix.attach(asNode(source)));
    expect(into.inputs.size).toBe(3);
    expect(gainsMade).toBe(0);
    detach[0]!();
    expect(into.inputs.size).toBe(2);
  });
});
