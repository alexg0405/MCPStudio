/**
 * Generates the marble textures of the themes (--ag-marble in src/ui/theme/tokens.css and themes.css):
 * thin lines warped by noise (veins), a second finer set, soft clouds and a few gold veins, as an SVG
 * data URI. Deterministic (seeded). Usage: node scripts/marble.mjs [dark|light]
 */
function rnd(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function marble(o) {
  const r = rnd(o.seed);
  const line = (x, dx, w, op) =>
    `<line x1='${x.toFixed(0)}' y1='-300' x2='${(x - dx).toFixed(0)}' y2='1300' stroke-width='${w.toFixed(2)}'${op === undefined ? '' : ` stroke-opacity='${op.toFixed(2)}'`}/>`;
  let veins = '';
  for (let i = 0; i < o.n; i++) veins += line(-400 + r() * 2400, 900 + r() * 500, 0.5 + r() * r() * o.maxW, 0.25 + r() * 0.75);
  let fine = '';
  for (let i = 0; i < o.nf; i++) fine += line(-400 + r() * 2400, 1100 + r() * 700, 0.35 + r() * 0.5, 0.2 + r() * 0.5);
  const g = rnd(o.seed * 7);
  let gold = '';
  for (let i = 0; i < o.ng; i++) gold += line(200 + g() * 1600, 1000 + g() * 400, 0.6 + g() * 1.2);
  const tint = o.ink === '#fff' ? '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1' : '0 0 0 0 0.22 0 0 0 0 0.21 0 0 0 0 0.19';
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='1000' viewBox='0 0 1600 1000'>` +
    `<filter id='c' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.0014 0.0022' numOctaves='4' seed='${o.seed + 1}'/><feColorMatrix values='${tint} 0 0 0 1.3 -0.5'/></filter>` +
    `<filter id='w' x='-20%' y='-20%' width='140%' height='140%'><feTurbulence type='fractalNoise' baseFrequency='${o.f} ${(o.f * 1.6).toFixed(5)}' numOctaves='5' seed='${o.seed + 2}' result='n'/><feDisplacementMap in='SourceGraphic' in2='n' scale='${o.disp}' xChannelSelector='R' yChannelSelector='G'/><feGaussianBlur stdDeviation='0.5'/></filter>` +
    `<filter id='w2' x='-20%' y='-20%' width='140%' height='140%'><feTurbulence type='fractalNoise' baseFrequency='${(o.f * 2.2).toFixed(5)} ${(o.f * 3).toFixed(5)}' numOctaves='5' seed='${o.seed + 3}' result='n'/><feDisplacementMap in='SourceGraphic' in2='n' scale='${(o.disp * 0.7).toFixed(0)}' xChannelSelector='R' yChannelSelector='G'/></filter>` +
    `<rect width='1600' height='1000' filter='url(#c)' opacity='${o.cloud}'/>` +
    `<g filter='url(#w)' stroke='${o.ink}' fill='none' opacity='${o.vein}'>${veins}</g>` +
    `<g filter='url(#w2)' stroke='${o.ink}' fill='none' opacity='${(o.vein * 0.8).toFixed(3)}'>${fine}</g>` +
    `<g filter='url(#w)' stroke='${o.gold}' fill='none' opacity='${o.goldOp}'>${gold}</g></svg>`
  );
}

const THEMES = {
  dark: { seed: 9, n: 8, nf: 12, maxW: 3.2, f: 0.0021, disp: 230, cloud: 0.07, vein: 0.2, ng: 2, ink: '#fff', gold: '#c9a45c', goldOp: 0.4 },
  light: { seed: 5, n: 9, nf: 14, maxW: 3.6, f: 0.0019, disp: 260, cloud: 0.09, vein: 0.19, ng: 1, ink: '#3a3833', gold: '#a8823c', goldOp: 0.3 },
};

const which = process.argv[2] ?? 'dark';
const svg = marble(THEMES[which]);
process.stdout.write(`url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`);
