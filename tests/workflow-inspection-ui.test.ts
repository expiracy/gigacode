import { expect, test } from "bun:test"
import { inspectionPages, showWorkflowExport, showWorkflowInspection } from "../src/workflow-inspection-ui.ts"

test("inspection preserves run identity and saved proposal revision in readable pages", () => {
  const pages = inspectionPages({ run: {
    id: "run_12345678901234567890123456789012", objective: "Review " + "a long objective ".repeat(150),
    status: "ready", phase: "planning", revision: 9, proposal: { revision: 4, rationale: "A saved proposal", tasks: [], criteria: [] },
    tasks: [], directory: "/a/project/path", errors: [],
  }, events: [] })
  expect(pages.map(page => page.message).join("\n")).toContain("run_12345678901234567890123456789012")
  expect(pages.map(page => page.message).join("\n")).toContain("Saved proposal revision: 4")
  expect(pages.every(page => page.message.split("\n").length <= 14)).toBe(true)
  expect(pages.every(page => page.message.split("\n").every(line => line.length <= 48))).toBe(true)
})

test("export presents the generated report paths without overflowing a result dialog", async () => {
  const dialogs: any[] = [], choices = ["0", undefined]
  const ctx = { ui: { dialog: {
    async select(options: any) { dialogs.push({ kind: "select", ...options }); return choices.shift() },
    async alert(options: any) { dialogs.push({ kind: "alert", ...options }) },
  } } }
  const path = "/project/" + "long-directory/".repeat(15) + "report.json"
  await showWorkflowExport(ctx as any, { json: path, markdown: "/project/report.md", dashboard: "/project/report.html" }, () => true)
  expect(dialogs[0]?.options.map((option: any) => option.title)).toEqual(["JSON report", "Markdown report", "HTML dashboard"])
  expect(dialogs[1]?.message.replaceAll("\n", "")).toContain(path)
  expect(dialogs[1]?.message.split("\n").length).toBeLessThanOrEqual(14)
  expect(dialogs[2]?.current).toBe("0")
})

test("inspection opens a bounded detail page and returns to its page picker", async () => {
  const dialogs: any[] = [], choices = ["0", undefined]
  const ctx = { ui: { dialog: {
    async select(options: any) { dialogs.push({ kind: "select", ...options }); return choices.shift() },
    async alert(options: any) { dialogs.push({ kind: "alert", ...options }) },
  } } }
  await showWorkflowInspection(ctx as any, { run: { id: "run_selected", status: "ready", proposal: { revision: 4 }, tasks: [] } }, () => true)
  expect(dialogs.map(dialog => dialog.kind)).toEqual(["select", "alert", "select"])
  expect(dialogs[0].title).toBe("GigaCode inspection")
  expect(dialogs[1].message).toContain("Run ID: run_selected")
  expect(dialogs[2].current).toBe("0")
})

test("inspection pages fit the terminal width for Unicode text", () => {
  const content = inspectionPages({ run: { id: "run_unicode", objective: "界".repeat(100), tasks: [] } })
  expect(content.every(page => page.message.split("\n").every(line => Bun.stringWidth(line) <= 48))).toBe(true)
})

test("leaving the workflow while choosing an inspection page prevents a late detail dialog", async () => {
  let active = true, alerts = 0
  const ctx = { ui: { dialog: {
    async select() { active = false; return "0" },
    async alert() { alerts++ },
  } } }
  await showWorkflowInspection(ctx as any, { run: { id: "run_left", tasks: [] } }, () => active)
  expect(alerts).toBe(0)
})
