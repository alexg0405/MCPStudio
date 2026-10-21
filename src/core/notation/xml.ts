/**
 * A very small XML reader, enough for MusicXML files: elements with attributes and text, comments, CDATA, the XML
 * declaration and the DOCTYPE line (skipped), the five predefined entities and numeric character references. Core code
 * has no DOM, and a MusicXML file is plain, well-formed text.
 */

/** One element of the tree. */
export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** The text directly inside the element (children's text is not included), trimmed. */
  text: string;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Replaces entities in text: "&amp;" becomes "&", "&#233;" becomes "é". */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? whole;
  });
}

/** Escapes text for writing inside an element or an attribute. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Most elements deep a file may nest (a guard against a hostile file). */
const MAX_DEPTH = 64;

/** The error `parseXml` throws for a file it cannot read. */
export class XmlError extends Error {}

function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attributes[match[1] as string] = decodeEntities((match[3] ?? match[4]) as string);
  }
  return attributes;
}

/** Reads a document and returns its root element. Throws `XmlError` when the text is not well-formed enough to read. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    const current = stack[stack.length - 1] as XmlNode;
    current.text += decodeEntities(source.slice(last, match.index));
    last = tag.lastIndex;
    if (match[1] !== undefined) {
      current.text += match[1];
    } else if (match[2] !== undefined) {
      if (stack.length < 2 || current.name !== match[2]) throw new XmlError(`The file is not valid XML: </${match[2]}> closes something that is not open.`);
      stack.pop();
    } else if (match[3] !== undefined) {
      const node: XmlNode = { name: match[3], attributes: readAttributes(match[4] ?? ''), children: [], text: '' };
      current.children.push(node);
      if (match[5] !== '/') {
        if (stack.length > MAX_DEPTH) throw new XmlError('The file nests elements too deeply to be a score.');
        stack.push(node);
      }
    }
  }
  if (stack.length !== 1) throw new XmlError('The file is not valid XML: an element is never closed.');
  const top = root.children[0];
  if (!top) throw new XmlError('The file has no content.');
  trimText(top);
  return top;
}

function trimText(node: XmlNode): void {
  node.text = node.text.trim();
  for (const child of node.children) trimText(child);
}

/** The first child element with this name. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((candidate) => candidate.name === name);
}

/** Every child element with this name. */
export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((candidate) => candidate.name === name) : [];
}

/** The text of a child element, or undefined. */
export function childText(node: XmlNode | undefined, name: string): string | undefined {
  return child(node, name)?.text;
}
