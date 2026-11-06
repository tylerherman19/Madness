// Where to go after logging in: a `next` path on this site, or the fallback.
// Only same-site paths are followed ("/notifications", not "//evil.example"
// or "https://…"), so the parameter can't send anyone off the site.
export function safeNext(value: string | null | undefined, fallback = '/pick'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  if (/[\u0000-\u001f]/.test(value)) return fallback
  return value
}
