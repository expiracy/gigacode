import type { Attempt, Run } from "./types.ts"
import { digest } from "./workspace.ts"
import { sanitizeEventData } from "./store.ts"

/** Only the immutable results captured for this attempt are readable through this tool. */
export function dependencyPage(run: Run, attempt: Attempt, taskId: string, offset = 0) {
  const reference = attempt.dependencyResults?.find(item => item.taskId === taskId)
  if (!reference) throw new Error("Result is not a captured dependency of this attempt")
  const source = run.tasks.find(task => task.spec.id === taskId)?.attempts.find(item => item.id === reference.attemptId)
  if (!source?.result || source.resultHash !== reference.resultHash || digest(JSON.stringify(source.result)) !== reference.resultHash) throw new Error("Captured dependency result is unavailable or changed")
  const text = JSON.stringify(sanitizeEventData(source.result))
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) throw new Error("Dependency offset is outside the saved result")
  const end = Math.min(text.length, offset + 6000)
  return { taskId, attemptId: source.id, resultHash: reference.resultHash, offset, totalChars: text.length, chunk: text.slice(offset, end), nextOffset: end < text.length ? end : null }
}
