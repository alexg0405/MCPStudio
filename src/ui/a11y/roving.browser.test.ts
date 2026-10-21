/**
 * Roving focus groups (headless Chrome, plain DOM): a toolbar, tab strip or radio group is one Tab stop even without
 * the `data-roving` mark, a menu that opens inside a group is not part of it, a control that takes no room cannot be
 * the stop, and the arrow keys also work while a dialog or menu has stopped the global shortcut handler.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { installRoving } from './roving';

/** Builds a block of markup in the page and waits for the observer's microtask to give it its Tab stops. */
async function mount(html: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return host;
}

const stopsIn = (el: Element): Element[] => [...el.querySelectorAll('[tabindex="0"]')];

describe('roving focus groups', () => {
  let hosts: HTMLElement[] = [];
  beforeAll(() => {
    installRoving();
  });
  afterEach(() => {
    for (const host of hosts) host.remove();
    hosts = [];
  });
  const add = async (html: string) => {
    const host = await mount(html);
    hosts.push(host);
    return host;
  };

  it('a role="toolbar" without the data-roving mark is one Tab stop, and the arrows move inside it', async () => {
    const host = await add('<div role="toolbar" aria-label="Tools"><button id="a">A</button><button id="b">B</button><button id="c">C</button></div>');
    expect(stopsIn(host).map((el) => el.id)).toEqual(['a']);
    host.querySelector<HTMLElement>('#a')!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement?.id).toBe('b');
    expect(stopsIn(host).map((el) => el.id)).toEqual(['b']);
    await userEvent.keyboard('{End}');
    expect(document.activeElement?.id).toBe('c');
    await userEvent.keyboard('{Home}');
    expect(document.activeElement?.id).toBe('a');
  });

  it('a radio group and a tab strip are groups too; aria-orientation vertical turns the arrows to Up and Down', async () => {
    const host = await add(
      '<div role="radiogroup" aria-label="Pick"><button role="radio" aria-checked="true" id="r1">1</button><button role="radio" aria-checked="false" id="r2">2</button></div>' +
        '<div role="tablist" aria-orientation="vertical" aria-label="Tabs"><button role="tab" id="t1">1</button><button role="tab" id="t2">2</button></div>',
    );
    expect(stopsIn(host).map((el) => el.id)).toEqual(['r1', 't1']);
    host.querySelector<HTMLElement>('#t1')!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement?.id).toBe('t1');
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.id).toBe('t2');
  });

  it('the entries of a menu that opens inside the group are not the group\'s own controls', async () => {
    const host = await add(
      '<div role="menubar" data-roving aria-label="Bar"><button role="menuitem" id="file">File</button><button role="menuitem" id="edit">Edit</button>' +
        '<div role="menu" aria-label="File"><button role="menuitem" id="open">Open</button></div></div>',
    );
    expect(stopsIn(host).map((el) => el.id)).toEqual(['file']);
    expect(host.querySelector('#open')?.getAttribute('tabindex')).toBeNull();
  });

  it('a control that takes no room is never the Tab stop', async () => {
    const host = await add('<div role="toolbar" aria-label="T"><button id="hidden" style="display:none">x</button><button id="shown">y</button></div>');
    expect(stopsIn(host).map((el) => el.id)).toEqual(['shown']);
  });

  it('controls added later join the group without moving its Tab stop, and the stop moves on when its control leaves', async () => {
    const host = await add('<div role="toolbar" aria-label="T"><button id="a">A</button><button id="b">B</button></div>');
    const group = host.querySelector<HTMLElement>('[role="toolbar"]')!;
    host.querySelector<HTMLElement>('#b')!.focus();
    expect(stopsIn(host).map((el) => el.id)).toEqual(['b']);
    group.insertAdjacentHTML('afterbegin', '<span class="row"><button id="n1">1</button><button id="n2">2</button></span>');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopsIn(host).map((el) => el.id)).toEqual(['b']);
    expect(host.querySelector('#n1')?.getAttribute('tabindex')).toBe('-1');
    expect(host.querySelector('#n2')?.getAttribute('tabindex')).toBe('-1');
    host.querySelector('#b')!.remove();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopsIn(host)).toHaveLength(1);
  });

  it('a group that has no Tab stop yet gets one from a control added to it', async () => {
    const host = await add('<div role="toolbar" aria-label="T"></div>');
    host.querySelector('[role="toolbar"]')!.insertAdjacentHTML('beforeend', '<button id="x">x</button><button id="y">y</button>');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopsIn(host).map((el) => el.id)).toEqual(['x']);
  });

  it('the arrows work when the global handler has stood down for a dialog (the key reaches the document)', async () => {
    const host = await add('<div role="dialog" aria-modal="true"><div role="radiogroup" aria-label="Pick"><button role="radio" aria-checked="true" id="x">x</button><button role="radio" aria-checked="false" id="y">y</button></div></div>');
    host.querySelector<HTMLElement>('#x')!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement?.id).toBe('y');
  });
});
