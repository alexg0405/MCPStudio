#!/usr/bin/env node
/**
 * Interaction latency harness: drives the real app (dev server, `?perf=` fixtures) in headless Chrome with real
 * (trusted, CDP-injected) input and measures input-to-next-paint.
 *
 *   node scripts/perf-ui.mjs [--url http://localhost:5422] [--reps 9] [--only piano] [--fixture notes10k]
 *                            [--json out.json] [--label before] [--cold-pointer]
 *
 * Two kinds of numbers per scenario:
 *  - "paint": for every trusted input event (pointermove, keydown, wheel, ...) the time from event.timeStamp to the
 *    paint that follows the next animation frame (rAF + MessageChannel). Drags report every event of the drag.
 *  - "settle": for one-shot actions (open a window, switch patterns, undo) the time from the event to the paint after
 *    the last React commit it caused (plus any imperative redraw the scenario's `until` predicate waits for).
 * Each scenario also reports the worst Long Animation Frame (blocking duration) and Event Timing entries >= 16 ms
 * seen while it ran. Medians and p95 over all samples of all repetitions; the machine is shared, so use many reps.
 *
 * Reading a row:
 *  - "from dispatch": the same, counted from the moment the page's own listener ran, not from event.timeStamp. For
 *    drags the two differ by the vsync wait; for the wheel by about 18 ms more (the browser holds a wheel event until
 *    the page has answered the one before: the "playlist scroll (wheel, no zoom)" row, where the picture only slides,
 *    shows that floor), so compare wheel rows by this column.
 *  - "first of reps": the first sample of each repetition. The pointer is moved a little before every scenario (see
 *    --cold-pointer): the first pointer events of a page cost 20-30 ms in the browser itself (first drag 70 ms, first
 *    context menu 75 ms without it, 15-20 ms with it), and a person has always moved the mouse before the first click.
 *  - the pointermove "control" row is the floor of the machine at that moment.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const COLD_POINTER = argv.includes('--cold-pointer');
const BASE = arg('url', 'http://localhost:5422');
const REPS = Number(arg('reps', '9'));
const ONLY = arg('only', '');
const ONLY_FIXTURE = arg('fixture', '');
const JSON_OUT = arg('json', '');
const LABEL = arg('label', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

/** Injected before the app: records trusted input events and when they were painted. */
function instrument() {
  const L = (window.__lat = {
    rec: false,
    samples: [], // { type, ms }
    loaf: [], // blockingDuration, duration
    timing: [], // Event Timing >= 16 ms
    pend: [],
    batches: [],
    sched: false,
    arm: null,
    frames: [],
  });
  const mc = new MessageChannel();
  mc.port1.onmessage = () => {
    const t = performance.now();
    const batch = L.batches.shift() || [];
    for (const [ts, type, disp] of batch) L.samples.push({ type, ms: t - ts, app: t - disp });
  };
  const types = ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'click', 'wheel', 'contextmenu', 'dblclick'];
  for (const type of types) {
    addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        const a = L.arm;
        if (a) {
          if (type === a.type && a.t0 == null) {
            a.t0 = e.timeStamp;
            watch(a);
          }
          return;
        }
        if (!L.rec || !L.paintTypes.includes(type)) return;
        L.pend.push([e.timeStamp, type, performance.now()]);
        if (!L.sched) {
          L.sched = true;
          requestAnimationFrame(() => {
            L.sched = false;
            L.batches.push(L.pend.splice(0));
            mc.port2.postMessage(0);
          });
        }
      },
      { capture: true, passive: true },
    );
  }
  L.paintTypes = ['pointermove', 'keydown', 'wheel'];
  // After the armed event: sample every frame for `window` ms; the answer is the paint after the last frame in which
  // the React commit count changed (or the predicate first became true, whichever is later).
  function watch(a) {
    const commits = () => (window.__ag && window.__ag.perf ? window.__ag.perf.react.commits : 0);
    const c0 = commits();
    let lastChange = -1;
    let lastCommits = c0;
    let predAt = -1;
    const after = [];
    const ch = new MessageChannel();
    ch.port1.onmessage = (m) => {
      after[m.data] = performance.now();
    };
    let n = 0;
    let ending = 0;
    const step = () => {
      const now = performance.now();
      const c = commits();
      if (c !== lastCommits) {
        lastCommits = c;
        lastChange = n;
      }
      let ok = false;
      try {
        ok = a.pred ? !!a.pred() : true;
      } catch {
        /* the page is not ready for the predicate yet */
      }
      if (ok && predAt < 0) predAt = n;
      ch.port2.postMessage(n);
      n++;
      if (ending) {
        if (--ending === 0) {
          const idx = Math.max(a.commitsMatter ? lastChange : 0, predAt);
          a.result = predAt < 0 ? -1 : after[idx] - a.t0;
          a.commits = lastCommits - c0;
          a.done = true;
          return;
        }
      } else if (now - a.t0 > a.win) ending = 2;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) L.loaf.push({ block: e.blockingDuration, dur: e.duration });
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    /* not supported in this browser */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) L.timing.push({ name: e.name, dur: e.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: false });
  } catch {
    /* not supported in this browser */
  }
}

const FIXTURES = {
  stacked: 'stacked-song',
  notes10k: 'notes10k',
  mix30: 'mix30',
  rack150: 'rack150',
  huge: 'huge',
};

async function newPage(browser, fixture) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(instrument);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('agstudio:prefs:v1', JSON.stringify({ welcomeSeen: true }));
    } catch {
    /* not supported in this browser */
  }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/?perf=${fixture}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__ag && document.querySelector('[data-window-type]'), null, { timeout: 90000 });
  await sleep(2500); // idle prefetch of window chunks
  if (!COLD_POINTER) {
    // A person has moved the mouse before the first drag or click. The first pointer events of a page cost 20-30 ms
    // on their own (the browser's input path and hover handling start up), which is not the app's: send some first.
    for (let i = 0; i < 12; i++) await page.mouse.move(700 + i * 9, 420 + (i % 4) * 5);
    await sleep(200);
  }
  page.errors = errors;
  return page;
}

// ---------- helpers used by scenarios ----------

/** Only this window type is visible, maximized. */
async function only(page, type, props = null) {
  await page.evaluate(
    ([type, props]) => {
      const v = window.__ag.view.getState();
      for (const w of Object.values(v.windows)) if (w.visible && w.type !== type) v.hideWindow(w.id);
      v.showWindow(type, type, props);
      window.__ag.view.getState().setMaximized(type, true);
    },
    [type, props],
  );
  await sleep(400);
}
const frames = (page, n = 3) => page.evaluate((n) => new Promise((res) => { let i = 0; const f = () => (++i >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

async function rect(page, selector, index = 0) {
  return page.evaluate(([s, i]) => {
    const el = document.querySelectorAll(s)[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, [selector, index]);
}

/** Record paint latency of every trusted pointermove/keydown/wheel while `fn` runs. */
async function paint(page, fn, types = ['pointermove', 'keydown', 'wheel']) {
  await page.evaluate((types) => {
    const L = window.__lat;
    L.samples = [];
    L.loaf = [];
    L.timing = [];
    L.paintTypes = types;
    L.rec = true;
  }, types);
  await fn();
  await frames(page, 4);
  await sleep(60);
  return page.evaluate(() => {
    const L = window.__lat;
    L.rec = false;
    return { samples: L.samples.map((s) => s.ms), app: L.samples.map((s) => s.app), loaf: [...L.loaf], timing: [...L.timing] };
  });
}

/**
 * One-shot action: arm on the next trusted `type` event, run fn, and wait for the result. `pred` (a function source)
 * must be true; React commits within `window` ms of the event are waited for when `commitsMatter`.
 */
async function settle(page, type, fn, { pred = '', window: win = 500, commitsMatter = !pred } = {}) {
  await page.evaluate(
    ([type, pred, win, commitsMatter]) => {
      const L = globalThis.__lat;
      L.loaf = [];
      L.timing = [];
      L.arm = { type, t0: null, pred: pred ? new Function(`return (${pred})`) : null, win, commitsMatter, done: false, result: undefined };
    },
    [type, pred, win, commitsMatter],
  );
  await fn();
  await page.waitForFunction(() => globalThis.__lat.arm && globalThis.__lat.arm.done, null, { timeout: 15000, polling: 50 });
  return page.evaluate(() => {
    const L = globalThis.__lat;
    const a = L.arm;
    L.arm = null;
    return { settleLike: true, samples: a.result >= 0 ? [a.result] : [], missed: a.result < 0, commits: a.commits, loaf: [...L.loaf], timing: [...L.timing] };
  });
}

async function typeText(page, text, delay = 45) {
  await page.keyboard.type(text, { delay });
}

async function drag(page, from, to, { steps = 24, gap = 9, button = 'left', hold = false } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(gap);
  }
  if (!hold) await page.mouse.up({ button });
}

async function undoLast(page) {
  await page.keyboard.press('ControlOrMeta+z');
  await sleep(150);
}

// ---------- scenarios ----------
// Each: { id, fixtures, setup(page), rep(page, i) -> { samples, loaf, timing } }

const scenarios = [];
const scenario = (def) => scenarios.push(def);

/** Piano roll geometry from the live editor state. */
async function prGeometry(page) {
  return page.evaluate(() => {
    const pr = window.__ag.editor.getState().pianoRoll;
    const grid = document.querySelector('[data-window-type="piano-roll"] [class*="gridHost"]');
    const r = grid.getBoundingClientRect();
    return { px: pr.pxPerTick, row: pr.rowHeight, scrollTick: pr.scrollTick, scrollRow: pr.scrollRow, left: r.left, top: r.top, w: r.width, h: r.height };
  });
}
/** Select `n` notes that are visible and whose center is not covered by another note; returns screen points. */
async function selectVisibleNotes(page, n) {
  return page.evaluate((n) => {
    const s = window.__ag;
    const pr = s.editor.getState().pianoRoll;
    const grid = document.querySelector('[data-window-type="piano-roll"] [class*="gridHost"]');
    const r = grid.getBoundingClientRect();
    const p = s.doc.getState().project;
    const pid = s.view.getState().currentPatternId;
    const cid = s.session.getState().selectedChannelId;
    const notes = Object.values(p.patterns[pid].notes[cid] ?? {});
    const arr = Array.isArray(p.patterns[pid].notes[cid]) ? p.patterns[pid].notes[cid] : notes;
    const toX = (t) => r.left + (t - pr.scrollTick) * pr.pxPerTick;
    const toY = (k) => r.top + (127 - k - pr.scrollRow) * pr.rowHeight + pr.rowHeight / 2;
    const inView = arr.filter((nt) => {
      const x0 = toX(nt.tick);
      const x1 = toX(nt.tick + nt.length);
      const y = toY(nt.key);
      return x0 > r.left + 20 && x1 < r.right - 20 && y > r.top + 4 && y < r.bottom - 30 && x1 - x0 > 30;
    });
    const covered = (nt) => {
      const cx = nt.tick + nt.length / 2;
      return arr.some((o) => o.id !== nt.id && o.key === nt.key && o.tick <= cx && o.tick + o.length >= cx);
    };
    const free = inView.filter((nt) => !covered(nt));
    const ids = inView.slice(0, n).map((nt) => nt.id);
    if (free[0] && !ids.includes(free[0].id)) ids[0] = free[0].id;
    s.editor.getState().selectNotes(ids);
    const g = free[0];
    return g ? { ids: ids.length, x0: toX(g.tick), x1: toX(g.tick + g.length), y: toY(g.key), len: g.length } : null;
  }, n);
}

scenario({
  id: 'piano-roll draw a note',
  fixtures: ['notes10k'],
  async setup(page) {
    await only(page, 'piano-roll');
    await page.evaluate(() => {
      window.__ag.editor.getState().setPianoRoll({ tool: 'draw', scrollTick: 3840 * 66 });
    });
    await frames(page, 5);
  },
  async rep(page, i) {
    const g = await prGeometry(page);
    const x = g.left + 200 + (i % 5) * 60;
    const y = g.top + 60 + (i % 7) * 20;
    // one-shot: pointerdown adds the note; measure the paint after pointerdown/up
    const res = await paint(page, async () => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await sleep(20);
      await page.mouse.move(x + 12, y);
      await sleep(20);
      await page.mouse.up();
    }, ['pointerdown', 'pointermove', 'pointerup']);
    return res;
  },
});

scenario({
  id: 'piano-roll drag 50 notes',
  fixtures: ['notes10k', 'huge'],
  async setup(page) {
    await only(page, 'piano-roll');
    await page.evaluate(() => window.__ag.editor.getState().setPianoRoll({ tool: 'select', scrollTick: 0 }));
    await frames(page, 4);
  },
  async rep(page) {
    const n = await selectVisibleNotes(page, 50);
    await frames(page, 3);
    const y = n.y;
    const x = (n.x0 + n.x1) / 2;
    const res = await paint(page, async () => {
      await drag(page, { x, y }, { x: x + 90, y: y - 40 }, { steps: 20, gap: 10 });
    });
    await undoLast(page);
    return res;
  },
});

scenario({
  id: 'piano-roll resize',
  fixtures: ['notes10k', 'huge'],
  async setup(page) {
    await only(page, 'piano-roll');
    await page.evaluate(() => window.__ag.editor.getState().setPianoRoll({ tool: 'select', scrollTick: 0 }));
    await frames(page, 4);
  },
  async rep(page) {
    const n = await selectVisibleNotes(page, 50);
    await frames(page, 3);
    const x = n.x1 - 2;
    const res = await paint(page, async () => {
      await drag(page, { x, y: n.y }, { x: x + 70, y: n.y }, { steps: 20, gap: 10 });
    });
    await undoLast(page);
    return res;
  },
});

scenario({
  id: 'piano-roll undo 1000-note delete',
  fixtures: ['notes10k', 'huge'],
  async setup(page) {
    await only(page, 'piano-roll');
  },
  async rep(page) {
    await page.evaluate(() => {
      const s = window.__ag;
      const p = s.doc.getState().project;
      const pid = s.view.getState().currentPatternId;
      const cid = s.session.getState().selectedChannelId;
      const arr = Object.values(p.patterns[pid].notes[cid] ?? {});
      const list = Array.isArray(p.patterns[pid].notes[cid]) ? p.patterns[pid].notes[cid] : arr;
      s.editor.getState().selectNotes(list.slice(0, 1000).map((n) => n.id));
    });
    await frames(page, 3);
    await page.mouse.move(700, 400);
    await page.keyboard.press('Delete');
    await sleep(300);
    const undo = await settle(page, 'keydown', () => page.keyboard.press('ControlOrMeta+z'), { window: 700 });
    await sleep(300);
    const redo = await settle(page, 'keydown', () => page.keyboard.press('ControlOrMeta+Shift+z'), { window: 700 });
    await sleep(300);
    await undoLast(page); // restore
    return { samples: [...undo.samples, ...redo.samples], loaf: [...undo.loaf, ...redo.loaf], timing: [...undo.timing, ...redo.timing], extra: { undo: undo.samples[0], redo: redo.samples[0] } };
  },
});

scenario({
  id: 'control: pointermove over an inert area',
  fixtures: ['stacked', 'huge'],
  async setup() {},
  async rep(page) {
    return paint(page, async () => {
      await drag(page, { x: 200, y: 38 }, { x: 420, y: 38 }, { steps: 20, gap: 10, hold: true });
    });
  },
});

// -- playlist
async function clipPoint(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-window-type="playlist"] [class*="gridHost"]');
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
}
scenario({
  id: 'playlist click empty (menu)',
  fixtures: ['stacked', 'mix30', 'huge'],
  async setup(page) {
    await only(page, 'playlist');
    await page.evaluate(() => window.__ag.view.getState());
  },
  async rep(page, i) {
    const g = await clipPoint(page);
    const x = g.left + 300 + (i % 4) * 40;
    const y = g.top + 36 * 11 + 18;
    const res = await settle(page, 'pointerup', async () => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await sleep(30);
      await page.mouse.up();
    }, { pred: `!!document.querySelector('[role="menu"]')` });
    await page.keyboard.press('Escape');
    await sleep(150);
    return res;
  },
});

scenario({
  id: 'playlist drag a clip',
  fixtures: ['stacked', 'mix30', 'huge'],
  async setup(page) {
    await only(page, 'playlist');
    await page.evaluate(() => window.__ag.view.getState());
  },
  async rep(page) {
    const g = await clipPoint(page);
    // first lane's first clip, a few px inside it
    const from = { x: g.left + 160, y: g.top + 22 };
    const res = await paint(page, async () => {
      await drag(page, from, { x: from.x + 130, y: from.y + 36 }, { steps: 22, gap: 10 });
    });
    await undoLast(page);
    return res;
  },
});

scenario({
  id: 'playlist rubber-band select',
  fixtures: ['stacked', 'mix30', 'huge'],
  async setup(page) {
    await only(page, 'playlist');
    await page.evaluate(() => window.__ag.view.getState());
    await page.keyboard.press('s'); // select tool
    await frames(page, 3);
  },
  async rep(page) {
    const g = await clipPoint(page);
    const from = { x: g.left + 40, y: g.top + g.h - 60 };
    const res = await paint(page, async () => {
      await drag(page, from, { x: from.x + 700, y: g.top + 8 }, { steps: 26, gap: 10 });
    });
    await page.mouse.click(g.left + 20, g.top + g.h - 20);
    await sleep(100);
    return res;
  },
});

scenario({
  id: 'playlist zoom (ctrl+wheel)',
  fixtures: ['stacked', 'mix30', 'huge'],
  async setup(page) {
    await only(page, 'playlist');
  },
  async rep(page, i) {
    const g = await clipPoint(page);
    await page.mouse.move(g.left + 500, g.top + 120);
    const res = await paint(page, async () => {
      await page.keyboard.down('Control');
      for (let k = 0; k < 8; k++) {
        await page.mouse.wheel(0, i % 2 ? 100 : -100);
        await sleep(30);
      }
      await page.keyboard.up('Control');
    }, ['wheel']);
    return res;
  },
});

scenario({
  id: 'playlist scroll (wheel, no zoom)',
  fixtures: ['stacked', 'huge'],
  async setup(page) {
    await only(page, 'playlist');
  },
  async rep(page, i) {
    const g = await clipPoint(page);
    await page.mouse.move(g.left + 500, g.top + 120);
    // The same wheel pipeline as the zoom row, but the picture only slides: what is left over is the wheel's own latency.
    return paint(page, async () => {
      for (let k = 0; k < 8; k++) {
        await page.mouse.wheel(i % 2 ? -100 : 100, 0);
        await sleep(30);
      }
    }, ['wheel']);
  },
});

// -- mixer
scenario({
  id: 'mixer drag a fader',
  fixtures: ['mix30', 'huge'],
  async setup(page) {
    await only(page, 'mixer');
  },
  async rep(page, i) {
    const f = await rect(page, '[data-window-type="mixer"] [role="slider"][aria-label$="volume"]', 1 + (i % 3));
    const x = f.x + f.w / 2;
    const y0 = f.y + f.h / 2;
    const res = await paint(page, async () => {
      await drag(page, { x, y: y0 }, { x, y: y0 - 120 }, { steps: 18, gap: 10, hold: true });
      await drag(page, { x, y: y0 - 120 }, { x, y: y0 + 60 }, { steps: 18, gap: 10 });
    });
    await undoLast(page);
    return res;
  },
});

scenario({
  id: 'mixer drag a knob',
  fixtures: ['mix30', 'huge'],
  async setup(page) {
    await only(page, 'mixer');
  },
  async rep(page, i) {
    const k = await page.evaluate((i) => {
      const c = document.querySelectorAll('[data-window-type="mixer"] [role="slider"][aria-label$="pan"]')[1 + (i % 3)];
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);
    const res = await paint(page, async () => {
      await drag(page, { x: k.x, y: k.y }, { x: k.x, y: k.y - 60 }, { steps: 18, gap: 10, hold: true });
      await drag(page, { x: k.x, y: k.y - 60 }, { x: k.x, y: k.y + 20 }, { steps: 18, gap: 10 });
    });
    await undoLast(page);
    return res;
  },
});

// -- channel rack
scenario({
  id: 'channel rack click a step',
  fixtures: ['rack150', 'stacked', 'huge'],
  async setup(page) {
    await only(page, 'channel-rack');
  },
  async rep(page, i) {
    const b = await page.evaluate((i) => {
      const steps = [...document.querySelectorAll('[data-window-type="channel-rack"] [data-step]')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.top > 150 && r.bottom < 850;
      });
      const e = steps[(i * 37) % steps.length];
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);
    const res = await paint(page, async () => {
      await page.mouse.move(b.x, b.y);
      await page.mouse.down();
      await sleep(25);
      await page.mouse.move(b.x + 1, b.y);
      await sleep(25);
      await page.mouse.up();
    }, ['pointerdown', 'pointermove', 'pointerup']);
    return res;
  },
});

// -- windows and menus
const WIN_FIXTURES = ['stacked', 'notes10k', 'mix30', 'rack150', 'huge'];
scenario({
  id: 'open Studio window',
  fixtures: WIN_FIXTURES,
  async setup() {},
  async rep(page) {
    const res = await settle(page, 'click', async () => {
      await page.click('[aria-label="Studio"]');
    }, { pred: `!!document.querySelector('[data-window-type="assistant"] textarea')`, window: 800 });
    await sleep(200);
    await page.evaluate(() => window.__ag.view.getState().hideWindow('assistant'));
    await sleep(200);
    return res;
  },
});

scenario({
  id: 'type in the Studio box',
  fixtures: WIN_FIXTURES,
  async setup(page) {
    await page.click('[aria-label="Studio"]');
    await page.waitForSelector('[data-window-type="assistant"] textarea');
    await sleep(400);
  },
  async rep(page) {
    await page.focus('[data-window-type="assistant"] textarea');
    const res = await paint(page, async () => {
      await typeText(page, 'make the drums punchier and add a bass line', 45);
    }, ['keydown']);
    await page.fill('[data-window-type="assistant"] textarea', '');
    return res;
  },
});

scenario({
  id: 'open a plugin window',
  fixtures: ['mix30', 'rack150', 'stacked', 'huge'],
  async setup(page) {
    await only(page, 'channel-rack');
  },
  async rep(page, i) {
    const b = await page.evaluate((i) => {
      const names = [...document.querySelectorAll('[data-window-type="channel-rack"] [data-channel-id] button[class*="name"]')];
      const e = names[i % Math.min(6, names.length)];
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);
    const res = await settle(page, 'dblclick', async () => {
      await page.mouse.dblclick(b.x, b.y);
    }, { pred: `!!document.querySelector('[data-window-type="plugin"]')`, window: 900 });
    await sleep(200);
    await page.evaluate(() => {
      const v = window.__ag.view.getState();
      for (const w of Object.values(v.windows)) if (w.type === 'plugin') v.hideWindow(w.id);
    });
    await sleep(200);
    return res;
  },
});

scenario({
  id: 'open a context menu',
  fixtures: WIN_FIXTURES,
  async setup(page) {
    await only(page, 'channel-rack');
  },
  async rep(page, i) {
    const b = await page.evaluate((i) => {
      const names = [...document.querySelectorAll('[data-window-type="channel-rack"] [data-channel-id] button[class*="name"]')];
      const e = names[i % Math.min(6, names.length)];
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);
    const res = await settle(page, 'contextmenu', async () => {
      await page.mouse.click(b.x, b.y, { button: 'right' });
    }, { pred: `!!document.querySelector('[role="menu"]')`, window: 600 });
    await page.keyboard.press('Escape');
    await sleep(150);
    return res;
  },
});

scenario({
  id: 'open action search (Mod+K)',
  fixtures: WIN_FIXTURES,
  async setup() {},
  async rep(page) {
    const res = await settle(page, 'keydown', async () => {
      await page.keyboard.press('ControlOrMeta+k');
    }, { pred: `document.activeElement && document.activeElement.getAttribute('aria-controls') === 'ag-palette-list'`, window: 600 });
    await page.keyboard.press('Escape');
    await sleep(150);
    return res;
  },
});

scenario({
  id: 'type into action search',
  fixtures: WIN_FIXTURES,
  async setup() {},
  async rep(page) {
    await page.keyboard.press('ControlOrMeta+k');
    await sleep(300);
    const res = await paint(page, async () => {
      await typeText(page, 'reverb delay mixer', 60);
    }, ['keydown']);
    await page.keyboard.press('Escape');
    await sleep(150);
    return res;
  },
});

scenario({
  id: 'switch patterns',
  fixtures: ['rack150', 'stacked', 'huge'],
  async setup(page) {
    await only(page, 'channel-rack');
  },
  async rep(page) {
    const target = await page.evaluate(() => {
      const s = window.__ag;
      const order = s.doc.getState().project.patternOrder;
      const cur = s.view.getState().currentPatternId;
      const next = order[(order.indexOf(cur) + 1) % order.length];
      return { id: next, name: s.doc.getState().project.patterns[next].name, n: order.length };
    });
    const items = await page.evaluate((name) => {
      const el = [...document.querySelectorAll('button[data-hint*="click to edit, right-click to play it"]')].find((e) => e.textContent === name);
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, target.name);
    if (!items) return { samples: [], loaf: [], timing: [], missed: true };
    const res = await settle(page, 'click', async () => {
      await page.mouse.click(items.x, items.y);
    }, { pred: `window.__ag.view.getState().currentPatternId === ${JSON.stringify(target.id)}`, window: 700 });
    await sleep(200);
    return res;
  },
});

scenario({
  id: 'undo / redo a clip move',
  fixtures: ['stacked', 'mix30', 'huge'],
  async setup(page) {
    await only(page, 'playlist');
  },
  async rep(page) {
    const g = await clipPoint(page);
    const from = { x: g.left + 160, y: g.top + 22 };
    await drag(page, from, { x: from.x + 130, y: from.y + 36 }, { steps: 8, gap: 10 });
    await sleep(200);
    const undo = await settle(page, 'keydown', () => page.keyboard.press('ControlOrMeta+z'), { window: 600 });
    await sleep(200);
    const redo = await settle(page, 'keydown', () => page.keyboard.press('ControlOrMeta+Shift+z'), { window: 600 });
    await sleep(200);
    await undoLast(page);
    return { samples: [...undo.samples, ...redo.samples], loaf: [...undo.loaf, ...redo.loaf], timing: [...undo.timing, ...redo.timing], extra: { undo: undo.samples[0], redo: redo.samples[0] } };
  },
});

// -- big-project scenarios
scenario({
  id: 'open the mixer',
  fixtures: ['mix30', 'huge'],
  async setup(page) {
    await only(page, 'channel-rack');
  },
  async rep(page) {
    const res = await settle(page, 'keydown', () => page.keyboard.press('F9'), {
      pred: `document.querySelectorAll('[data-window-type="mixer"] [role="slider"]').length > 5`,
      window: 2500,
    });
    await sleep(300);
    await page.evaluate(() => window.__ag.view.getState().hideWindow('mixer'));
    await sleep(300);
    return res;
  },
});

scenario({
  id: 'channel rack scroll (wheel)',
  fixtures: ['rack150', 'huge'],
  async setup(page) {
    await only(page, 'channel-rack');
  },
  async rep(page, i) {
    const b = await rect(page, '[data-window-type="channel-rack"]');
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    return paint(page, async () => {
      for (let k = 0; k < 10; k++) {
        await page.mouse.wheel(0, i % 2 ? -240 : 240);
        await sleep(30);
      }
    }, ['wheel']);
  },
});

scenario({
  id: 'undo / redo a 1,000-clip delete',
  fixtures: ['huge'],
  async setup(page) {
    await only(page, 'playlist');
  },
  async rep(page) {
    await page.evaluate(() => {
      const s = window.__ag;
      const ids = Object.keys(s.doc.getState().project.playlist.clips).slice(0, 1000);
      s.history.transact('Delete 1000 clips', (d) => {
        for (const id of ids) delete d.playlist.clips[id];
      });
    });
    await sleep(500);
    await page.mouse.move(700, 400);
    const undo = await settle(page, 'keydown', () => page.keyboard.press('ControlOrMeta+z'), { window: 900 });
    await sleep(400);
    const redo = await settle(page, 'keydown', () => page.keyboard.press('ControlOrMeta+Shift+z'), { window: 900 });
    await sleep(400);
    await undoLast(page);
    return { samples: [...undo.samples, ...redo.samples], loaf: [...undo.loaf, ...redo.loaf], timing: [...undo.timing, ...redo.timing], extra: { undo: undo.samples[0], redo: redo.samples[0] } };
  },
});

// ---------- runner ----------
const rows = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const todo = [];
  for (const sc of scenarios) {
    if (ONLY && !sc.id.toLowerCase().includes(ONLY.toLowerCase())) continue;
    for (const f of sc.fixtures) {
      if (ONLY_FIXTURE && f !== ONLY_FIXTURE) continue;
      todo.push([sc, f]);
    }
  }
  for (const [sc, f] of todo) {
    // A fresh page per scenario so state never leaks between them.
    const page = await newPage(browser, FIXTURES[f]);
    const all = [];
    const loafs = [];
    const timings = [];
    let missed = 0;
    let err = '';
    const extras = [];
    const apps = [];
    const repFirsts = []; // the first sample of each repetition: how much of the cost is only the first time
    let first = NaN;
    try {
      await sc.setup(page);
      for (let i = 0; i < REPS; i++) {
        const r = await sc.rep(page, i);
        if (i === 0 && r.samples.length) first = r.samples[0];
        if (r.samples.length) repFirsts.push(r.samples[0]);
        if (i === 0 && r.settleLike) continue;
        all.push(...r.samples);
        if (r.app) apps.push(...r.app);
        loafs.push(...r.loaf);
        timings.push(...r.timing);
        if (r.missed) missed++;
        if (r.extra) extras.push(r.extra);
      }
    } catch (e) {
      err = String(e).split('\n')[0].slice(0, 160);
    }
    const row = {
      scenario: sc.id,
      fixture: f,
      n: all.length,
      first,
      median: pct(all, 50),
      p95: pct(all, 95),
      max: all.length ? Math.max(...all) : NaN,
      appMedian: pct(apps, 50),
      repFirsts,
      loafMax: loafs.length ? Math.max(...loafs.map((l) => l.block)) : 0,
      loafCount: loafs.length,
      slowEvents: timings.length,
      missed,
      err,
      pageErrors: page.errors.length ? page.errors.slice(0, 2) : undefined,
      extras: extras.length ? { undo: pct(extras.map((e) => e.undo).filter((x) => x != null), 50), redo: pct(extras.map((e) => e.redo).filter((x) => x != null), 50) } : undefined,
    };
    rows.push(row);
    const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1).padStart(7) : '    n/a');
    console.log(`${(sc.id + ' [' + f + ']').padEnd(52)} n=${String(row.n).padStart(4)} first ${f1(row.first)} med ${f1(row.median)} p95 ${f1(row.p95)} max ${f1(row.max)}${Number.isFinite(row.appMedian) ? ' | from dispatch med ' + f1(row.appMedian).trim() : ''} | first of reps ${repFirsts.slice(0, 4).map((x) => x.toFixed(0)).join(',')} | LoAF ${row.loafCount}x max-block ${row.loafMax.toFixed(0)}ms | slow-ev ${row.slowEvents}${missed ? ' MISSED ' + missed : ''}${err ? ' ERR ' + err : ''}${row.extras ? ' ' + JSON.stringify(row.extras) : ''}`);
    await page.context().close();
  }
} finally {
  await browser.close();
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, reps: REPS, rows }, null, 2));
