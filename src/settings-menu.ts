import type { Context } from "@opencode/plugin/tui/context"
import type { Config } from "./types.ts"
import { editSettings, type SettingsRpc } from "./settings-ui.ts"

interface Configuration { config: Config; hostVersion?: string; promptVersion?: string; directory?: string; state?: string }

async function help(ctx: Context, value: Configuration, active: () => boolean) {
  while (active()) {
    const selected = await ctx.ui.dialog.select({ title: "Help & about", placeholder: "Guidance and diagnostics", options: [
      { title: "Using settings", value: "usage", description: "Scopes, inheritance, reset and saving" },
      { title: "About Ultra", value: "about", description: "Versions, project directory and runtime state" },
      { title: "Back to settings", value: "back" },
    ] })
    if (!active() || !selected || selected === "back") return
    if (selected === "usage") await ctx.ui.dialog.alert({ title: "Using settings", message: "Choose This project or Global defaults, then Models, Limits or Checks. Select a value to edit it. Project overrides take precedence over global defaults. In Limits, Ctrl+R restores the inherited or built-in value; deadlines use seconds. Changes stay in a draft until Save and confirmation. Change scope or close the editor only after saving or explicitly discarding changes. Project saves apply to new workflows immediately; global saves require an OpenCode reload." })
    else if (selected === "about") await ctx.ui.dialog.alert({ title: "About Ultra", message: `OpenCode: ${value.hostVersion ?? "Unknown"}\nPrompt version: ${value.promptVersion ?? "Unknown"}\nProject directory: ${value.directory ?? "Unknown"}\nState database: ${value.state ?? "Unknown"}` })
    else return
  }
}

/** One entry point: choose the scope, then use its editable sections. */
export async function openSettingsMenu(ctx: Context, value: unknown, sessionId: string, rpc: SettingsRpc, current: () => boolean, signal: AbortSignal): Promise<void> {
  const active = () => !signal.aborted && current()
  if (!value || typeof value !== "object" || !("config" in value)) throw new Error("Ultra returned no effective configuration. Check the installation and restart OpenCode.")
  const configuration = value as Configuration
  while (active()) {
    const selected = await ctx.ui.dialog.select({ title: "Ultra settings", placeholder: "Choose where changes apply", options: [
      { title: "This project", value: "Configuration/Edit project settings", description: configuration.directory ? `${configuration.directory} · overrides global defaults` : "Override global defaults for this project" },
      { title: "Global defaults", value: "Configuration/Edit global defaults", description: "All projects using this profile; project overrides still apply" },
      { title: "Help & about", value: "help", description: "Guidance, versions and diagnostics" },
    ] })
    if (!active() || !selected) return
    if (selected === "help") { await help(ctx, configuration, active); continue }
    if (selected !== "Configuration/Edit project settings" && selected !== "Configuration/Edit global defaults") return
    const editor = new AbortController()
    let result: "back" | void
    try {
      result = await editSettings(ctx, sessionId, rpc, active, AbortSignal.any([signal, editor.signal]), selected === "Configuration/Edit global defaults" ? "global" : "project")
    } finally { editor.abort() }
    if (result !== "back") return
  }
}
