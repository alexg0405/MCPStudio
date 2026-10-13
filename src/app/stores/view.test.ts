import { describe, expect, it } from 'vitest';
import { createViewStore } from './view';

describe('view store windows', () => {
  it('stacks windows by focus, also after a restored layout with equal z values', () => {
    const v = createViewStore();
    v.setState({
      windows: {
        a: { id: 'a', type: 'a', props: null, rect: null, z: 1, visible: true, maximized: false },
        b: { id: 'b', type: 'b', props: null, rect: null, z: 1, visible: true, maximized: false },
      },
    });
    v.getState().focusWindow('a');
    const z = (id: string) => v.getState().windows[id]!.z;
    expect(z('a')).toBeGreaterThan(z('b'));
    v.getState().focusWindow('b');
    expect(z('b')).toBeGreaterThan(z('a'));
    v.getState().showWindow('c', 'c');
    expect(z('c')).toBeGreaterThan(z('b'));
  });

  it('toggles like FL: hide when focused, otherwise bring to front', () => {
    const v = createViewStore();
    v.getState().showWindow('rack', 'rack');
    v.getState().showWindow('roll', 'roll');
    v.getState().toggleWindow('rack', 'rack'); // visible but not focused → focus
    expect(v.getState().focusedId).toBe('rack');
    v.getState().toggleWindow('rack', 'rack'); // focused → hide
    expect(v.getState().windows['rack']!.visible).toBe(false);
    expect(v.getState().focusedId).toBe('roll');
  });
});
