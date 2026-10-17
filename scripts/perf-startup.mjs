#!/usr/bin/env node
/**
 * Startup measurement (use a production build served by `vite preview`; the dev server works too but loads
 * hundreds of unbundled modules):
 *
 *   npx vite build --outDir dist-perf && npx vite preview --outDir dist-perf --port 5422 &
 *   node scripts/perf-startup.mjs [--url http://localhost:5422] [--runs 9] [--label before] [--json out.json]
 *
 * Per run, in headless Chrome:
 *  - FP / FCP (Paint Timing), the app's own marks (ag:script, ag:loaded, ag:services, ag:features, ag:render,
 *    ag:first-commit), and the time the toolbar is in the DOM.
 *  - TTI: the end of the last long task (>= 50 ms) before the first 750 ms window without one, after first commit.
 *  - First input: a click on the Studio pill the moment it exists; its delay and handling time (Event Timing).
 *  - Long tasks during startup (count, total ms, max ms), JS bytes and files fetched before the first commit,
 *    JS bytes decoded in all, and V8 script compile time before the first commit (from a trace).
 * "cold" runs use a fresh browser context (empty HTTP cache, empty IndexedDB); "warm" runs reload in the same
 * context (HTTP cache, saved session). Medians and p95 over the runs.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
// --url may list several comma-separated URLs: the runs alternate between them, so a busy machine hits all alike.
const BASES = arg('url', 'http://localhost:5422').split(',');
const RUNS = Number(arg('runs', '9'));
const LABEL = arg('label', '');
const JSON_OUT = arg('json', '');
// --fresh starts a new browser for every run (default: one browser for all runs). The first AudioContext of a browser
// process starts Chrome's audio service on the main thread (~200 ms in headless Chrome here, 1-2 ms for the next
// ones), so only fresh browsers see what a person opening the app after launching Chrome sees.
const FRESH = argv.includes('--fresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

function instrument() {
  window.__st = { longtasks: [], first: null, toolbarAt: -1, clickedAt: -1 };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__st.longtasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* not supported in this browser */
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__st.first = { start: e.startTime, delay: e.processingStart - e.startTime, dur: e.duration };
    }).observe({ type: 'first-input', buffered: true });
  } catch {
    /* not supported in this browser */
  }
  const poll = () => {
    if (window.__st.toolbarAt < 0 && document.querySelector('[aria-label="Studio"]')) window.__st.toolbarAt = performance.now();
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

async function oneRun(context, BASE) {
  const page = await context.newPage();
  await page.addInitScript(instrument);
  await page.addInitScript(() => {
    try {
      const k = 'agstudio:prefs:v1';
      if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ welcomeSeen: true }));
    } catch {
    /* not supported in this browser */
  }
  });
  const client = await context.newCDPSession(page);
  await client.send('Performance.enable').catch(() => {});
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  // First input: click the Studio pill as soon as it is there.
  const handle = await page.waitForSelector('[aria-label="Studio"]', { timeout: 60000 });
  const box = await handle.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(2500);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]));
    const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((x) => x.name.startsWith('ag:')).map((x) => [x.name.slice(3), x.startTime]));
    const st = window.__st;
    const commit = marks['first-commit'] ?? NaN;
    const all = performance.getEntriesByType('resource');
    const res = all.filter((r) => /\.(js|ts|tsx|mjs)(\?|$)/.test(r.name.split('/').pop() ?? '') || r.initiatorType === 'script');
    const before = res.filter((r) => r.responseEnd <= commit);
    // The marks are dev-only for first-commit; production has the toolbar poll.
    const ready = st.toolbarAt;
    const lts = st.longtasks.filter((l) => l.start < ready + 3000).sort((a, b) => a.start - b.start);
    let tti = ready;
    for (const l of lts) if (l.start < tti + 750) tti = Math.max(tti, l.start + l.dur);
    const startupLts = lts.filter((l) => l.start < tti);
    return {
      fp: paints['first-paint'],
      fcp: paints['first-contentful-paint'],
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      ready,
      tti,
      marks,
      firstInputDelay: st.first ? st.first.delay : NaN,
      firstInputDur: st.first ? st.first.dur : NaN,
      ltCount: startupLts.length,
      ltTotal: startupLts.reduce((a, l) => a + l.dur, 0),
      ltMax: startupLts.reduce((a, l) => Math.max(a, l.dur), 0),
      jsFilesBeforeReady: res.filter((r) => r.responseEnd <= ready).length,
      jsBytesBeforeReady: res.filter((r) => r.responseEnd <= ready).reduce((a, r) => a + r.decodedBodySize, 0),
      jsWire: res.filter((r) => r.responseEnd <= ready).reduce((a, r) => a + r.transferSize, 0),
      requestsBeforeReady: all.filter((r) => r.responseEnd <= ready).length,
      jsFilesAll: res.length,
      jsBytesAll: res.reduce((a, r) => a + r.decodedBodySize, 0),
      jsFilesBeforeCommit: before.length,
    };
  });
  const perf = await client.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  const get = (n) => perf.metrics.find((x) => x.name === n)?.value ?? NaN;
  m.scriptMs = get('ScriptDuration') * 1000;
  m.layoutMs = get('LayoutDuration') * 1000;
  m.taskMs = get('TaskDuration') * 1000;
  await page.close();
  return m;
}

const launch = () => chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
let browser = FRESH ? null : await launch();
const outs = BASES.map((url) => ({ url, label: LABEL, cold: [], warm: [] }));
try {
  for (let i = 0; i < RUNS; i++) {
    for (const o of outs) {
      const b = browser ?? (await launch());
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
      o.cold.push(await oneRun(ctx, o.url));
      o.warm.push(await oneRun(ctx, o.url));
      await ctx.close();
      if (!browser) await b.close();
    }
  }
} finally {
  await browser?.close();
}
const keys = ['fp', 'fcp', 'ready', 'tti', 'firstInputDelay', 'firstInputDur', 'ltCount', 'ltTotal', 'ltMax', 'requestsBeforeReady', 'jsFilesBeforeReady', 'jsBytesBeforeReady', 'jsWire', 'jsFilesAll', 'jsBytesAll', 'scriptMs', 'taskMs'];
for (const out of outs)
for (const kind of ['cold', 'warm']) {
  console.log(`\n== ${out.url} ${kind} (${out[kind].length} runs) ${LABEL}`);
  for (const k of keys) {
    const xs = out[kind].map((r) => r[k]);
    const f = (x) => (Number.isFinite(x) ? (k.includes('Bytes') || k === 'jsWire' ? (x / 1024).toFixed(0) + ' kB' : x.toFixed(1)) : 'n/a');
    console.log(`${k.padEnd(20)} median ${f(pct(xs, 50)).padStart(10)}  p95 ${f(pct(xs, 95)).padStart(10)}`);
  }
  const mk = Object.keys(out[kind][0].marks || {});
  for (const k of mk) console.log(`mark ${k.padEnd(15)} median ${pct(out[kind].map((r) => r.marks[k]), 50).toFixed(1)}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(outs, null, 2));
