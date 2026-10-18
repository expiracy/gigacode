import type { Context } from "@opencode/plugin/tui/context"

export interface InspectionPage { title: string; message: string }

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown) => value === undefined || value === null ? "None" : String(value)

function pages(title: string, content: string): InspectionPage[] {
  const bounded = content.length > 18000 ? content.slice(0, 18000) + "\n[More content is available in the exported audit.]" : content
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  const lines = bounded.replaceAll("\t", "  ").split(/\r?\n/).flatMap(line => {
    const wrapped: string[] = []
    let current = ""
    for (const { segment } of segmenter.segment(line)) {
      if (Bun.stringWidth(current + segment) > 48) { wrapped.push(current); current = "" }
      current += segment
    }
    return [...wrapped, current]
  })
  const count = Math.ceil(lines.length / 14)
  return Array.from({ length: count }, (_, index) => ({
    title: count === 1 ? title : `${title} (${index + 1}/${count})`,
    message: lines.slice(index * 14, (index + 1) * 14).join("\n"),
  }))
}

export function inspectionPages(result: unknown): InspectionPage[] {
  const data = record(result), run = record(data.run), proposal = record(run.proposal)
  const overview = [
    `Run ID: ${text(run.id)}`, `Status: ${text(run.status)}`, `Phase: ${text(run.phase)}`,
    `Current revision: ${text(run.revision)}`, `Saved proposal revision: ${text(proposal.revision)}`,
    `Directory: ${text(run.directory)}`, "", `Objective: ${text(run.objective)}`,
  ].join("\n")
  return [
    ...pages("Workflow overview", overview),
    ...(Object.keys(proposal).length ? pages("Saved proposal", JSON.stringify(proposal, null, 2)) : []),
    ...list(run.tasks).flatMap(value => {
      const task = record(value), spec = record(task.spec)
      const attempts = list(task.attempts).map(record)
      return pages(`Task: ${text(spec.id ?? task.id)}`, JSON.stringify({
        id: spec.id ?? task.id, title: spec.title ?? task.title, status: task.status, role: spec.role, stage: spec.stage,
        dependencies: spec.dependencies, acceptedAttemptId: task.acceptedAttemptId,
        attempts: attempts.map(attempt => ({ id: attempt.id, status: attempt.status, sessionId: attempt.sessionId, result: attempt.result, error: attempt.error, checks: attempt.checks })),
      }, null, 2))
    }),
    ...(list(run.errors).length ? pages("Run errors", JSON.stringify(run.errors, null, 2)) : []),
    ...pages("Recent events", list(data.events).slice(-20).map(value => { const event = record(value); return `${text(event.kind)}${event.taskId ? ` · ${text(event.taskId)}` : ""}` }).join("\n") || "No recorded events. Full event data is available through Export."),
  ]
}

async function showPages(ctx: Context, title: string, content: InspectionPage[], active: () => boolean): Promise<void> {
  let current: string | undefined
  while (active()) {
    const selected = await ctx.ui.dialog.select({ title, placeholder: "Choose a page; Escape returns to workflows", current,
      options: content.map((page, index) => ({ title: page.title, value: String(index), description: page.message.split("\n")[0] })),
    })
    if (!active() || selected === undefined) return
    const page = content[Number(selected)]
    if (!page) return
    current = selected
    await ctx.ui.dialog.alert({ title: page.title, message: page.message })
  }
}

export async function showWorkflowInspection(ctx: Context, result: unknown, active: () => boolean): Promise<void> {
  await showPages(ctx, "GigaCode inspection", inspectionPages(result), active)
}
export async function showWorkflowExport(ctx: Context, result: unknown, active: () => boolean): Promise<void> {
  const data = record(result)
  const content = ([["json", "JSON report"], ["markdown", "Markdown report"], ["dashboard", "HTML dashboard"]] as const)
    .flatMap(([key, title]) => typeof data[key] === "string" ? pages(title, `Saved report:\n${data[key]}`) : [])
  await showPages(ctx, "GigaCode export", content, active)
}
