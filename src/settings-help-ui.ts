import type { Context } from "@opencode/plugin/tui/context"

const guides = [
  {
    title: "Scopes & inheritance", value: "scopes", description: "Where changes apply and how defaults combine",
    message: "This project\nOverrides global defaults for the current project. Project overrides take precedence over global defaults.\n\nGlobal defaults\nApplies to all projects using this OpenCode profile. Projects can still override individual values. Unset global values use Ultra's built-in defaults.\n\nReset a value to remove its override and use the inherited value. Changing scope never copies a draft to the other scope.",
  },
  {
    title: "Editing & saving", value: "saving", description: "Edit, reset, review and apply a draft",
    message: "Choose a scope, then Models, Limits, Checks or Advanced configuration. Select a value to edit it. Deadlines use seconds; context budgets use characters. In Limits, Ctrl+R restores the inherited or built-in value.\n\nChanges stay in a draft. Review changes shows what will change; Save asks for confirmation before writing. Leaving an edited draft asks whether to discard it. Escape returns one level.\n\nProject saves apply to new workflows immediately. Reload OpenCode after saving global defaults. Existing runs keep their captured settings. Saving is blocked while workflows are active; finish or stop them before saving.",
  },
  {
    title: "Advanced controls", value: "advanced", description: "Role instructions, writer policy and automatic mode",
    message: "Role instructions\nAdd multiline guidance to a role's built-in instructions. Submit blank text, or use Ctrl+R on the role, to restore inherited or built-in guidance.\n\nWriter policy\nChoose serial writers or isolated parallel writers. Parallel writing requires a clean committed Git root and native Git permissions.\n\nAutomatic-mode threshold\nMinimum prompt length in characters after /ultracode on enables automatic mode for the conversation. Changing the threshold does not enable that mode or change Ultra mode. Enter inherit (project) or default (global) to reset it.\n\nAll advanced edits join the same scoped draft and confirmed save.",
  },
  {
    title: "Workflow commands", value: "workflows", description: "Start, inspect and control a workflow",
    message: "Start work\n/ultracode start <task> — design and execute\n/ultracode plan <task> — discover and save a proposal\n/ultracode run <id>@<revision> — execute a saved proposal\n\nFollow progress\n/ultracode status [id] — tasks, agents and evidence\n/ultracode inspect <id> [task-id] — saved details\n\nControl a run\n/ultracode pause <id> — drain active work\n/ultracode resume <id> — reconcile and continue\n/ultracode cancel <id> — interrupt and retain history\n\nIssue controls from the run's initiating conversation and project. Settings and help make no model calls; starting or continuing a workflow uses models.",
  },
]

export async function showSettingsHelp(ctx: Context, active: () => boolean) {
  let current: string | undefined
  while (active()) {
    const selected = await ctx.ui.dialog.select({ title: "Ultra help", placeholder: "Choose a guide", current, options: [
      ...guides.map(({ message, ...option }) => option),
      { title: "Back to settings", value: "back" },
    ] })
    if (!active() || !selected || selected === "back") return
    const guide = guides.find(guide => guide.value === selected)
    if (!guide) return
    current = selected
    await ctx.ui.dialog.alert({ title: guide.title, message: guide.message })
  }
}

export async function showAbout(ctx: Context, value: { hostVersion?: string; promptVersion?: string; directory?: string; state?: string }) {
  await ctx.ui.dialog.alert({ title: "About Ultra", message: `Ultra runs durable, multi-agent coding workflows in OpenCode.\n\nVersions\nOpenCode: ${value.hostVersion ?? "Unknown"}\nPrompt version: ${value.promptVersion ?? "Unknown"}\n\nRuntime locations\nProject directory: ${value.directory ?? "Unknown"}\nState database: ${value.state ?? "Unknown"}` })
}
