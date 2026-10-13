/**
 * The browser's DynamicsCompressorNode multiplies its output by an automatic makeup gain derived
 * from threshold, knee and ratio (Web Audio spec, "makeup gain": (1 / curve(1.0)) ^ 0.6). This is
 * the same computation (Chromium's DynamicsCompressorKernel), so the Compressor can divide it out
 * and make its own `makeup` knob the only gain applied after compression.
 * test/browser/mixer.test.ts checks it against the real node.
 */

const dbToLinear = (db: number) => Math.pow(10, 0.05 * db);
const linearToDb = (lin: number) => 20 * Math.log10(lin);

export function nativeMakeupGain(thresholdDb: number, kneeDb: number, ratio: number): number {
  const linearThreshold = dbToLinear(thresholdDb);
  // Exponential knee, first-derivative matched at the threshold.
  const knee = (x: number, k: number) =>
    x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k;
  const slopeAt = (x: number, k: number) => {
    if (x < linearThreshold) return 1;
    const x2 = x * 1.001;
    return (linearToDb(knee(x2, k)) - linearToDb(knee(x, k))) / (linearToDb(x2) - linearToDb(x));
  };
  // k such that the knee's slope at its end equals 1/ratio (geometric bisection, as the browser does).
  const kneeEnd = dbToLinear(thresholdDb + kneeDb);
  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeEnd, k) < 1 / ratio) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const kneeEndDb = thresholdDb + kneeDb;
  const kneeEndOutDb = linearToDb(knee(kneeEnd, k));
  const curve = (x: number) =>
    x < kneeEnd ? knee(x, k) : dbToLinear(kneeEndOutDb + (linearToDb(x) - kneeEndDb) / ratio);
  const fullRange = curve(1);
  return fullRange > 0 ? Math.pow(1 / fullRange, 0.6) : 1;
}

/** Frames the browser's compressor delays its output by (a fixed 6 ms look-ahead, truncated). */
export function nativeLatencyFrames(sampleRate: number): number {
  return Math.floor(0.006 * sampleRate);
}
