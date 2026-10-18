import { join } from "node:path"

export function projectConfigPath(directory: string): string {
  return join(directory, "gigacode.json")
}

export const runtimeName = ".gigacode"

export function runtimeDirectory(directory: string): string {
  return join(directory, runtimeName)
}
