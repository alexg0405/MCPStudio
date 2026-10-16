# AGstudio design: black marble

The look, and the rules every window, control and canvas follows. Colors, sizes and depths are tokens
(`src/ui/theme/tokens.css`; other themes in `themes.css`): never hard-code a color in a component or a canvas
renderer. A theme only changes token values, so a component that uses tokens is right in every theme (Black marble,
White marble, Classic, Midnight, Graphite, Light) and with every accent.

## The idea

Obsidian stone with faint veining; windows are polished slabs resting on it; floating things (menus, dialogs,
tooltips, cards) are smoked glass; edges are hairlines; what is active is brushed gold. Calm surfaces, so the music
(notes, clips, meters) is the brightest thing on screen. Sleek means few lines, generous but not loose spacing,
consistent radii, and depth from soft shadow rather than borders.

## Surfaces and depth

| Layer | Use | Tokens |
|---|---|---|
| Page / workspace | behind the windows, shows the marble | `--ag-backdrop`, `--ag-marble` |
| Window | a slab: the frame of every window | `--ag-surface-1`, radius `--ag-radius-lg`, `--ag-shadow`, 1px `--ag-border-soft` hairline |
| Panel | areas inside a window (toolbars, side lists, strips) | `--ag-surface-2`, no shadow, hairline separators `--ag-line-faint` |
| Raised control | buttons, knobs, steps | `--ag-surface-3` / `--ag-raised`, `--ag-elev-1` |
| Inset | inputs, displays, meters, grids | `--ag-surface-inset` / `--ag-well` / `--ag-lcd`, `--ag-inset` |
| Floating | menus, dialogs, tooltips, popovers, toasts, the palette, the Ask AI card | `--ag-glass` + `backdrop-filter: var(--ag-blur)`, `--ag-elev-2`, radius `--ag-radius-lg` |

- Marble only on big background surfaces: the workspace, the toolbar strip, window title bars (very faint), empty
  states. Never under notes, clips, text lists or controls.
- One hairline per edge at most; prefer a shadow or a change of surface over a border.
- Scrims behind dialogs: `--ag-scrim`.
- Write `-webkit-backdrop-filter` on the line BEFORE `backdrop-filter`. The build's CSS minifier drops the standard
  property when it comes first, and Chrome ignores the prefixed one (no blur, and submenus open in the wrong place).
  `test/unit/css-minify.test.ts` checks every stylesheet.

## Shape and spacing

- Radii: `--ag-radius-sm` (4px: steps, small chips, clips, notes), `--ag-radius` (6px: buttons, inputs, menus items),
  `--ag-radius-lg` (10px: windows, floating panels, cards), `--ag-radius-xl` (14px: big dialogs), pills
  `--ag-radius-pill` (chips, toggles, scope tags).
- Spacing steps: `--ag-space-1..4` (4, 8, 12, 16px). Control heights: 22px (dense: mixer, rack), 26px (default),
  32px (dialog buttons, the AI studio input).
- Hit targets stay at least 20px even when they look smaller.

## Type

- System font (SF Pro on a Mac): `--ag-font`; titles `--ag-font-display`; numbers `--ag-font-mono` or tabular
  figures (on by default in body).
- Sizes: 11px (`--ag-font-size-sm`, secondary), 12px (body), 13px (`--ag-font-size-lg`, inputs, chat), 15px
  (`--ag-font-size-title`, dialog titles).
- Weights: 400 body, 500 labels and buttons, 600 titles. No bold for emphasis in lists; use `--ag-text` vs
  `--ag-text-dim`.
- Section labels ("MIXER", "PLUGINS"): 10–11px, uppercase, `letter-spacing: var(--ag-label-tracking)`, weight 600,
  `--ag-text-faint`.

## Color

- Text: `--ag-text` (primary), `--ag-text-dim` (secondary), `--ag-text-faint` (hints, disabled).
- Accent (gold by default): active, selected, primary. As a fill: `--ag-metal` (brushed) with `--ag-on-accent`
  text; as a state: `--ag-accent-tint` / `--ag-accent-soft` backgrounds with `--ag-accent` text or a 1px
  `--ag-accent-dim` edge. Never a big flat block of saturated accent.
- `--ag-select` (soft steel blue): selection of clips, notes and rows (distinct from "active").
- Status: `--ag-led` (on / OK), `--ag-danger`, `--ag-warning`. Meters: `--ag-meter-lo/mid/hi`.
- Channel and pattern colors stay the musician's; draw them a little desaturated against stone
  (`color-mix(in srgb, <color> 80%, var(--ag-surface-1))`) with a lighter top edge.

## Controls

- **Button**: 26px, radius 6, `--ag-surface-3` with `--ag-elev-1`, label 500 weight. Hover: `--ag-hover`.
  Pressed: inset, 1px down. Primary: `--ag-metal`, `--ag-on-accent`. Danger: `--ag-danger-tint` with
  `--ag-danger-text`. Ghost (toolbar icons): transparent until hover.
- **Toggle / tool button on**: `--ag-active` background, `--ag-accent` icon/text, 1px `--ag-active-border`; off:
  ghost.
- **Input / select**: inset well (`--ag-surface-inset`, `--ag-inset`), radius 6, 13px text; focus: 1.5px gold ring
  (global `:focus-visible`).
- **Knob**: dark stone body with a soft top highlight, the value as a gold arc (`--ag-accent`) on a faint track, a
  thin pointer; centered knobs (pan) arc from the middle.
- **Slider / fader**: slim track (inset), a cap that looks machined (surface-3 with a highlight line), gold fill
  for value where it makes sense.
- **LED**: 6–8px dot, `--ag-led` with `--ag-led-glow` when on, `--ag-led-off` when off.
- **LCD / numbers** (tempo, position): `--ag-lcd` well, `--ag-lcd-text` ivory, mono, with a faint inner glow.
- **Chips** (suggestions, scopes): pill, `--ag-surface-2`, hairline; hover gold text.
- **Menus**: glass, 6px item radius inside 10px panel, 26px items, shortcuts right-aligned in `--ag-text-faint`,
  submenu chevrons, separators as `--ag-line-faint`.
- **Window title bar**: 28px, title 12px weight 600 `--ag-text-dim` (`--ag-text` when focused), small round window
  buttons (ghost icons, red-tinted close on hover). Focused window: slightly brighter hairline and title.
- **Scrollbars**: slim, no track (global in base.css).

## Canvases (playlist, piano roll, rack, mixer meters, automation, visualizer)

They read tokens through `src/ui/timeline/canvas.ts` (`themeColors`); add a token rather than a literal.
- Grids: hairlines (`--ag-grid-beat` / `--ag-grid-bar`), alternating bars barely different.
- Clips: radius 4, fill from the pattern color (as above), a thin lighter title strip, content drawn in a lighter
  tint; selected: `--ag-select` outline 1.5px.
- Notes: radius 3, `--ag-note` (gold) with a lighter top edge; selected `--ag-note-selected`; velocity as opacity.
- Playhead: 1px `--ag-playhead` with a soft glow and a small cap in the ruler.
- Ruler: on `--ag-surface-2`, numbers 10px `--ag-text-faint`, markers as small gold flags.

## Motion

- 140ms `--ag-ease` for hover, press and open (opacity + 4px translate for floating panels). No motion on
  anything that updates per frame. `prefers-reduced-motion` turns it off (base.css).
