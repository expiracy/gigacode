import type { Context } from "@opencode/plugin/tui/context"

export function showToast(ctx: Context, options: Parameters<Context["ui"]["toast"]["show"]>[0]): void {
  try { ctx.ui.toast.show(options) }
  catch { /* Notification delivery must not fail or repeat the user's operation. */ }
}
