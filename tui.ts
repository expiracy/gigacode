import * as Plugin from "@opencode/plugin/tui/plugin"
import type { Context, DialogSelectAction, DialogSelectOption } from "@opencode/plugin/tui/context"
import { createEffect, createRoot, createSignal } from "solid-js"
import { GigaCodeRpc } from "./src/rpc.ts"
import type { WorkflowRun, WorkflowSnapshot } from "./src/workflow-view.ts"
import { openSettingsMenu } from "./src/settings-menu.ts"
import { showWorkflowInspection, showWorkflowExport } from "./src/workflow-inspection-ui.ts"
import { sanitizeEventData } from "./src/redaction.ts"
import { showToast } from "./src/ui-feedback.ts"

interface CommandResult { sessionId: string; command: string; result?: object; error?: string }
type Setting = DialogSelectOption<string> & { detail: string }

const json = (value: unknown) => JSON.stringify(value, null, 2)
const errorMessage = (cause: unknown, fallback: string) => {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback
  return (sanitizeEventData(message) as string).replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 400) || fallback
}
const aborted = (cause: unknown) => cause instanceof Error && cause.name === "AbortError"

/** Native root hydration loads immediate children only; GigaCode workers are grandchildren. */
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
  await children(root, "gigacode-supervisor", supervisor => children(supervisor, "gigacode-worker", async () => {}))
}

type WorkflowOption = Setting & { runId?: string; sessionId?: string }
function workflowOptions(snapshot: WorkflowSnapshot): WorkflowOption[] {
  const rows: WorkflowOption[] = []
  const add = (run: WorkflowRun, title: string, detail: string, category: string, description = detail, sessionId?: string, key = title) => rows.push({
    title, value: JSON.stringify([run.id, category, key]), runId: run.id, sessionId, detail, category,
    description: description.replaceAll(/\s+/g, " ").slice(0, 120),
  })
  for (const run of snapshot.runs) {
    add(run, run.objective, json({ id: run.id, status: run.status, phase: run.phase, revision: run.revision, proposalRevision: run.proposalRevision, directory: run.directory }), "Workflow", `${run.id} · ${run.phase} · ${run.status}${run.proposalRevision === undefined ? "" : ` · saved proposal @${run.proposalRevision}`}`, run.supervisorSessionId)
    add(run, "Run ID", run.id, "Workflow", run.id, undefined, "run-id")
    add(run, "Status", `${run.phase} · ${run.status}`, "Workflow", undefined, undefined, "status")
    add(run, "Saved proposal revision", run.proposalRevision === undefined ? "No saved proposal" : String(run.proposalRevision), "Workflow", run.proposalRevision === undefined ? "No saved proposal" : `@${run.proposalRevision}`, undefined, "saved-proposal")
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
  id: "gigacode",
  setup(ctx) {
    const rpc = ctx.client.rpc(GigaCodeRpc)
    let disposed = false
    let commandEpoch = 0
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
        showToast(ctx, { title: "GigaCode subagents", message: "Unable to load existing subagents. Reopen this conversation or reconnect to retry.", variant: "error", sessionID: id })
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
    const reconnect = ctx.data.on("server.connected", () => { commandEpoch++; settingsController?.abort(); refresh(sessionID); void workflowRefresh?.(true) })
    const configuration = async (value: unknown, id: string) => {
      const current = () => { const route = ctx.ui.router.current(); return !disposed && route.type === "session" && route.sessionID === id }
      settingsController?.abort()
      const controller = settingsController = new AbortController()
      try { await openSettingsMenu(ctx, value, id, rpc, current, controller.signal) }
      catch (cause) {
        if (current() && !controller.signal.aborted && !aborted(cause)) showToast(ctx, { title: "GigaCode settings error", message: errorMessage(cause, "Unable to open GigaCode settings. Retry /gigacode config."), variant: "error", sessionID: id })
      }
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
      let panelOpen = false, panelNumber = 0, interaction = 0
      let request: AbortController | undefined
      let selection: string | undefined
      let presentation: { kind: "inspect" | "export"; result: unknown } | undefined
      let menuSelection: string | undefined
      let proposal: { id: string; revision: number; objective: string } | undefined
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
          catch (cause) { if (current()) setError(errorMessage(cause, "Unable to refresh this workflow. Reconnect to retry.")) }
        })()
        pending = work
        void work.finally(() => { if (pending === work) pending = undefined })
        return work
      }
      const rows = (): WorkflowOption[] => error() ? [{ title: "Workflow snapshot unavailable", value: "error", category: "Connection", description: error(), detail: `${error()}\nDisplayed state may be stale. Refreshes retry while this view is open and after reconnect.`, }, ...(snapshot().runs.length ? workflowOptions(snapshot()) : [])] : workflowOptions(snapshot())
      const allowed = (action: "pause" | "resume" | "cancel", run: WorkflowRun) => action === "cancel"
        ? !["succeeded", "partial", "failed", "cancelled", "cancelling"].includes(run.status)
        : (action === "pause" ? ["starting", "planning", "running", "recovering", "waiting_input", "waiting_budget"] : ["paused", "waiting_budget"]).includes(run.status)
      const selectedRun = (value: string) => {
        const row = rows().find(row => row.value === value)
        const run = snapshot().runs.find(run => run.id === row?.runId)
        return run?.parentSessionId === id ? run : undefined
      }
      const ready = (run: WorkflowRun) => run.status === "ready" && Number.isSafeInteger(run.proposalRevision) && run.proposalRevision! > 0
      const control = async (action: "pause" | "resume" | "cancel" | "inspect" | "export" | "run", run: WorkflowRun, value: string, revision?: number) => {
        if (!current() || error()) return
        const token = interaction
        const ownRequest = request = new AbortController()
        const valid = () => current() && interaction === token && !ownRequest.signal.aborted
        setControlling(true)
        try {
          const result = await rpc.control({ text: `${action} ${run.id}${action === "run" ? `@${revision}` : ""}`, sessionId: id }, { location, signal: AbortSignal.any([controller.signal, ownRequest.signal]) })
          if (!valid()) return
          if (action === "inspect" || action === "export") {
            selection = value
            presentation = { kind: action, result }
            ctx.ui.dialog.clear()
          } else await refresh(true)
        } catch (cause) {
          if (valid()) {
            showToast(ctx, { title: "GigaCode control error", message: errorMessage(cause, "Unable to complete this workflow action. Inspect its state before retrying."), variant: "error", sessionID: id })
            await refresh(true)
          }
        }
        finally { if (request === ownRequest) { request = undefined; setControlling(false) }; ownRequest.abort() }
      }
      const stop = () => {
        if (!active) return
        active = false; controller.abort(); request?.abort(); clearInterval(timer)
        if (workflowRefresh === reconnectRefresh) workflowRefresh = undefined
        if (workflowStop === stop) workflowStop = undefined
        if (opened) { opened = false; ctx.ui.dialog.clear() }
      }
      const reconnectRefresh = (force = false) => {
        interaction++; request?.abort(); request = undefined; setControlling(false)
        if (opened && !panelOpen) { stop(); return Promise.resolve() }
        return refresh(force)
      }
      workflowStop = stop
      workflowRefresh = reconnectRefresh
      try {
        await refresh()
        if (!current()) return
        timer = setInterval(() => { void refresh() }, 2000)
        timer.unref()
        while (current()) {
          opened = panelOpen = true
          const panel = ++panelNumber
          const selected = await ctx.ui.dialog.select({ title: "GigaCode workflows", placeholder: "Search workflows, tasks and evidence; use actions for the selected workflow", current: selection,
            get options() { return rows().map(({ detail, runId, sessionId, ...row }) => row) },
            get actions(): DialogSelectAction<string>[] {
              const epoch = interaction
              return error() || controlling() || !snapshot().runs.length ? [] : [{ title: "Actions", bind: "ctrl+a", onTrigger(value) {
                if (!current() || !panelOpen || panelNumber !== panel || interaction !== epoch || controlling() || error()) return
                if (!selectedRun(value)) return
                menuSelection = value
                panelOpen = false
                ctx.ui.dialog.clear()
              } }]
            },
          })
          opened = panelOpen = false
          if (!current()) break
          if (!presentation) {
            const value = menuSelection ?? selected
            menuSelection = undefined
            const row = rows().find(row => row.value === value)
            if (!row) break
            selection = value
            if (error() || controlling()) continue
            interaction++; request?.abort(); request = undefined; setControlling(false)
            const run = selectedRun(value!)
            if (!run) break
            const revision = run.proposalRevision
            const controls = ([{ action: "pause", title: "Pause" }, { action: "resume", title: "Resume" }, { action: "cancel", title: "Cancel" }] as const)
              .filter(item => allowed(item.action, run)).map(item => ({ title: item.title, value: item.action }))
            opened = true
            const action = await ctx.ui.dialog.select({ title: "GigaCode workflow actions", placeholder: run.objective, options: [
              { title: "Inspect", value: "inspect", description: "Proposal, task results and observed evidence" },
              { title: "Run saved proposal", value: "run", disabled: !ready(run), description: ready(run) ? `Execute saved proposal @${revision}` : "Requires a ready workflow with a saved proposal" },
              { title: "Export", value: "export", description: "Save the full audit as JSON, Markdown and HTML" },
              ...controls,
              ...(row.sessionId ? [{ title: "Open agent session", value: "session", description: row.sessionId }] : []),
              { title: "Back to workflows", value: "back" },
            ] })
            opened = false
            if (!current()) break
            if (error() || controlling()) continue
            const latest = selectedRun(value!)
            if (!latest) continue
            if (action === "inspect" || action === "export") { void control(action, latest, value!); continue }
            if (action === "run" && ready(run)) {
              proposal = { id: run.id, revision: revision!, objective: run.objective }; setControlling(true)
            } else if (action === "pause" || action === "resume" || action === "cancel") {
              if (allowed(action, latest)) void control(action, latest, value!)
              continue
            } else if (action === "session" && row.sessionId) {
              ctx.ui.router.navigate({ type: "session", sessionID: row.sessionId }); continue
            } else continue
          }
          if (proposal) {
            const captured = proposal; proposal = undefined
            const epoch = interaction
            const objective = captured.objective.replaceAll(/\s+/g, " ")
            const preview = objective.length > 240 ? `${objective.slice(0, 240)} [truncated]` : objective
            opened = true
            const confirmed = await ctx.ui.dialog.confirm({ title: "Run saved proposal?", message: `Run: ${captured.id}\nSaved proposal revision: ${captured.revision}\n\nObjective${objective.length > 240 ? " (preview)" : ""}: ${preview}\n\nExecute this revision with captured settings and native permissions?`, label: { confirm: "Run saved proposal", cancel: "Back to workflows" } })
            opened = false
            if (!current() || interaction !== epoch) break
            if (confirmed) {
              await refresh(true)
              if (!current() || interaction !== epoch) break
              const run = snapshot().runs.find(run => run.id === captured.id && run.parentSessionId === id)
              if (!error() && run && ready(run) && run.proposalRevision === captured.revision) void control("run", run, selection!, captured.revision)
              else { setControlling(false); showToast(ctx, { title: "GigaCode saved proposal", message: "The selected proposal changed or is no longer ready. Review the workflow before running it.", variant: "info", sessionID: id }) }
            } else setControlling(false)
            continue
          }
          if (presentation) {
            const result = presentation; presentation = undefined
            opened = true
            await (result.kind === "inspect" ? showWorkflowInspection : showWorkflowExport)(ctx, result.result, current)
            opened = false
            continue
          }
        }
      } catch (cause) {
        if (current() && !controller.signal.aborted && !aborted(cause)) showToast(ctx, { title: "GigaCode workflow error", message: errorMessage(cause, "Unable to display this workflow. Retry /gigacode status."), variant: "error", sessionID: id })
      } finally { stop() }
    }
    const unsubscribe = rpc.events.on("commandResult", async event => {
      if (disposed) return
      const data = event.data as unknown as CommandResult
      const route = ctx.ui.router.current()
      if (route.type !== "session" || route.sessionID !== data.sessionId) return
      settingsController?.abort()
      workflowStop?.()
      const epoch = ++commandEpoch
      try {
        if (data.error) { await ctx.ui.dialog.alert({ title: "GigaCode command error", message: errorMessage(data.error, "Unable to complete this command. Inspect the workflow before retrying.") }); return }
        if (data.command.trim() === "config") await configuration(data.result, data.sessionId)
        else if (/^status(?:\s|$)/.test(data.command.trim())) void workflow(data.sessionId, data.command.trim().split(/\s+/)[1])
        else await ctx.ui.dialog.alert({ title: "GigaCode command result", message: json(data.result) })
      } catch (cause) {
        const route = ctx.ui.router.current()
        if (!disposed && commandEpoch === epoch && route.type === "session" && route.sessionID === data.sessionId && !aborted(cause)) {
          showToast(ctx, { title: "GigaCode command error", message: errorMessage(cause, "Unable to display this command result. Inspect the workflow before retrying."), variant: "error", sessionID: data.sessionId })
        }
      }
    })
    return () => { if (!disposed) { disposed = true; settingsController?.abort(); workflowStop?.(); loading?.abort(); disposeRoot(); reconnect(); unsubscribe() } }
  },
})
