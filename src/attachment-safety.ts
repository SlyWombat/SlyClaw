/**
 * Filename safety check for inbound WhatsApp attachments.
 *
 * `documentMessage.fileName` rides in from the sender — anyone could craft
 * something like `../../../etc/foo` which, when path.join'd onto our
 * attachments directory, escapes the intended root. Reject anything with path
 * separators, parent refs, null/control bytes, or non-printable characters.
 * The caller substitutes a safe fallback name when this returns false.
 */
export function isSafeAttachmentName(filename: string | undefined | null): boolean {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.length === 0 || filename.length > 255) return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (filename.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(filename)) return false;
  if (filename.startsWith('.')) return false;
  return true;
}
