import * as Plugin from "@opencode/plugin/tui/plugin"
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { UltraRpc } from "./src/rpc.ts"
import type { Config } from "./src/types.ts"

interface Configuration { config: Config; hostVersion?: string; promptVersion?: string; directory?: string; state?: string }
interface CommandResult { sessionId: string; command: string; result?: object; error?: string }
type Setting = DialogSelectOption<string> & { detail: string }

const limitLabels: Record<string, string> = {
  workers: "Concurrent workers", runs: "Concurrent runs", attempts: "Worker attempts per run",
  repairRounds: "Repair rounds", workerMs: "Worker deadline (ms)", runMs: "Active run deadline (ms)",
  elapsedMs: "Elapsed run deadline (ms)", steps: "Model steps per worker",
}
const json = (value: unknown) => JSON.stringify(value, null, 2)

/** A searchable, read-only view of effective settings, with full values on selection. */
function configurationOptions(value: unknown): Setting[] {
  if (!value || typeof value !== "object" || !("config" in value)) throw new Error("Ultra returned no effective configuration. Check the installation and restart OpenCode.")
  const { config, hostVersion, promptVersion, directory, state } = value as Configuration
  const options: Setting[] = []
  const add = (title: string, detail: string, category: string, description = detail) => options.push({ title, value: `${category}/${title}`, detail, category, description: description.replaceAll(/\s+/g, " ").slice(0, 100) })
  add("How to edit settings", "This view is read-only. In OpenChamber, open Settings → Plugins, select the Ultra package entry, and edit its Options (JSON). Edit global options for shared defaults; a native project entry replaces those options. For field-by-field project inheritance, use ultracode.json in the directory where OpenCode runs. You can also set global defaults with bun run install:global --config <options.json> from the Ultra checkout. Save settings while workflows are settled; reload or restart OpenCode to apply them. Saved runs retain their captured settings.", "Configuration", "OpenChamber plugin options or configuration files")
  if (hostVersion) add("Supported OpenCode", hostVersion, "Configuration")
  if (promptVersion) add("Prompt version", promptVersion, "Configuration")
  add("Default model", config.models.default ?? "inherit", "Models")
  for (const [role, model] of Object.entries(config.models.roles ?? {})) add(`Model: ${role}`, model, "Role models")
  for (const [stage, model] of Object.entries(config.models.stages ?? {})) add(`Model: ${stage}`, model, "Stage models")
  for (const [name, limit] of Object.entries(config.limits)) add(limitLabels[name] ?? name, String(limit), "Limits")
  if (!config.checks.length) add("Checks", "No configured or discovered checks. Work without required machine evidence cannot establish verified success.", "Checks", "None")
  for (const check of config.checks) add(`Check: ${check.id}`, json(check), "Checks", check.command)
  add("Automatic-mode threshold", String(config.autoThreshold), "Workflow", "Minimum prompt characters when automatic mode is enabled")
  add("Writer policy", "One writer per project; repair retains the admitted writer scope.", "Workflow", "Single project writer")
  for (const [role, prompt] of Object.entries(config.prompts ?? {})) add(`Prompt: ${role}`, prompt, "Role instructions")
  if (directory) add("Project directory", directory, "Location")
  if (state) add("State database", state, "Location")
  return options
}

export default Plugin.define({
  id: "ultra.open-code",
  setup(ctx) {
    const rpc = ctx.client.rpc(UltraRpc)
    let disposed = false
    const configuration = async (value: unknown) => {
      const settings = configurationOptions(value)
      const options = settings.map(({ detail, ...option }) => option)
      const selected = await ctx.ui.dialog.select({ title: "Ultra configuration", placeholder: "Search settings; select one for details", options })
      const setting = settings.find(option => option.value === selected)
      if (setting && !disposed) await ctx.ui.dialog.alert({ title: setting.title, message: setting.detail })
    }
    const unsubscribe = rpc.events.on("commandResult", async event => {
      if (disposed) return
      const data = event.data as unknown as CommandResult
      const route = ctx.ui.router.current()
      if (route.type !== "session" || route.sessionID !== data.sessionId) return
      if (data.error) { await ctx.ui.dialog.alert({ title: "Ultra command error", message: data.error }); return }
      if (data.command.trim() === "config") await configuration(data.result)
      else await ctx.ui.dialog.alert({ title: "Ultra command result", message: json(data.result) })
    })
    return () => { if (!disposed) { disposed = true; unsubscribe() } }
  },
})
