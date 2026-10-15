import type { Context } from "@opencode/plugin/tui/context"

const guides = [
  {
    title: "Scopes & inheritance", value: "scopes", description: "Where changes apply and how defaults combine",
    message: "This project\nOverrides global defaults for the current project. Project overrides take precedence over global defaults.\n\nGlobal defaults\nApplies to all projects using this OpenCode profile. Projects can still override individual values. Unset global values use UltraOpenCode's built-in defaults.\n\nReset a value to remove its override and use the inherited value. Changing scope never copies a draft to the other scope.",
  },
  {
    title: "Editing & saving", value: "saving", description: "Edit, reset, review and apply a draft",
    message: "Choose a scope, then Models, Limits, Checks or Advanced configuration. Select a value to edit it. Deadlines use seconds; context budgets use characters. In Limits, Ctrl+R restores the inherited or built-in value.\n\nChanges stay in a draft. Review changes shows what will change; Save asks for confirmation before writing. Leaving an edited draft asks whether to discard it. Back or Escape returns one menu level and preserves your place.\n\nProject saves apply to new workflows immediately. Reload OpenCode after saving global defaults. Existing runs keep their captured settings. Saving is blocked while workflows are active; finish or cancel them, then use Recheck save availability to keep editing the same draft.",
  },
  {
    title: "Advanced controls", value: "advanced", description: "Role instructions, writer policy and automatic mode",
    message: "Role instructions\nAdd multiline guidance to a role's built-in instructions. Submit blank text, or use Ctrl+R on the role, to restore inherited or built-in guidance.\n\nWriter policy\nChoose serial writers or isolated parallel writers. Parallel writing requires a clean committed Git root and native Git permissions.\n\nAutomatic-mode threshold\nMinimum prompt length in characters after /ultraopencode on enables automatic mode for the conversation. Changing the threshold does not enable that mode or change UltraOpenCode mode. Enter inherit (project) or default (global) to reset it.\n\nAll advanced edits join the same scoped draft and confirmed save.",
  },
  {
    title: "Workflow commands", value: "workflows", description: "Start, inspect and control a workflow",
    message: "Start work\n/ultraopencode start <task> — design and execute\n/ultraopencode plan <task> — discover and save a proposal\n/ultraopencode run <id>@<revision> — execute a saved proposal\n\nFollow progress\n/ultraopencode status [id] — tasks, agents and evidence\n/ultraopencode inspect <id> [task-id] — saved details\n\nControl a run\n/ultraopencode pause <id> — drain active work\n/ultraopencode resume <id> — reconcile and continue\n/ultraopencode cancel <id> — interrupt and retain history\n\nIssue controls from the run's initiating conversation and project. Settings and help make no model calls; starting or continuing a workflow uses models.",
  },
]

export async function showSettingsHelp(ctx: Context, active: () => boolean) {
  let current: string | undefined
  while (active()) {
    const selected = await ctx.ui.dialog.select({ title: "UltraOpenCode help", placeholder: "Choose a guide", current, options: [
      ...guides.map(({ message, ...option }) => option),
      { title: "Back to UltraOpenCode settings", value: "back", category: "Navigation" },
    ] })
    if (!active() || !selected || selected === "back") return
    const guide = guides.find(guide => guide.value === selected)
    if (!guide) return
    current = selected
    await ctx.ui.dialog.alert({ title: guide.title, message: guide.message })
  }
}

export async function showAbout(ctx: Context, value: { hostVersion?: string; promptVersion?: string; directory?: string; state?: string }) {
  await ctx.ui.dialog.alert({ title: "About UltraOpenCode", message: `UltraOpenCode runs durable, multi-agent coding workflows in OpenCode.\n\nVersions\nOpenCode: ${value.hostVersion ?? "Unknown"}\nPrompt version: ${value.promptVersion ?? "Unknown"}\n\nRuntime locations\nProject directory: ${value.directory ?? "Unknown"}\nState database: ${value.state ?? "Unknown"}` })
}
