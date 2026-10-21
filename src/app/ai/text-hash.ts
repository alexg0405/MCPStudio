/** FNV-1a offset basis and prime (32 bits). */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * A short key for a text: it changes when the text does, and is the same on every machine and every run (no clock, no
 * locale). Not a security hash: it only tells "the catalog is the same as the one the AI already has" from "it changed".
 */
export function hashText(text: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME);
  return (h >>> 0).toString(36);
}
