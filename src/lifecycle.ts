interface Resources {
  stop: AbortController
  invocations: Set<Promise<unknown>>
  registrations: { dispose: () => Promise<void> }[]
  observer: () => Promise<void> | undefined
  close: () => void
}

/** One shutdown drains in-flight work before retiring registrations and state. */
export function resourceCleanup(resources: Resources): () => Promise<void> {
  let completion: Promise<void> | undefined
  return () => completion ??= (async () => {
    resources.stop.abort(new Error("Plugin is reloading or shutting down"))
    await Promise.allSettled([...resources.invocations])
    const failures: unknown[] = []
    try { await resources.observer() } catch (error) { failures.push(error) }
    for (const registration of resources.registrations.toReversed()) {
      try { await registration.dispose() } catch (error) { failures.push(error) }
    }
    try { resources.close() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, "Ultracode cleanup failed")
  })()
}
