/**
 * The plain-words list of what repair fixed. Many fixes of one kind become one line ("Removed 3 notes"),
 * so a badly damaged project gets a short report instead of hundreds of lines.
 */

/** A thing repair can fix, in singular and plural, for messages like "Fixed 2 channels". */
export type Noun = readonly [singular: string, plural: string];

/** A noun whose plural is the singular plus "s" unless given. */
export const noun = (singular: string, plural = `${singular}s`): Noun => [singular, plural];

/** "1 channel" or "3 channels". */
export const countOf = (n: number, [singular, plural]: Noun): string => `${n} ${n === 1 ? singular : plural}`;

/** The same noun with a word in front: "damaged channel". */
export const withPrefix = (prefix: string, [singular, plural]: Noun): Noun => [
  `${prefix} ${singular}`,
  `${prefix} ${plural}`,
];

/** How repair messages name a sample entry. */
export const SAMPLE = noun('sample entry', 'sample entries');
/** How repair messages name a mixer insert ("mixer track"). */
export const INSERT = noun('mixer track');
/** How repair messages name a channel. */
export const CHANNEL = noun('channel');
/** How repair messages name a pattern. */
export const PATTERN = noun('pattern');
/** How repair messages name a note. */
export const NOTE = noun('note');
/** How repair messages name a playlist track (lane). */
export const LANE = noun('playlist track');
/** How repair messages name a playlist clip. */
export const CLIP = noun('playlist clip');
/** How repair messages name an effect slot. */
export const SLOT = noun('effect slot');
/** How repair messages name a mixer route. */
export const ROUTE = noun('mixer route');
/** How repair messages name a controller link. */
export const LINK = noun('controller link');
/** How repair messages name a playlist marker. */
export const MARKER = noun('playlist marker');

/** Collects fixes; counted fixes become one message per kind (in first-seen order). */
export class RepairLog {
  readonly messages: string[] = [];
  private readonly counts = new Map<string, { n: number; format: (n: number) => string }>();

  /** Adds a one-off message (after the counted messages gathered so far, to keep a logical order). */
  add(message: string): void {
    this.flush();
    this.messages.push(message);
  }

  /** Counts one more fix of the kind `key`; `format` turns the final count into the message. */
  count(key: string, format: (n: number) => string): void {
    const entry = this.counts.get(key);
    if (entry) entry.n++;
    else this.counts.set(key, { n: 1, format });
  }

  /** Emits the counted messages; called after each section so messages keep a logical order. */
  flush(): void {
    for (const { n, format } of this.counts.values()) this.messages.push(format(n));
    this.counts.clear();
  }
}
