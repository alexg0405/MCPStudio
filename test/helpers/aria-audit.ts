/**
 * Accessibility checks for a piece of the running page, written for the browser tests (`a11y-audit.test.ts`).
 * There is no dependency on an ARIA checker: this is a compact table of the roles AGstudio may use, what each one
 * needs, and a few functions that read the DOM and return plain sentences about what is wrong.
 *
 * Every function returns a list of problems (empty is good), each starting with a short description of the element.
 */

/** Interactive elements a person can point at or tab to. */
export const INTERACTIVE_SELECTOR =
  'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="spinbutton"], [role="option"], [role="combobox"], [role="treeitem"], [role="gridcell"], [role="textbox"], [tabindex]:not([tabindex="-1"])';

// ── the role table ─────────────────────────────────────────────────────────────────────────────────

/** Attributes any role may carry. */
const GLOBAL_ATTRS = new Set([
  'aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-description', 'aria-details',
  'aria-disabled', 'aria-errormessage', 'aria-flowto', 'aria-hidden', 'aria-invalid', 'aria-keyshortcuts', 'aria-label',
  'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant', 'aria-roledescription',
]);

/** Everything named `aria-*` the checker knows: an unknown one is a typo. */
const KNOWN_ATTRS = new Set([
  ...GLOBAL_ATTRS, 'aria-activedescendant', 'aria-autocomplete', 'aria-checked', 'aria-colcount', 'aria-colindex',
  'aria-colspan', 'aria-expanded', 'aria-haspopup', 'aria-level', 'aria-modal', 'aria-multiline', 'aria-multiselectable',
  'aria-orientation', 'aria-placeholder', 'aria-posinset', 'aria-pressed', 'aria-readonly', 'aria-required',
  'aria-rowcount', 'aria-rowindex', 'aria-rowspan', 'aria-selected', 'aria-setsize', 'aria-sort', 'aria-valuemax',
  'aria-valuemin', 'aria-valuenow', 'aria-valuetext',
]);

interface RoleRule {
  /** Attributes beyond the global ones that this role supports. */
  attrs?: string[];
  /** Attributes that must be present (a slider without a value). */
  required?: string[];
  /** The element must sit inside one of these roles. */
  parents?: string[];
  /** A non-empty element of this role must contain at least one of these roles. */
  owns?: string[];
  /** The role must have an accessible name. */
  named?: boolean;
}

const VALUE = ['aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext', 'aria-orientation'];
const MENU_ITEM = ['aria-posinset', 'aria-setsize', 'aria-expanded', 'aria-haspopup'];
const MENU_CONTEXT = ['menu', 'menubar', 'group'];
const GRID_ITEM = ['aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan', 'aria-readonly', 'aria-required', 'aria-selected'];

/** The roles AGstudio uses or may reasonably use. A role not in this table is reported as invalid. */
export const ROLES: Record<string, RoleRule> = {
  alert: {},
  alertdialog: { attrs: ['aria-modal'], named: true },
  application: { named: true },
  article: { attrs: ['aria-posinset', 'aria-setsize'] },
  banner: {},
  button: { attrs: ['aria-expanded', 'aria-pressed', 'aria-haspopup'], named: true },
  cell: { attrs: GRID_ITEM, parents: ['row'] },
  checkbox: { attrs: ['aria-checked', 'aria-readonly', 'aria-required'], required: ['aria-checked'], named: true },
  columnheader: { attrs: [...GRID_ITEM, 'aria-sort', 'aria-expanded'], parents: ['row'], named: true },
  combobox: {
    attrs: ['aria-activedescendant', 'aria-autocomplete', 'aria-expanded', 'aria-haspopup', 'aria-readonly', 'aria-required'],
    required: ['aria-expanded'],
    named: true,
  },
  complementary: {},
  contentinfo: {},
  definition: {},
  dialog: { attrs: ['aria-modal'], named: true },
  directory: {},
  document: {},
  feed: {},
  figure: {},
  form: {},
  grid: {
    attrs: ['aria-activedescendant', 'aria-colcount', 'aria-multiselectable', 'aria-readonly', 'aria-rowcount', 'aria-expanded'],
    owns: ['row', 'rowgroup'],
    named: true,
  },
  gridcell: { attrs: [...GRID_ITEM, 'aria-expanded'], parents: ['row'] },
  group: { attrs: ['aria-activedescendant', 'aria-expanded'] },
  heading: { attrs: ['aria-level'] },
  img: { named: true },
  link: { attrs: ['aria-expanded'], named: true },
  list: { owns: ['listitem'] },
  listbox: {
    attrs: ['aria-activedescendant', 'aria-expanded', 'aria-multiselectable', 'aria-readonly', 'aria-required', 'aria-orientation'],
    owns: ['option', 'group'],
    named: true,
  },
  listitem: { attrs: ['aria-level', 'aria-posinset', 'aria-setsize'], parents: ['list', 'group'] },
  log: {},
  main: {},
  marquee: {},
  math: {},
  menu: { attrs: ['aria-activedescendant', 'aria-orientation'], owns: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group'], named: true },
  menubar: { attrs: ['aria-activedescendant', 'aria-orientation'], owns: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group'], named: true },
  menuitem: { attrs: MENU_ITEM, parents: MENU_CONTEXT, named: true },
  menuitemcheckbox: { attrs: [...MENU_ITEM, 'aria-checked'], required: ['aria-checked'], parents: MENU_CONTEXT, named: true },
  menuitemradio: { attrs: [...MENU_ITEM, 'aria-checked'], required: ['aria-checked'], parents: MENU_CONTEXT, named: true },
  meter: { attrs: VALUE, required: ['aria-valuenow'], named: true },
  navigation: {},
  none: {},
  note: {},
  option: { attrs: ['aria-checked', 'aria-posinset', 'aria-selected', 'aria-setsize'], parents: ['listbox', 'group'], named: true },
  presentation: {},
  progressbar: { attrs: VALUE, named: true },
  radio: { attrs: ['aria-checked', 'aria-posinset', 'aria-setsize'], required: ['aria-checked'], named: true },
  radiogroup: { attrs: ['aria-readonly', 'aria-required'], named: true },
  region: { named: true },
  row: { attrs: ['aria-colindex', 'aria-expanded', 'aria-level', 'aria-posinset', 'aria-rowindex', 'aria-selected', 'aria-setsize'], parents: ['grid', 'table', 'treegrid', 'rowgroup'] },
  rowgroup: {},
  rowheader: { attrs: [...GRID_ITEM, 'aria-sort', 'aria-expanded'], parents: ['row'], named: true },
  scrollbar: { attrs: VALUE, required: ['aria-controls', 'aria-valuenow'], named: false },
  search: {},
  searchbox: { attrs: ['aria-activedescendant', 'aria-autocomplete', 'aria-multiline', 'aria-placeholder', 'aria-readonly', 'aria-required'], named: true },
  separator: { attrs: VALUE },
  slider: { attrs: [...VALUE, 'aria-readonly'], required: ['aria-valuenow'], named: true },
  spinbutton: { attrs: [...VALUE, 'aria-readonly', 'aria-required'], required: ['aria-valuenow'], named: true },
  status: {},
  switch: { attrs: ['aria-checked', 'aria-readonly'], required: ['aria-checked'], named: true },
  tab: { attrs: ['aria-selected', 'aria-expanded', 'aria-posinset', 'aria-setsize'], parents: ['tablist'], named: true },
  table: { attrs: ['aria-colcount', 'aria-rowcount'], named: true },
  tablist: { attrs: ['aria-activedescendant', 'aria-multiselectable', 'aria-orientation', 'aria-level'], owns: ['tab'], named: true },
  tabpanel: { named: true },
  term: {},
  textbox: { attrs: ['aria-activedescendant', 'aria-autocomplete', 'aria-multiline', 'aria-placeholder', 'aria-readonly', 'aria-required'], named: true },
  timer: {},
  toolbar: { attrs: ['aria-orientation'], named: true },
  tooltip: {},
  tree: { attrs: ['aria-activedescendant', 'aria-multiselectable', 'aria-orientation', 'aria-required'], owns: ['treeitem', 'group'], named: true },
  treegrid: { attrs: ['aria-activedescendant', 'aria-colcount', 'aria-multiselectable', 'aria-readonly', 'aria-required', 'aria-rowcount'], owns: ['row', 'rowgroup'], named: true },
  treeitem: { attrs: ['aria-checked', 'aria-expanded', 'aria-haspopup', 'aria-level', 'aria-posinset', 'aria-selected', 'aria-setsize'], parents: ['tree', 'group'], named: true },
};

/** Values an enumerated attribute may take. */
const ENUMS: Record<string, readonly string[]> = {
  'aria-pressed': ['true', 'false', 'mixed'],
  'aria-checked': ['true', 'false', 'mixed'],
  'aria-expanded': ['true', 'false'],
  'aria-selected': ['true', 'false'],
  'aria-hidden': ['true', 'false'],
  'aria-disabled': ['true', 'false'],
  'aria-modal': ['true', 'false'],
  'aria-haspopup': ['true', 'false', 'menu', 'listbox', 'tree', 'grid', 'dialog'],
  'aria-orientation': ['horizontal', 'vertical', 'undefined'],
  'aria-live': ['off', 'polite', 'assertive'],
  'aria-current': ['true', 'false', 'page', 'step', 'location', 'date', 'time'],
  'aria-invalid': ['true', 'false', 'grammar', 'spelling'],
  'aria-autocomplete': ['none', 'inline', 'list', 'both'],
  'aria-readonly': ['true', 'false'],
  'aria-required': ['true', 'false'],
  'aria-multiselectable': ['true', 'false'],
  'aria-sort': ['none', 'ascending', 'descending', 'other'],
};

/** Attributes whose value is a number. */
const NUMERIC = ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-level', 'aria-posinset', 'aria-setsize'];

/** Attributes whose value lists element ids. */
const ID_LISTS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-flowto', 'aria-details', 'aria-activedescendant'];

/** The role a native element has when it carries no `role` attribute (only the ones the checks care about). */
export function implicitRole(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listitem';
  if (tag === 'img') return 'img';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  return null;
}

// ── reading the page ───────────────────────────────────────────────────────────────────────────────

/** True when the element takes up room on screen and is not `visibility:hidden`. */
export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/** True when the element or an ancestor is hidden from assistive technology. */
export function isAriaHidden(el: Element): boolean {
  return !!el.closest('[aria-hidden="true"], [inert]');
}

/** The role in force for an element: the first valid token of `role`, else the native one. */
export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  return explicit || implicitRole(el);
}

/** What a screen reader would call the element (aria-labelledby, aria-label, native label, text, title). */
export function nameOf(el: Element): string {
  const input = el as HTMLInputElement;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  if (input.labels?.length) {
    const text = [...input.labels].map((l) => l.textContent ?? '').join(' ').trim();
    if (text) return text;
  }
  const own = (el.textContent ?? '').trim();
  const role = roleOf(el);
  // Fields and sliders take their name from labels, never from the text they contain.
  const nameFromContent = !['slider', 'spinbutton', 'textbox', 'combobox', 'listbox', 'searchbox', 'meter', 'progressbar', 'group', 'toolbar', 'menu', 'menubar', 'dialog', 'alertdialog', 'tablist', 'grid', 'tree'].includes(role ?? '');
  if (own && nameFromContent) return own;
  const alt = el instanceof HTMLImageElement ? el.alt : '';
  return (alt || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
}

/** A short description for a problem report: tag, role, first class and name. */
export function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.split(' ')[0] : '';
  const name = nameOf(el).replace(/\s+/g, ' ').slice(0, 28);
  return `${tag}${role ? `[role=${role}]` : ''}${cls ? `.${cls}` : ''}${name ? ` "${name}"` : ''}`;
}

/** The interactive elements inside `root` that a person could use right now. */
export function interactiveIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].filter(
    (el) => isVisible(el) && !isAriaHidden(el) && !(el instanceof HTMLInputElement && el.type === 'file'),
  );
}

// ── the checks ─────────────────────────────────────────────────────────────────────────────────────

/** Interactive elements and named roles without an accessible name. */
export function nameProblems(root: Element): string[] {
  const problems: string[] = [];
  const checked = new Set<Element>();
  const needsName = (el: Element) => {
    if (checked.has(el)) return;
    checked.add(el);
    if (!nameOf(el)) problems.push(`no accessible name: ${describe(el)}`);
  };
  for (const el of interactiveIn(root)) needsName(el);
  for (const el of root.querySelectorAll('[role]')) {
    if (!isVisible(el) || isAriaHidden(el)) continue;
    if (ROLES[roleOf(el) ?? '']?.named) needsName(el);
  }
  return problems;
}

/** Roles that are not real, attributes a role does not support, wrong values, missing required attributes. */
export function ariaProblems(root: Element): string[] {
  const problems: string[] = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (isAriaHidden(el) && !el.hasAttribute('role')) continue;
    const explicit = el.getAttribute('role');
    if (explicit !== null) {
      for (const token of explicit.trim().split(/\s+/)) {
        if (!ROLES[token]) problems.push(`invalid role "${token}": ${describe(el)}`);
      }
    }
    const role = roleOf(el);
    const rule = role ? ROLES[role] : undefined;
    for (const attr of el.getAttributeNames()) {
      if (!attr.startsWith('aria-')) continue;
      if (!KNOWN_ATTRS.has(attr)) {
        problems.push(`unknown ${attr}: ${describe(el)}`);
        continue;
      }
      if (!GLOBAL_ATTRS.has(attr) && role && rule && !(rule.attrs ?? []).includes(attr)) {
        problems.push(`${attr} is not allowed on role ${role}: ${describe(el)}`);
      }
      if (!GLOBAL_ATTRS.has(attr) && !role) problems.push(`${attr} needs a role: ${describe(el)}`);
      problems.push(...valueProblems(el, attr));
    }
    // Native controls (a checkbox input, a range) bring their own state; only an explicit role needs the attributes.
    if (rule?.required && explicit !== null) {
      for (const attr of rule.required) {
        if (!el.hasAttribute(attr)) problems.push(`role ${role} needs ${attr}: ${describe(el)}`);
      }
    }
  }
  return problems;
}

function valueProblems(el: Element, attr: string): string[] {
  const value = el.getAttribute(attr) ?? '';
  const allowed = ENUMS[attr];
  if (allowed && !allowed.includes(value)) return [`${attr}="${value}" is not one of ${allowed.join('|')}: ${describe(el)}`];
  if (NUMERIC.includes(attr) && (value === '' || Number.isNaN(Number(value)))) return [`${attr}="${value}" is not a number: ${describe(el)}`];
  if (attr === 'aria-valuetext' && value.trim() === '') return [`empty aria-valuetext: ${describe(el)}`];
  if (attr === 'aria-valuenow') {
    const min = el.getAttribute('aria-valuemin');
    const max = el.getAttribute('aria-valuemax');
    const now = Number(value);
    if (min !== null && now < Number(min) - 1e-9) return [`aria-valuenow ${value} is below aria-valuemin ${min}: ${describe(el)}`];
    if (max !== null && now > Number(max) + 1e-9) return [`aria-valuenow ${value} is above aria-valuemax ${max}: ${describe(el)}`];
  }
  return [];
}

/** Required parents and required owned roles, and ids that point at nothing or are used twice. */
export function structureProblems(root: Element): string[] {
  const problems: string[] = [];
  for (const el of root.querySelectorAll('[role]')) {
    if (isAriaHidden(el)) continue;
    const role = roleOf(el);
    const rule = role ? ROLES[role] : undefined;
    if (!rule) continue;
    if (rule.parents && !hasParentRole(el, rule.parents)) {
      problems.push(`role ${role} must be inside ${rule.parents.join(' or ')}: ${describe(el)}`);
    }
    if (rule.owns && !el.hasAttribute('aria-busy') && !ownsRole(el, rule.owns)) {
      problems.push(`role ${role} must contain ${rule.owns.join(' or ')}: ${describe(el)}`);
    }
  }
  problems.push(...idProblems(root));
  return problems;
}

/** True when an ancestor (or the element that `aria-owns` it) has one of the roles. */
function hasParentRole(el: Element, roles: string[]): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const role = roleOf(p);
    if (role && roles.includes(role)) return true;
  }
  const owner = el.id ? document.querySelector(`[aria-owns~="${CSS.escape(el.id)}"]`) : null;
  return !!owner && roles.includes(roleOf(owner) ?? '');
}

/** True when a descendant has one of the roles (or an `aria-owns` target does). */
function ownsRole(el: Element, roles: string[]): boolean {
  const selector = roles.map((r) => `[role~="${r}"]`).join(',');
  if (el.querySelector(selector)) return true;
  const owned = (el.getAttribute('aria-owns') ?? '').split(/\s+/).filter(Boolean);
  return owned.some((id) => {
    const target = document.getElementById(id);
    return !!target && (roles.includes(roleOf(target) ?? '') || !!target.querySelector(selector));
  });
}

/** `aria-labelledby` and friends must name existing ids; no id may appear twice on the page. */
function idProblems(root: Element): string[] {
  const problems: string[] = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of ID_LISTS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      for (const id of value.split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) problems.push(`${attr} points at missing id "${id}": ${describe(el)}`);
      }
    }
  }
  const seen = new Map<string, number>();
  for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (count > 1 && root.querySelector(`[id="${CSS.escape(id)}"]`)) problems.push(`id "${id}" is used ${count} times`);
  }
  return problems;
}

/** Attributes that tell a screen reader a button is on, selected or open. */
const STATE_ATTRS = ['aria-pressed', 'aria-checked', 'aria-selected', 'aria-expanded', 'aria-current'];

/** True when a CSS-module class name says "on" (`_toolOn_15pzx_20`, `_active_1a2b3_4`): the look of a lit toggle. */
function lookslit(className: string): boolean {
  return className.split(/\s+/).some((token) => /^_?(\w*On|active|selected|checked|armed)_[a-z0-9]{5,6}_\d+$/.test(token));
}

/**
 * Buttons that light up when on but tell a screen reader nothing about it (no aria-pressed, aria-checked, aria-selected,
 * aria-expanded or aria-current). Judged by the CSS class that gives the lit look, so it is a hint to look, not a proof:
 * a button whose lit look only means "hovered" can be excused by giving it `aria-pressed`, which is also right.
 */
export function toggleStateProblems(root: Element): string[] {
  const problems: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('button, [role="button"], [role="switch"], [role="radio"], [role="tab"]')) {
    if (!isVisible(el) || isAriaHidden(el)) continue;
    if (typeof el.className !== 'string' || !lookslit(el.className)) continue;
    if (STATE_ATTRS.some((attr) => el.hasAttribute(attr))) continue;
    problems.push(`looks lit but exposes no state: ${describe(el)}`);
  }
  return problems;
}

// ── tab stops and roving groups ────────────────────────────────────────────────────────────────────

/** True when Tab can land on the element: natively focusable, or `tabindex >= 0`, and not disabled. */
export function isTabStop(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.closest('[inert]')) return false;
  const index = el.getAttribute('tabindex');
  if (index !== null) return Number(index) >= 0;
  if (el instanceof HTMLAnchorElement) return el.hasAttribute('href');
  if (el instanceof HTMLInputElement) return el.type !== 'hidden';
  return el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLElement && el.tagName === 'SUMMARY';
}

/** What makes a roving group (see `GROUP_SELECTOR` in `src/ui/a11y/roving.ts`). */
const ROVING_GROUPS = '[data-roving], [role="toolbar"], [role="tablist"], [role="radiogroup"]';

/** The roving groups inside `root` and what is wrong with each one's tab stops. */
export function rovingProblems(root: Element): { groups: number; problems: string[] } {
  const problems: string[] = [];
  const groups = [...root.querySelectorAll<HTMLElement>(ROVING_GROUPS)].filter((g) => isVisible(g));
  for (const group of groups) {
    const members = [...group.querySelectorAll<HTMLElement>('button, [role], a[href], input, [data-roving-item]')].filter(
      (el) => el.closest(ROVING_GROUPS) === group && isVisible(el) && !el.hasAttribute('disabled') && isRovingMember(el),
    );
    if (members.length === 0) continue;
    const stops = members.filter((el) => el.getAttribute('tabindex') === '0');
    if (stops.length !== 1) problems.push(`roving group ${describe(group)} has ${stops.length} tab stops (needs exactly 1)`);
  }
  return { groups: groups.length, problems };
}

/** The roving module's own notion of a member: a pressable control (see `ITEM_SELECTOR` in `a11y/roving.ts`). */
function isRovingMember(el: HTMLElement): boolean {
  if (el.matches('button, a[href], [data-roving-item], input[type="checkbox"], input[type="radio"]')) return true;
  const role = el.getAttribute('role');
  return ['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'radio', 'switch', 'checkbox'].includes(role ?? '');
}

/** Elements on screen a person can use that Tab (or a roving group's arrows) can never reach. */
export function unreachableProblems(root: Element): string[] {
  const problems: string[] = [];
  for (const el of interactiveIn(root)) {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    if (isTabStop(el)) continue;
    const group = el.closest(ROVING_GROUPS);
    if (group && isRovingMember(el)) continue;
    // The entries of an open menu are reached with its arrow keys (the menu tests check that).
    if (el.closest('[role="menu"]')) continue;
    // An option of a list that a combobox drives with aria-activedescendant (the action search).
    const list = el.closest('[role="listbox"]');
    if (list?.id && document.querySelector(`[aria-controls~="${CSS.escape(list.id)}"][aria-activedescendant]`)) continue;
    // A composite whose own container is the Tab stop and moves the selection with its keys (a list box, a tree, a grid).
    const composite = el.closest('[role="listbox"], [role="tree"], [role="grid"], [aria-activedescendant]');
    if (composite && isTabStop(composite as HTMLElement)) continue;
    problems.push(`not reachable by keyboard: ${describe(el)}`);
  }
  for (const el of root.querySelectorAll('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) problems.push(`positive tabindex: ${describe(el)}`);
  }
  return problems;
}

/** True when the focused element shows a focus ring itself: a 2px outline or a box-shadow. */
function hasOwnFocusRing(el: Element): boolean {
  const cs = getComputedStyle(el);
  const outlined = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && cs.outlineColor !== 'rgba(0, 0, 0, 0)';
  return outlined || (cs.boxShadow !== 'none' && cs.boxShadow !== '');
}

/** What one of the element's ancestors looks like, as a string that changes when its focus styling does. */
function lookOf(el: Element): string {
  const cs = getComputedStyle(el);
  return [cs.boxShadow, cs.borderTopColor, cs.outlineStyle, cs.backgroundColor].join('|');
}

/**
 * True when focusing the element changes how one of its two nearest ancestors looks (a text box whose frame lights up
 * with `:focus-within`). Transitions are switched off while measuring, or the "after" would still show the "before".
 */
function parentShowsFocus(el: HTMLElement): boolean {
  const chain = [el.parentElement, el.parentElement?.parentElement].filter((x): x is HTMLElement => !!x);
  for (const a of chain) a.style.transition = 'none';
  const focusedLooks = chain.map(lookOf);
  el.blur();
  const plainLooks = chain.map(lookOf);
  el.focus();
  for (const a of chain) a.style.removeProperty('transition');
  return focusedLooks.some((look, i) => look !== plainLooks[i]);
}

/** True when the focused element shows a focus ring: on itself (a 2px outline or a box-shadow) or on the frame around it. */
export function hasFocusRing(el: Element): boolean {
  return hasOwnFocusRing(el) || (el instanceof HTMLElement && parentShowsFocus(el));
}
