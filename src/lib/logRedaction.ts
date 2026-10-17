// Application logs are diagnostic records, not a second store of credentials/contact data.
export function redactLog(value: unknown): string {
 const text = value instanceof Error ? value.message : typeof value === 'object' && value && 'message' in value ? String(value.message) : String(value ?? '')
 return text.replace(/Bearer\s+[^\s,;]+/gi,'Bearer [redacted]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[token]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]')
  .replace(/\b(re_|sb_secret_)[A-Za-z0-9_-]+/g,'[key]').slice(0,500)
}
