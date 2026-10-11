import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { EventInput, Lease, Run, Store, StoredEvent } from "./types.ts"
import { assertPlainPath } from "./workspace.ts"

export class StoreConflictError extends Error {
  constructor(message: string) { super(message); this.name = "StoreConflictError" }
}
export class LeaseFenceError extends Error {
  constructor(message = "The project lease is expired or owned by another worker") { super(message); this.name = "LeaseFenceError" }
}

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

interface RunRow { id: string; project_id: string; generation: number; body: string }
interface LeaseRow { project_id: string; owner: string; epoch: number; expires_at: number }
interface EventRow { seq: number; id: string; project_id: string; run_id: string | null; task_id: string | null; attempt_id: string | null; kind: string; created_at: number; body: string }
function leaseFrom(row: LeaseRow): Lease { return { projectId: row.project_id, owner: row.owner, epoch: row.epoch, expiresAt: row.expires_at } }

/** Synchronous transactions keep aggregate state and its change history indivisible. */
export class SQLiteStore implements Store {
  private readonly db: Database
  private writing = false
  private closed = false

  constructor(path: string) {
    if (path !== ":memory:") {
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) assertPlainPath(file)
      mkdirSync(dirname(path), { recursive: true })
      assertPlainPath(path)
    }
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, generation INTEGER NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id);
      CREATE TABLE IF NOT EXISTS leases (
        project_id TEXT PRIMARY KEY, owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, project_id TEXT NOT NULL,
        run_id TEXT, task_id TEXT, attempt_id TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL,
        UNIQUE(project_id, id)
      );
      CREATE INDEX IF NOT EXISTS events_project_sequence ON events(project_id, seq);
      CREATE INDEX IF NOT EXISTS events_project_run_sequence ON events(project_id, run_id, seq);
    `)
  }

  private transaction<T>(operation: () => T): T {
    if (this.writing) throw new StoreConflictError("Nested store write transactions are not supported; change the project callback's runs array")
    this.db.exec("BEGIN IMMEDIATE")
    this.writing = true
    try {
      const result = operation()
      if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
        throw new StoreConflictError("Store mutation callbacks must be synchronous")
      }
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    } finally {
      this.writing = false
    }
  }

  private validate(run: Run, projectId = run.projectId): string {
    if (!run.id || !run.projectId || run.projectId !== projectId || !Number.isSafeInteger(run.generation) || run.generation < 0) {
      throw new StoreConflictError("Run identity, project, and generation must be valid")
    }
    return JSON.stringify(run)
  }

  private fence(projectId: string, lease?: Lease): void {
    if (!lease) return
    const current = this.db.query<LeaseRow, [string]>("SELECT * FROM leases WHERE project_id = ?").get(projectId)
    if (lease.projectId !== projectId || !current || current.owner !== lease.owner || current.epoch !== lease.epoch || current.expires_at <= Date.now()) {
      throw new LeaseFenceError()
    }
  }

  private appendEvent(projectId: string, input: EventInput): boolean {
    if (!projectId || !input.kind) throw new StoreConflictError("Events require a project and kind")
    const createdAt = input.createdAt ?? Date.now()
    if (!Number.isSafeInteger(createdAt)) throw new StoreConflictError("Event timestamps must be integer milliseconds")
    const result = this.db.query("INSERT INTO events (id, project_id, run_id, task_id, attempt_id, kind, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO NOTHING")
      .run(input.id ?? crypto.randomUUID(), projectId, input.runId ?? null, input.taskId ?? null, input.attemptId ?? null, input.kind, createdAt, JSON.stringify(sanitizeEventData(input.data)))
    return result.changes === 1
  }

  private changed(run: Run, previous?: Run): void {
    const fields = [...new Set([...Object.keys(run), ...Object.keys(previous ?? {})])].filter(key => JSON.stringify(run[key as keyof Run]) !== JSON.stringify(previous?.[key as keyof Run]))
    this.appendEvent(run.projectId, {
      runId: run.id,
      kind: "run.changed",
      data: {
        action: previous ? "updated" : "created", fields, generation: run.generation,
        status: run.status, phase: run.phase, revision: run.revision,
        tasks: run.tasks.map(task => ({ id: task.spec.id, status: task.status, attempts: task.attempts.length })),
      },
    })
  }

  private insert(run: Run): void {
    const body = this.validate(run)
    if (this.db.query("SELECT 1 FROM runs WHERE id = ?").get(run.id)) throw new StoreConflictError(`Run already exists: ${run.id}`)
    this.db.query("INSERT INTO runs (id, project_id, generation, body) VALUES (?, ?, ?, ?)").run(run.id, run.projectId, run.generation, body)
    this.changed(run)
  }

  create(run: Run): void { this.transaction(() => this.insert(run)) }
  get(id: string): Run | undefined {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id)
    return row ? JSON.parse(row.body) as Run : undefined
  }
  list(projectId: string): Run[] {
    return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE project_id = ? ORDER BY rowid").all(projectId).map(row => JSON.parse(row.body) as Run)
  }

  mutate<T>(id: string, change: (run: Run) => T, fence?: Lease): T {
    const existing = this.get(id)
    if (!existing) throw new StoreConflictError(`Run does not exist: ${id}`)
    return this.project(existing.projectId, runs => {
      const run = runs.find(value => value.id === id)
      if (!run) throw new StoreConflictError(`Run does not exist: ${id}`)
      const result = change(run)
      if (run.id !== id) throw new StoreConflictError("Run identities cannot be changed")
      return result
    }, fence)
  }

  project<T>(projectId: string, change: (runs: Run[]) => T, fence?: Lease): T {
    return this.transaction(() => {
      this.fence(projectId, fence)
      const rows = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE project_id = ? ORDER BY rowid").all(projectId)
      const previous = new Map(rows.map(row => [row.id, row]))
      const runs: Run[] = rows.map(row => JSON.parse(row.body) as Run)
      const result = change(runs)
      if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
        throw new StoreConflictError("Store mutation callbacks must be synchronous")
      }
      const ids = new Set<string>()
      for (const run of runs) {
        this.validate(run, projectId)
        if (ids.has(run.id)) throw new StoreConflictError("A project cannot contain duplicate run identities")
        ids.add(run.id)
        const before = previous.get(run.id)
        if (before && before.generation !== run.generation) throw new StoreConflictError("Run generation cannot be rewritten")
      }
      for (const id of previous.keys()) if (!ids.has(id)) throw new StoreConflictError("Historical runs cannot be removed")
      this.fence(projectId, fence)
      for (const run of runs) {
        const before = previous.get(run.id)
        if (!before) { this.insert(run); continue }
        if (this.validate(run) === before.body) continue
        run.generation = before.generation + 1
        run.updatedAt = Date.now()
        const saved = this.db.query("UPDATE runs SET body = ?, generation = ? WHERE id = ? AND project_id = ? AND generation = ?")
          .run(this.validate(run), run.generation, run.id, projectId, before.generation)
        if (saved.changes !== 1) throw new StoreConflictError("The run changed concurrently")
        this.changed(run, JSON.parse(before.body) as Run)
      }
      this.fence(projectId, fence)
      return result
    })
  }

  event(projectId: string, event: EventInput): boolean { return this.transaction(() => this.appendEvent(projectId, event)) }
  events(projectId: string, runId?: string, after = 0): StoredEvent[] {
    const rows = runId === undefined
      ? this.db.query<EventRow, [string, number]>("SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq").all(projectId, after)
      : this.db.query<EventRow, [string, string, number]>("SELECT * FROM events WHERE project_id = ? AND run_id = ? AND seq > ? ORDER BY seq").all(projectId, runId, after)
    return rows.map(row => ({ seq: row.seq, id: row.id, projectId: row.project_id, ...(row.run_id === null ? {} : { runId: row.run_id }), ...(row.task_id === null ? {} : { taskId: row.task_id }), ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }), kind: row.kind, createdAt: row.created_at, data: JSON.parse(row.body) }))
  }

  private validateClock(now: number, ttlMs: number): void {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now + ttlMs)) throw new StoreConflictError("Lease clock and TTL must be valid integer milliseconds")
  }
  lease(projectId: string, owner: string, now: number, ttlMs: number): Lease | undefined {
    this.validateClock(now, ttlMs)
    if (!projectId || !owner) throw new StoreConflictError("Leases require a project and owner")
    return this.transaction(() => {
      const current = this.db.query<LeaseRow, [string]>("SELECT * FROM leases WHERE project_id = ?").get(projectId)
      if (current && current.expires_at > now && current.owner !== owner) return undefined
      const active = current && current.expires_at > now
      const lease: Lease = { projectId, owner, epoch: active ? current.epoch : (current?.epoch ?? 0) + 1, expiresAt: active ? Math.max(current.expires_at, now + ttlMs) : now + ttlMs }
      this.db.query("INSERT INTO leases (project_id, owner, epoch, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET owner = excluded.owner, epoch = excluded.epoch, expires_at = excluded.expires_at")
        .run(projectId, owner, lease.epoch, lease.expiresAt)
      return lease
    })
  }
  renew(lease: Lease, now: number, ttlMs: number): Lease {
    this.validateClock(now, ttlMs)
    return this.transaction(() => {
      const current = this.db.query<LeaseRow, [string]>("SELECT * FROM leases WHERE project_id = ?").get(lease.projectId)
      if (!current || current.owner !== lease.owner || current.epoch !== lease.epoch || current.expires_at <= now) throw new LeaseFenceError()
      const renewed = { ...leaseFrom(current), expiresAt: Math.max(current.expires_at, now + ttlMs) }
      this.db.query("UPDATE leases SET expires_at = ? WHERE project_id = ? AND owner = ? AND epoch = ?").run(renewed.expiresAt, lease.projectId, lease.owner, lease.epoch)
      return renewed
    })
  }
  release(lease: Lease): void {
    this.transaction(() => { this.db.query("UPDATE leases SET expires_at = 0 WHERE project_id = ? AND owner = ? AND epoch = ?").run(lease.projectId, lease.owner, lease.epoch) })
  }
  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }
}
