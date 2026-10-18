import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Lease, Store } from "./types.ts"

export class ProjectOwnershipError extends Error {
  constructor() { super("Project scheduler is owned by another process") }
}
export interface ProjectCoordination {
  owner: string; lease?: Lease; users: number; heartbeat?: ReturnType<typeof setInterval>; failure?: unknown; stores: Map<Store, number>; driving: Set<string>
}
// Location instances and plugin reloads must keep the same shared ownership record.
const coordinatorSymbol = Symbol.for("gigacode.project-coordination.v1")
const coordinatorMap: Map<string, ProjectCoordination> = Reflect.get(globalThis, coordinatorSymbol) ?? new Map<string, ProjectCoordination>()
Reflect.set(globalThis, coordinatorSymbol, coordinatorMap)
export function projectCoordination(projectId: string, key?: string): ProjectCoordination {
  const identity = key ? `${projectId}:${process.platform === "win32" ? resolve(key).toLowerCase() : resolve(key)}` : undefined
  if (identity && coordinatorMap.has(identity)) return coordinatorMap.get(identity)!
  const value: ProjectCoordination = { owner: `owner_${randomUUID().replaceAll("-", "")}`, users: 0, stores: new Map(), driving: new Set() }
  if (identity) coordinatorMap.set(identity, value)
  return value
}
export function acquireProjectLease(shared: ProjectCoordination, store: Store, projectId: string): Lease {
  if (shared.lease) {
    shared.lease = store.renew(shared.lease, Date.now(), 30_000)
    shared.users++
    shared.stores.set(store, (shared.stores.get(store) ?? 0) + 1)
    return shared.lease
  }
  const lease = store.lease(projectId, shared.owner, Date.now(), 30_000)
  if (!lease) throw new ProjectOwnershipError()
  shared.lease = lease; shared.users++
  shared.stores.set(store, (shared.stores.get(store) ?? 0) + 1)
  shared.failure = undefined
  shared.heartbeat = setInterval(() => {
    if (!shared.lease || shared.failure) return
    const activeStore = shared.stores.keys().next().value
    try { if (activeStore) shared.lease = activeStore.renew(shared.lease, Date.now(), 30_000) } catch (error) { shared.failure = error }
  }, 5_000)
  shared.heartbeat.unref()
  return lease
}

export function releaseProjectLease(shared: ProjectCoordination, store: Store): void {
  const count = shared.stores.get(store) ?? 0
  if (count <= 1) shared.stores.delete(store)
  else shared.stores.set(store, count - 1)
  if (--shared.users === 0 && shared.lease) {
    clearInterval(shared.heartbeat); shared.heartbeat = undefined
    store.release(shared.lease); shared.lease = undefined; shared.failure = undefined
  }
}
