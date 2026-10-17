#!/usr/bin/env node
/**
 * Per-frame cost while a song plays with smooth follow (the view scrolls a little every frame), dev server:
 *
 *   node scripts/perf-follow.mjs [--url http://localhost:5422] [--seconds 12] [--fixture stacked-song|notes10k|mix30]
 *                                [--json out.json] [--label before]
 *
 * Playlist and piano roll are both open side by side. Reports, over the measurement window:
 *  - JS time per animation frame in the app's frame loop (frameStats): median, p95, max;
 *  - allocation rate from the sampling heap profiler, garbage included (KB/s);
 *  - main-thread script time (CDP Performance ScriptDuration + TaskDuration) per second;
 *  - the piano roll's draw count, long animation frames, and React commits (must stay 0 while idle-playing).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const BASE = arg('url', 'http://localhost:5422');
const SECONDS = Number(arg('seconds', '12'));
const ONLY = arg('fixture', '');
const LABEL = arg('label', '');
const JSON_OUT = arg('json', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const results = [];
try {
  for (const fixture of ['stacked-song', 'notes10k', 'mix30']) {
    if (ONLY && ONLY !== fixture) continue;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript((f) => (window.__fx = f), fixture);
    await page.addInitScript(() => localStorage.setItem('agstudio:prefs:v1', JSON.stringify({ welcomeSeen: true })));
    await page.addInitScript(() => {
      window.__loaf = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__loaf.push(e.blockingDuration);
        }).observe({ type: 'long-animation-frame' });
      } catch {
        /* not supported in this browser */
      }
    });
    await page.goto(`${BASE}/?perf=${fixture}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__ag && document.querySelector('[data-window-type]'), null, { timeout: 90000 });
    await sleep(2500);
    // Playlist and piano roll side by side (the channel rack hidden), song mode, smooth follow.
    await page.evaluate(() => {
      const s = window.__ag;
      const v = s.view.getState();
      for (const w of Object.values(v.windows)) if (w.visible) v.hideWindow(w.id);
      v.showWindow('playlist', 'playlist');
      v.showWindow('piano-roll', 'piano-roll');
      const a = window.innerWidth;
      v.setMaximized('playlist', false);
      v.setMaximized('piano-roll', false);
      v.setRect('playlist', { x: 4, y: 4, w: 700, h: 640 });
      v.setRect('piano-roll', { x: 712, y: 4, w: 460, h: 640 });
      void a;
      v.setMode(window.__fx === 'notes10k' ? 'pattern' : 'song');
      // The piano roll shows a channel that has notes in the current pattern.
      const pid = v.currentPatternId;
      const pat = s.doc.getState().project.patterns[pid];
      const cid = Object.keys(pat?.notes ?? {}).find((k) => Object.keys(pat.notes[k]).length > 0);
      if (cid) s.session.getState().selectChannel(cid);
      s.prefs.getState().set({ followPlayhead: true, followStyle: 'smooth' });
      // Zoom in so the song really scrolls.
      s.editor.getState().setPlaylist({ pxPerTick: 0.04, scrollTick: 0 });
      s.editor.getState().setPianoRoll({ scrollTick: 0 });
    });
    await sleep(800);
    const client = await ctx.newCDPSession(page);
    await client.send('Performance.enable');
    await client.send('HeapProfiler.enable');
    await page.evaluate(() => window.__ag.commands.run('transport.playPause'));
    await sleep(3500); // let the follow engage and the first redraws settle
    const m0 = await client.send('Performance.getMetrics');
    const get = (m, n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
    await page.evaluate(() => {
      const s = window.__ag;
      s.perf.frames.samples.length = 0;
      s.perf.frames.recording = true;
      s.perf.react0 = s.perf.react.commits;
      s.perf.draws0 = s.perf.pianoRoll.draws;
      window.__loaf.length = 0;
      window.__scroll0 = Number(document.querySelector('[data-window-type="playlist"] canvas[data-snap-px]')?.dataset.snapPx ?? 0);
    });
    await client.send('HeapProfiler.startSampling', { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const t0 = Date.now();
    await sleep(SECONDS * 1000);
    const dt = (Date.now() - t0) / 1000;
    const { profile } = await client.send('HeapProfiler.stopSampling');
    const m1 = await client.send('Performance.getMetrics');
    const r = await page.evaluate(() => {
      const s = window.__ag;
      s.perf.frames.recording = false;
      return {
        frames: [...s.perf.frames.samples],
        commits: s.perf.react.commits - s.perf.react0,
        draws: s.perf.pianoRoll.draws - s.perf.draws0,
        loaf: [...window.__loaf],
        playing: s.engine.playing,
        plScroll: Number(document.querySelector('[data-window-type="playlist"] canvas[data-snap-px]')?.dataset.snapPx ?? 0),
        prScroll: s.editor.getState().pianoRoll.scrollTick,
        plScroll0: window.__scroll0,
      };
    });
    // Sum of sampled bytes (self sizes of every node): the sampler scales to the estimated total.
    let bytes = 0;
    const walk = (n) => {
      bytes += n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    // Where it is allocated (top self sizes by function).
    const byFn = new Map();
    const walk2 = (n) => {
      const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`;
      byFn.set(k, (byFn.get(k) ?? 0) + n.selfSize);
      for (const c of n.children) walk2(c);
    };
    walk2(profile.head);
    const top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${(v / dt / 1024).toFixed(1)} KB/s ${k}`);
    const row = {
      fixture,
      label: LABEL,
      seconds: dt,
      playing: r.playing,
      frames: r.frames.length,
      frameMedian: pct(r.frames, 50),
      frameP95: pct(r.frames, 95),
      frameMax: Math.max(...r.frames, 0),
      frameMean: r.frames.reduce((a, b) => a + b, 0) / Math.max(1, r.frames.length),
      allocKBs: bytes / dt / 1024,
      scriptMsPerSec: ((get(m1, 'ScriptDuration') - get(m0, 'ScriptDuration')) * 1000) / dt,
      taskMsPerSec: ((get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) * 1000) / dt,
      layoutMsPerSec: ((get(m1, 'LayoutDuration') - get(m0, 'LayoutDuration')) * 1000) / dt,
      reactCommits: r.commits,
      prDraws: r.draws,
      loafCount: r.loaf.length,
      loafMax: Math.max(0, ...r.loaf),
      scrolled: r.plScroll - r.plScroll0,
      top,
    };
    results.push(row);
    console.log(
      `${fixture.padEnd(13)} playing=${row.playing} playlist scrolled=${row.scrolled.toFixed(0)} device px | frame JS ms: median ${row.frameMedian.toFixed(2)} p95 ${row.frameP95.toFixed(2)} max ${row.frameMax.toFixed(1)} mean ${row.frameMean.toFixed(2)} | alloc ${row.allocKBs.toFixed(0)} KB/s | script ${row.scriptMsPerSec.toFixed(0)} ms/s task ${row.taskMsPerSec.toFixed(0)} ms/s layout ${row.layoutMsPerSec.toFixed(1)} | react commits ${row.reactCommits} | LoAF ${row.loafCount} (max block ${row.loafMax.toFixed(0)}) | pianoRoll draws ${row.prDraws}`,
    );
    if (process.env.TOP) for (const t of top) console.log('    ' + t);
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
