/**
 * Reduces an address to something the person who owns it recognises and nobody
 * else can reuse.
 *
 * Needed by the routes an unauthenticated caller reaches with only a token —
 * invitation preview, today. The recipient has to be able to confirm *which*
 * mailbox was invited before they hand over a password, but the response also
 * ends up in a URL bar, a browser cache, and sometimes a forwarded chat message,
 * so it must not carry a confirmed, spellable address for a real person.
 *
 * The mask is a fixed three dots rather than one per hidden character: a
 * proportional mask leaks the local part's length, which is most of what a
 * guesser wants for a short address.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  // lastIndexOf, because the local part of an address may legally contain "@"
  // when quoted — the final one is always the separator.
  const separator = trimmed.lastIndexOf("@");
  const local = separator > 0 ? trimmed.slice(0, separator) : "";
  const domain = separator > 0 ? trimmed.slice(separator + 1) : "";

  // Nothing recognisable to show without revealing the whole string, so show
  // nothing. Reaching here means the stored value was never a valid address.
  if (!local || !domain) return "•••";

  return `${local.slice(0, 1)}•••@${domain}`;
}
