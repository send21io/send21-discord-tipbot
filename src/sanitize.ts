// Cleaning user text before it goes into an embed or a send21 memo.

// C0/C1 controls, zero-width characters and bidi overrides (used for spoofing).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const URL_LIKE = /(?:https?:\/\/|www\.|discord\.gg\/|\b[a-z0-9-]+\.(?:com|io|gg|xyz|net|org|app|link|me)\b)/i;

export type NoteCheck = { ok: true; note: string | null } | { ok: false; error: string };

/** A tip note: plain text, one line, no links, no mentions, max 80 characters. */
export function cleanNote(raw: string | null | undefined, max = 80): NoteCheck {
  if (raw === null || raw === undefined) return { ok: true, note: null };
  const note = String(raw).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!note) return { ok: true, note: null };
  if (URL_LIKE.test(note)) return { ok: false, error: "🔗 no links in notes" };
  if (/@(?:everyone|here)|<[@#&!:]/.test(note)) return { ok: false, error: "🙅 no mentions in notes" };
  if ([...note].length > max) return { ok: false, error: `✂️ note max ${max} characters` };
  // Neutralise Discord markdown so a note cannot fake a link or a heading.
  return { ok: true, note: note.replace(/([\\*_~`|>#[\]()-])/g, "\\$1") };
}

/** Same text without markdown escapes, for the send21 memo (plain text on the pay page). */
export const plain = (escaped: string): string => escaped.replace(/\\([\\*_~`|>#[\]()-])/g, "$1");
