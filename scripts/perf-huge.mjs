#!/usr/bin/env node
/**
 * Big-project measurements on the `?perf=huge` fixture (200 channels, 100 mixer tracks, 500 patterns, 2,000 clips...).
 * Dev server, headless Chrome. The interface rows (scroll, zoom, drags, menus) are `scripts/perf-ui.mjs --fixture huge`
 * and the smooth-follow row is `scripts/perf-follow.mjs --fixture huge`; this script measures the rest:
 *
 *   node scripts/perf-huge.mjs [--url http://localhost:5402] [--only load,save,memory,idle,engine,context,render]
 *                              [--reps 3] [--json out.json] [--label before]
 *
 *  load     page start to a painted project, then the file round trip: build the .agproj, read it, replace the project
 *  save     file build, autosave (serialize on the main thread, zip in the Worker), a version save point; main-thread
 *           blocking (long animation frames) while each ran
 *  memory   JS heap after a collection, decoded audio in the sample cache, the page's whole memory, live audio nodes
 *  idle     per-frame JS and React commits with nothing happening; script time per second
 *  engine   audio thread load (CDP render capacity) idle and playing, the audio clock's keep-up, reboot time
 *  context  the AI context text: time to build and its size
 *  render   a 30 s offline render: time, times realtime, and the hash of the audio (must not change between builds)
 *
 * Numbers are medians over `--reps` fresh pages; a busy machine adds noise, so compare runs made back to back.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const BASE = arg('url', 'http://localhost:5402');
const ONLY = arg('only', 'load,save,memory,idle,engine,context,render').split(',');
const REPS = Number(arg('reps', '3'));
const LABEL = arg('label', '');
const JSON_OUT = arg('json', '');
const FIXTURE = arg('fixture', 'huge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

/** A fresh page on the fixture, with the audio graph watched through CDP. */
async function openPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('agstudio:prefs:v1', JSON.stringify({ welcomeSeen: true }));
    } catch {
      /* storage is not available */
    }
    window.__loaf = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__loaf.push({ block: e.blockingDuration, dur: e.duration, at: e.startTime });
      }).observe({ type: 'long-animation-frame' });
    } catch {
      /* not supported in this browser */
    }
  });
  const client = await ctx.newCDPSession(page);
  const watch = { nodes: new Map(), contexts: [] };
  client.on('WebAudio.contextCreated', (e) => watch.contexts.push(e.context.contextId));
  client.on('WebAudio.audioNodeCreated', (e) => watch.nodes.set(e.node.nodeId, e.node.nodeType));
  client.on('WebAudio.audioNodeWillBeDestroyed', (e) => watch.nodes.delete(e.nodeId));
  await client.send('WebAudio.enable');
  await client.send('Performance.enable');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const started = Date.now();
  await page.goto(`${BASE}/?perf=${FIXTURE}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__ag && document.querySelector('[data-window-type]'), null, { timeout: 180000 });
  const readyMs = Date.now() - started;
  return { ctx, page, client, watch, errors, readyMs };
}

const metric = (m, name) => m.metrics.find((x) => x.name === name)?.value ?? 0;

/** Live audio nodes by kind, from the CDP events. */
function nodeCounts(watch) {
  const counts = {};
  for (const t of watch.nodes.values()) counts[t] = (counts[t] ?? 0) + 1;
  return { total: watch.nodes.size, worklets: counts.AudioWorklet ?? 0, gains: counts.Gain ?? 0, counts };
}

/** Average render capacity (share of the audio callback's time used) and how fast the audio clock ran, over `seconds`. */
async function audioLoad(client, watch, seconds) {
  const id = watch.contexts[watch.contexts.length - 1];
  const read = async () => (await client.send('WebAudio.getRealtimeData', { contextId: id })).realtimeData;
  const first = await read();
  const t0 = Date.now();
  const caps = [];
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(500);
    caps.push((await read()).renderCapacity);
  }
  const last = await read();
  const wall = (Date.now() - t0) / 1000;
  return { capacity: caps.reduce((a, b) => a + b, 0) / caps.length, capacityMax: Math.max(...caps), clockRate: (last.currentTime - first.currentTime) / wall };
}

// ---------- stages: each gets a fresh page and returns a flat object of numbers ----------

async function stageLoad(env) {
  const { page } = env;
  const r = await page.evaluate(async () => {
    const s = window.__ag;
    const io = await import('/src/app/persistence/project-io.ts');
    const out = {};
    let t = performance.now();
    const bytes = await s.files.build();
    out.buildFileMs = performance.now() - t;
    out.fileKB = bytes.length / 1024;
    t = performance.now();
    const opened = await io.openProjectFile(bytes);
    out.openParseMs = performance.now() - t;
    // Replace the project like File > Open does, then wait for the engine and the first paint of the new project.
    t = performance.now();
    s.files.replace(opened.project, opened.view, { name: 'huge', handle: null, fileKey: null });
    out.replaceSyncMs = performance.now() - t;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    out.replacePaintedMs = performance.now() - t;
    await s.engine.ready();
    out.replaceReadyMs = performance.now() - t;
    return out;
  });
  return { coldReadyMs: env.readyMs, ...r };
}

async function stageSave(env) {
  const { page } = env;
  await sleep(2000);
  return page.evaluate(async () => {
    const s = window.__ag;
    const project = await import('/src/core/io/project-file.ts');
    const zip = await import('/src/app/persistence/zip-async.ts');
    const out = {};
    const input = () => ({ project: s.doc.getState().project, view: {}, samples: new Map(), appVersion: '0' });
    window.__loaf.length = 0;
    let t = performance.now();
    const parts = project.projectFileParts(input());
    out.autosaveSerializeMs = performance.now() - t;
    t = performance.now();
    const bytes = await zip.zipOffThread(parts);
    out.autosaveZipWorkerMs = performance.now() - t;
    out.autosaveKB = bytes.length / 1024;
    t = performance.now();
    await s.files.build();
    out.fileBuildMs = performance.now() - t;
    t = performance.now();
    const rec = await s.versions.saveNamed('perf');
    out.versionSaveMs = performance.now() - t;
    out.versionSaved = rec ? 1 : 0;
    await new Promise((r) => setTimeout(r, 300));
    out.loafMaxBlockMs = Math.max(0, ...window.__loaf.map((l) => l.block));
    return out;
  });
}

async function stageMemory(env) {
  const { page, watch } = env;
  await sleep(3000);
  const r = await page.evaluate(async () => {
    const s = window.__ag;
    // Chrome runs with --js-flags=--expose-gc: collect first so the heap figure is what stays alive.
    const collect = globalThis.gc;
    if (typeof collect === 'function') {
      collect();
      collect();
    }
    const out = { jsHeapMB: performance.memory.usedJSHeapSize / 1e6, decodedAudioMB: s.sampleCache.usedBytes / 1e6 };
    try {
      out.pageMemoryMB = (await performance.measureUserAgentSpecificMemory()).bytes / 1e6;
    } catch {
      out.pageMemoryMB = NaN;
    }
    return out;
  });
  const n = nodeCounts(watch);
  return { ...r, audioNodes: n.total, workletNodes: n.worklets, gainNodes: n.gains };
}

async function stageIdle(env) {
  const { page, client } = env;
  await sleep(3000);
  await page.evaluate(() => {
    const s = window.__ag;
    s.perf.frames.samples.length = 0;
    s.perf.frames.recording = true;
    s.perf.react0 = s.perf.react.commits;
    window.__loaf.length = 0;
  });
  const m0 = await client.send('Performance.getMetrics');
  const t0 = Date.now();
  await sleep(6000);
  const secs = (Date.now() - t0) / 1000;
  const m1 = await client.send('Performance.getMetrics');
  const r = await page.evaluate(() => {
    const s = window.__ag;
    s.perf.frames.recording = false;
    const f = [...s.perf.frames.samples].sort((a, b) => a - b);
    return { frameCount: f.length, frameMedian: f[Math.floor(f.length / 2)] ?? 0, frameP95: f[Math.floor(f.length * 0.95)] ?? 0, commits: s.perf.react.commits - s.perf.react0, loafs: window.__loaf.length };
  });
  return {
    idleFrameJsMedianMs: r.frameMedian,
    idleFrameJsP95Ms: r.frameP95,
    idleReactCommits: r.commits,
    idleScriptMsPerSec: ((metric(m1, 'ScriptDuration') - metric(m0, 'ScriptDuration')) * 1000) / secs,
    idleTaskMsPerSec: ((metric(m1, 'TaskDuration') - metric(m0, 'TaskDuration')) * 1000) / secs,
    idleLongFrames: r.loafs,
  };
}

async function stageEngine(env) {
  const { page, client, watch } = env;
  await sleep(2500);
  const out = {};
  const idle = await audioLoad(client, watch, 5);
  out.idleAudioLoad = idle.capacity;
  out.idleClockRate = idle.clockRate;
  await page.evaluate(() => window.__ag.commands.run('transport.playPause'));
  await sleep(2500);
  const playing = await audioLoad(client, watch, 6);
  out.playAudioLoad = playing.capacity;
  out.playClockRate = playing.clockRate;
  const stats = await page.evaluate(() => window.__ag.engine.stats());
  out.playKeepUp = stats.keepUp ?? NaN;
  out.playLateEvents = stats.lateEvents;
  await page.evaluate(() => window.__ag.commands.run('transport.playPause'));
  await sleep(500);
  out.rebootMs = await page.evaluate(async () => {
    const t = performance.now();
    await window.__ag.rebootEngine();
    await window.__ag.engine.ready();
    return performance.now() - t;
  });
  return out;
}

async function stageContext(env) {
  const { page } = env;
  await sleep(2000);
  return page.evaluate(async () => {
    const { projectContext } = await import('/src/app/ai/context/index.ts');
    const times = [];
    let text = '';
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      text = projectContext(window.__ag);
      times.push(performance.now() - t);
    }
    const sorted = [...times].sort((a, b) => a - b);
    return { contextFirstMs: times[0], contextBestMs: sorted[0], contextChars: text.length };
  });
}

async function stageRender(env) {
  const { page } = env;
  await sleep(2000);
  return page.evaluate(async () => {
    const s = window.__ag;
    const { renderOffline } = await import('/src/engine/render-offline.ts');
    const project = s.doc.getState().project;
    const t = performance.now();
    const r = await renderOffline(project, {
      plugins: s.plugins,
      sampleCache: s.sampleCache,
      view: { mode: 'song', patternId: null, loop: null },
      bars: 16,
      tail: 0,
      sampleRate: 48000,
    });
    const ms = performance.now() - t;
    const seconds = r.buffer.duration;
    const bytes = new Uint8Array(r.buffer.getChannelData(0).buffer.slice(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
    return { renderMs: ms, renderSeconds: seconds, renderTimesRealtime: seconds / (ms / 1000), renderHash: hash };
  });
}

const STAGES = { load: stageLoad, save: stageSave, memory: stageMemory, idle: stageIdle, engine: stageEngine, context: stageContext, render: stageRender };

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const results = {};
try {
  for (const name of ONLY) {
    const stage = STAGES[name];
    if (!stage) continue;
    const runs = [];
    for (let i = 0; i < REPS; i++) {
      const env = await openPage(browser);
      try {
        runs.push(await stage(env));
      } catch (e) {
        runs.push({ error: String(e).split('\n')[0].slice(0, 200) });
      }
      if (env.errors.length) console.log(`  (page errors in ${name}: ${env.errors.slice(0, 2).join(' | ')})`);
      await env.ctx.close();
    }
    const keys = [...new Set(runs.flatMap((r) => Object.keys(r)))];
    const row = {};
    for (const k of keys) {
      const values = runs.map((r) => r[k]);
      row[k] = typeof values.find((v) => v !== undefined) === 'string' ? values[0] : median(values);
    }
    results[name] = row;
    console.log(`## ${name}`);
    for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(26)} ${typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : v}`);
  }
} finally {
  await browser.close();
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, reps: REPS, fixture: FIXTURE, results }, null, 2));
