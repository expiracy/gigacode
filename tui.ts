import * as Plugin from "@opencode/plugin/tui/plugin"
import type { Context, DialogSelectAction, DialogSelectOption } from "@opencode/plugin/tui/context"
import { createEffect, createRoot, createSignal } from "solid-js"
import { UltraRpc } from "./src/rpc.ts"
import type { WorkflowRun, WorkflowSnapshot } from "./src/workflow-view.ts"
import { openSettingsMenu } from "./src/settings-menu.ts"

interface CommandResult { sessionId: string; command: string; result?: object; error?: string }
type Setting = DialogSelectOption<string> & { detail: string }

const json = (value: unknown) => JSON.stringify(value, null, 2)

/** Native root hydration loads immediate children only; UltraOpenCode workers are grandchildren. */
async function hydrateFamily(ctx: Context, sessionID: string, signal: AbortSignal) {
  let root = sessionID
  const ancestors = new Set<string>()
  while (!signal.aborted) {
    if (ancestors.has(root)) throw new Error("Cyclic native session ancestry")
    ancestors.add(root)
    if (!ctx.data.session.get(root)) await ctx.data.session.sync(root)
    if (signal.aborted) return
    const info = ctx.data.session.get(root)
    if (!info) throw new Error("Native session unavailable")
    if (!info.parentID) break
    root = info.parentID
  }
  const synced = new Set<string>()
  const children = async (parentID: string, agent: string, visit: (id: string) => Promise<void>) => {
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      if (signal.aborted) return
      const page = await ctx.client.session.list({ parentID, cursor }, { signal })
      for (const info of page.data) {
        if (signal.aborted) return
        if (info.parentID !== parentID || info.agent !== agent || synced.has(info.id)) continue
        synced.add(info.id)
        await ctx.data.session.sync(info.id)
        if (!signal.aborted) await visit(info.id)
      }
      cursor = page.cursor.next ?? undefined
      if (cursor && cursors.has(cursor)) throw new Error("Repeated native session cursor")
      if (cursor) cursors.add(cursor)
    } while (cursor)
  }
  await children(root, "ultraopencode-supervisor", supervisor => children(supervisor, "ultraopencode-worker", async () => {}))
}

type WorkflowOption = Setting & { runId?: string; sessionId?: string }
function workflowOptions(snapshot: WorkflowSnapshot): WorkflowOption[] {
  const rows: WorkflowOption[] = []
  const add = (run: WorkflowRun, title: string, detail: string, category: string, description = detail, sessionId?: string, key = title) => rows.push({
    title, value: JSON.stringify([run.id, category, key]), runId: run.id, sessionId, detail, category,
    description: description.replaceAll(/\s+/g, " ").slice(0, 120),
  })
  for (const run of snapshot.runs) {
    add(run, run.objective, json({ status: run.status, phase: run.phase, revision: run.revision, directory: run.directory }), "Workflow", `${run.phase} · ${run.status}`, run.supervisorSessionId)
    const usage = run.usage
    add(run, "Observed worker usage", json(usage), "Usage", `${usage.workers}/${usage.limits.workers} workers · ${usage.attempts}/${usage.limits.attempts} attempts · tokens ${usage.tokens ?? "unknown"} (${usage.tokenObservations}/${usage.attempts} observed) · cost ${usage.cost ?? "unknown"} (${usage.costObservations}/${usage.attempts} observed)`)
    for (const task of run.tasks) {
      const model = task.model?.ref
      const selection = model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : "model pending"
      add(run, task.title, json(task), "Tasks", `${task.status} · ${selection} · ${task.sessionId ?? "session pending"}`, task.sessionId, task.id)
      if (task.waits.length) add(run, `Waiting: ${task.title}`, task.waits.join("\n"), "Waits", undefined, undefined, task.id)
      if (task.result) add(run, `${task.result.current ? "Accepted result" : "Historical result (stale)"}: ${task.title}`, task.result.summary, "Results", undefined, undefined, task.id)
      for (const finding of task.blockers) add(run, `Blocker: ${finding.description}`, json(finding), "Blockers", undefined, undefined, `${task.id}/finding/${finding.id}`)
      if (task.question) add(run, "Input required", task.question, "Blockers", undefined, undefined, `${task.id}/question`)
      if (task.error) add(run, `Worker error: ${task.title}`, task.error, "Blockers", undefined, undefined, `${task.id}/error`)
      for (const check of task.checks) add(run, `Native check: ${check.checkId}`, json(check), "Evidence", `${check.outcome} · exit ${check.exit ?? "unknown"} · ${check.current ? "current final verification" : "historical evidence"}`, undefined, check.id)
    }
    run.errors.forEach((error, index) => add(run, "Run message", error, "Blockers", undefined, undefined, `message/${index}`))
    if (run.omittedErrors) add(run, "Earlier run messages", `${run.omittedErrors} earlier messages omitted. Use inspect or export for the full audit.`, "Blockers")
  }
  if (!rows.length) rows.push({ title: "No workflows in this conversation", value: "empty", category: "Workflow", detail: "No saved workflows belong to this initiating conversation.", description: "No saved workflows" })
  return rows
}

export default Plugin.define({
  id: "open-ultra-code",
  setup(ctx) {
    const rpc = ctx.client.rpc(UltraRpc)
    let disposed = false
    let workflowRefresh: ((force?: boolean) => Promise<void>) | undefined
    let workflowStop: (() => void) | undefined
    let settingsController: AbortController | undefined
    let sessionID: string | undefined, loading: AbortController | undefined
    const refresh = (id: string | undefined) => {
      if (id !== sessionID) settingsController?.abort()
      if (id !== sessionID) workflowStop?.()
      loading?.abort()
      sessionID = id
      if (!id || disposed) return
      const controller = loading = new AbortController()
      void hydrateFamily(ctx, id, controller.signal).catch(() => {
        if (disposed || controller.signal.aborted) return
        ctx.ui.toast.show({ title: "UltraOpenCode subagents", message: "Unable to load existing subagents. Reopen this conversation or reconnect to retry.", variant: "error", sessionID: id })
      })
    }
    const disposeRoot = createRoot(dispose => {
      createEffect(() => {
        const route = ctx.ui.router.current()
        const id = route.type === "session" ? route.sessionID : undefined
        if (id !== sessionID) refresh(id)
      })
      return dispose
    })
    const reconnect = ctx.data.on("server.connected", () => { settingsController?.abort(); refresh(sessionID); void workflowRefresh?.(true) })
    const configuration = async (value: unknown, id: string) => {
      const current = () => { const route = ctx.ui.router.current(); return !disposed && route.type === "session" && route.sessionID === id }
      settingsController?.abort()
      const controller = settingsController = new AbortController()
      try { await openSettingsMenu(ctx, value, id, rpc, current, controller.signal) }
      finally { controller.abort(); if (settingsController === controller) settingsController = undefined }
    }
    const workflow = async (id: string, runId?: string) => {
      workflowStop?.()
      const [snapshot, setSnapshot] = createSignal<WorkflowSnapshot>({ sessionId: id, runs: [] })
      const [error, setError] = createSignal<string>()
      const [controlling, setControlling] = createSignal(false)
      const location = ctx.location ?? ctx.data.location.default()
      const controller = new AbortController()
      let pending: Promise<void> | undefined
      let opened = false, active = true
      let timer: ReturnType<typeof setInterval> | undefined
      const current = () => {
        const route = ctx.ui.router.current()
        return active && !disposed && route.type === "session" && route.sessionID === id
      }
      const refresh = (force = false): Promise<void> => {
        if (!current()) return Promise.resolve()
        if (pending) return force ? pending.then(() => refresh()) : pending
        const work = (async () => {
          try {
            const value = await rpc.workflow({ sessionId: id, ...(runId ? { runId } : {}) }, { location, signal: controller.signal }) as unknown as WorkflowSnapshot
            if (current()) {
              setSnapshot(previous => ({ ...value, runs: value.runs.map(run => {
                const saved = previous.runs.find(saved => saved.id === run.id)
                return saved && saved.generation > run.generation ? saved : run
              }) }))
              setError(undefined)
            }
          }
          catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
        })()
        pending = work
        void work.finally(() => { if (pending === work) pending = undefined })
        return work
      }
      const rows = (): WorkflowOption[] => error() ? [{ title: "Workflow snapshot unavailable", value: "error", category: "Connection", description: error(), detail: `${error()}\nDisplayed state may be stale. Refreshes retry while this view is open and after reconnect.`, }, ...(snapshot().runs.length ? workflowOptions(snapshot()) : [])] : workflowOptions(snapshot())
      const allowed = (action: "pause" | "resume" | "cancel", run: WorkflowRun) => action === "cancel"
        ? !["succeeded", "partial", "failed", "cancelled", "cancelling"].includes(run.status)
        : (action === "pause" ? ["starting", "planning", "running", "recovering", "waiting_input", "waiting_budget"] : ["paused", "waiting_budget"]).includes(run.status)
      const control = async (action: "pause" | "resume" | "cancel", value: string) => {
        if (!current() || controlling() || error()) return
        const row = rows().find(row => row.value === value)
        const run = snapshot().runs.find(run => run.id === row?.runId)
        if (!run || run.parentSessionId !== id || !allowed(action, run)) return
        setControlling(true)
        try {
          await rpc.control({ text: `${action} ${run.id}`, sessionId: id }, { location, signal: controller.signal })
          await refresh(true)
        } catch (cause) {
          if (current()) {
            ctx.ui.toast.show({ title: "UltraOpenCode control error", message: cause instanceof Error ? cause.message : String(cause), variant: "error", sessionID: id })
            await refresh(true)
          }
        }
        finally { setControlling(false) }
      }
      const stop = () => {
        if (!active) return
        active = false; controller.abort(); clearInterval(timer)
        if (workflowRefresh === refresh) workflowRefresh = undefined
        if (workflowStop === stop) workflowStop = undefined
        if (opened) { opened = false; ctx.ui.dialog.clear() }
      }
      workflowStop = stop
      workflowRefresh = refresh
      try {
        await refresh()
        if (!current()) return
        timer = setInterval(() => { void refresh() }, 2000)
        timer.unref()
        opened = true
        const selected = await ctx.ui.dialog.select({ title: "UltraOpenCode workflows", placeholder: "Search tasks, results, blockers and evidence",
          get options() { return rows().map(({ detail, runId, sessionId, ...row }) => row) },
          get actions(): DialogSelectAction<string>[] {
            const controls: DialogSelectAction<string>[] = error() || controlling() ? [] : ([{ action: "pause", title: "Pause", bind: "ctrl+g" }, { action: "resume", title: "Resume", bind: "ctrl+y" }, { action: "cancel", title: "Cancel", bind: "ctrl+x" }] as const)
              .filter(item => snapshot().runs.some(run => run.parentSessionId === id && allowed(item.action, run)))
              .map(item => ({ title: item.title, bind: item.bind, onTrigger: value => { void control(item.action, value) } }))
            return [...controls, { title: "Open agent session", bind: "ctrl+o", onTrigger(value) {
              if (!current()) return
              const row = rows().find(row => row.value === value)
              if (row?.sessionId) ctx.ui.router.navigate({ type: "session", sessionID: row.sessionId })
            } }]
          },
        })
        opened = false
        const row = rows().find(value => value.value === selected)
        const show = row && current()
        stop()
        if (show) await ctx.ui.dialog.alert({ title: row!.title, message: row!.detail })
      } finally { stop() }
    }
    const unsubscribe = rpc.events.on("commandResult", async event => {
      if (disposed) return
      const data = event.data as unknown as CommandResult
      const route = ctx.ui.router.current()
      if (route.type !== "session" || route.sessionID !== data.sessionId) return
      settingsController?.abort()
      workflowStop?.()
      if (data.error) { await ctx.ui.dialog.alert({ title: "UltraOpenCode command error", message: data.error }); return }
      if (data.command.trim() === "config") await configuration(data.result, data.sessionId)
      else if (/^status(?:\s|$)/.test(data.command.trim())) void workflow(data.sessionId, data.command.trim().split(/\s+/)[1])
      else await ctx.ui.dialog.alert({ title: "UltraOpenCode command result", message: json(data.result) })
    })
    return () => { if (!disposed) { disposed = true; settingsController?.abort(); workflowStop?.(); loading?.abort(); disposeRoot(); reconnect(); unsubscribe() } }
  },
})
