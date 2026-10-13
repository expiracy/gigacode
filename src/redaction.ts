const redacted = "[REDACTED]"
const sensitiveKey = /(?:authorization(?:header)?|apikey|apitoken|password|passwd|secret|accesstoken|refreshtoken|idtoken|authtoken|credentials?|cookies?|privatekey)$|^auth$|^token$/i

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[a-z0-9+/_=.-]+/gi, "$1 " + redacted)
    .replace(/\b(api[_-]?key|password|passwd|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret)["']?\s*[:=]\s*["']?[^\s,"';}]+["']?/gi, "$1=" + redacted)
    .replace(/\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/gi, redacted)
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, "$1" + redacted + "@")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, redacted)
}

/** Copies audit data into JSON-safe values and removes recognizable credentials. */
export function sanitizeEventData(data: unknown): unknown {
  const ancestors = new Set<object>()
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactText(value)
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value === "bigint") return String(value)
    if (typeof value !== "object") return null
    if (depth > 40) return "[TRUNCATED]"
    if (ancestors.has(value)) return "[CIRCULAR]"
    ancestors.add(value)
    try {
      if (Array.isArray(value)) return value.map(item => visit(item, depth + 1))
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
      if (value instanceof Error) return { name: redactText(value.name), message: redactText(value.message) }
      const result: Record<string, unknown> = Object.create(null)
      for (const [key, child] of Object.entries(value)) {
        result[key] = sensitiveKey.test(key.replace(/[_-]/g, "")) ? redacted : visit(child, depth + 1)
      }
      return result
    } finally {
      ancestors.delete(value)
    }
  }
  return visit(data, 0)
}

