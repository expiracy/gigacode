import type { ModelLimits } from "./types.ts"

/**
 * Estimate a conservative UTF-8 byte allowance for GigaCode's initial text from native token capacities.
 * Reserve output and half the usable input for host system text, schemas, and history; this is not a tokenizer
 * measurement or a hard guarantee that the complete native context fits. Missing metadata keeps the legacy cap.
 */
export function modelInputBudget(limit?: ModelLimits): number | undefined {
  if (limit === undefined) return undefined
  const output = Math.min(limit.output > 0 ? limit.output : 2_048, 2_048, Math.floor(limit.context / 4))
  const usable = Math.min(limit.input ?? limit.context, limit.context - output)
  return Math.floor(usable / 2)
}
