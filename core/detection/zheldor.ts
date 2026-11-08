/** The forwarding receipt the public JDE tracker accepts, with its printed grouping. */
export function isZheldorReference(raw: string): boolean {
  return typeof raw === 'string' && raw.length <= 64 && /^\d{16}$/.test(raw.replace(/[\s-]/g, ''));
}
