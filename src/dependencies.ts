import type { Attempt, Run } from "./types.ts"
import { digest } from "./workspace.ts"
import { sanitizeEventData } from "./store.ts"
import { modelInputBudget } from "./context.ts"

/** Only the immutable results captured for this attempt are readable through this tool. */
export function dependencyPage(run: Run, attempt: Attempt, taskId: string, offset = 0) {
  const reference = attempt.dependencyResults?.find(item => item.taskId === taskId)
  if (!reference) throw new Error("Result is not a captured dependency of this attempt")
  const source = run.tasks.find(task => task.spec.id === taskId)?.attempts.find(item => item.id === reference.attemptId)
  if (!source?.result || source.resultHash !== reference.resultHash || digest(JSON.stringify(source.result)) !== reference.resultHash) throw new Error("Captured dependency result is unavailable or changed")
  const text = JSON.stringify(sanitizeEventData(source.result))
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) throw new Error("Dependency offset is outside the saved result")
  const page = (end: number) => ({ taskId, attemptId: source.id, resultHash: reference.resultHash, offset, totalChars: text.length, chunk: text.slice(offset, end), nextOffset: end < text.length ? end : null })
  const ceiling = Math.min(text.length, offset + 6000)
  const modelBudget = modelInputBudget(attempt.model?.limit)
  if (modelBudget === undefined) return page(ceiling)
  const budget = Math.min(12_000, modelBudget)
  const boundary = (end: number) => {
    const previous = text.charCodeAt(end - 1), next = text.charCodeAt(end)
    return end > offset && previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end
  }
  const fits = (end: number) => Buffer.byteLength(JSON.stringify(page(end)), "utf8") <= budget
  let end = boundary(ceiling)
  if (!fits(end)) {
    let lower = offset, upper = end
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2)
      if (fits(boundary(middle))) lower = middle
      else upper = middle - 1
    }
    end = boundary(lower)
  }
  if (end <= offset) throw new Error("Model input budget cannot hold dependency page metadata and one complete character")
  return page(end)
}
