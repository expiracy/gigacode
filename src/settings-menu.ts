import type { Context } from "@opencode/plugin/tui/context"
import type { Config } from "./types.ts"
import { editSettings, type SettingsRpc } from "./settings-ui.ts"
import { showSettingsHelp, showAbout } from "./settings-help-ui.ts"

interface Configuration { config: Config; hostVersion?: string; promptVersion?: string; directory?: string; state?: string }

/** One entry point: choose the scope, then use its editable sections. */
export async function openSettingsMenu(ctx: Context, value: unknown, sessionId: string, rpc: SettingsRpc, current: () => boolean, signal: AbortSignal): Promise<void> {
  const active = () => !signal.aborted && current()
  if (!value || typeof value !== "object" || !("config" in value)) throw new Error("Ultra returned no effective configuration. Check the installation and restart OpenCode.")
  const configuration = value as Configuration
  let selection: string | undefined
  while (active()) {
    const selected = await ctx.ui.dialog.select({ title: "Ultra settings", placeholder: "Choose a scope, Help or About", current: selection, options: [
      { title: "This project", value: "Configuration/Edit project settings", description: configuration.directory ? `${configuration.directory} · overrides global defaults` : "Override global defaults for this project" },
      { title: "Global defaults", value: "Configuration/Edit global defaults", description: "All projects using this profile; project overrides still apply" },
      { title: "Help", value: "help", description: "Guides to settings and workflows" },
      { title: "About Ultra", value: "about", description: "Versions and runtime locations" },
    ] })
    if (!active() || !selected) return
    selection = selected
    if (selected === "help") { await showSettingsHelp(ctx, active); continue }
    if (selected === "about") { await showAbout(ctx, configuration); continue }
    if (selected !== "Configuration/Edit project settings" && selected !== "Configuration/Edit global defaults") return
    const editor = new AbortController()
    let result: "back" | void
    try {
      result = await editSettings(ctx, sessionId, rpc, active, AbortSignal.any([signal, editor.signal]), selected === "Configuration/Edit global defaults" ? "global" : "project")
    } finally { editor.abort() }
    if (result !== "back") return
  }
}
