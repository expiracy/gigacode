import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, visit } from "jsonc-parser"
import { parseConfig, parseConfigOptions, roles } from "./config.ts"
import { packageMatches, parseNativeConfiguration } from "./native-config.ts"
import { assertPlainPath, digest } from "./workspace.ts"
import type { EditableSettings, SettingsSnapshot } from "./settings.ts"
import type { AvailableModel } from "./types.ts"
import { editableKeys, editableSettings, editSettings } from "./settings-values.ts"
import { replaceSettingsFile, serializeSettingsWrite } from "./settings-file.ts"

function assertUniqueKeys(source: string) {
  const objects: Set<string>[] = []
  visit(source, {
    onObjectBegin: () => { objects.push(new Set()) },
    onObjectProperty: key => {
      const keys = objects.at(-1)!
      if (keys.has(key)) throw new Error("Duplicate configuration properties exist. Remove them before editing global defaults.")
      keys.add(key)
    },
    onObjectEnd: () => { objects.pop() },
  }, { allowTrailingComma: true })
}

export class GlobalSettings {
  constructor(private readonly target: { configDirectory: string; packagePath: string; path?: string }, private readonly beforeWrite = () => {}) {}
  private async document() {
    const paths = this.target.path ? [this.target.path] : ["opencode.json", "opencode.jsonc"].map(name => join(this.target.configDirectory, name)).filter(existsSync)
    if (paths.length !== 1) throw new Error("Select a single native global configuration file before editing global defaults.")
    const path = paths[0]!
    assertPlainPath(path)
    const source = await readFile(path, "utf8")
    let native: Record<string, any>
    try { native = parseNativeConfiguration(source) }
    catch { throw new Error("Correct the invalid global OpenCode configuration before editing defaults.") }
    assertUniqueKeys(source)
    if (!Array.isArray(native.plugins)) throw new Error("UltraOpenCode is not registered in this global profile. Install it globally before editing defaults.")
    const matches = native.plugins.map((entry, index) => {
      const name = typeof entry === "string" ? entry : entry?.package
      return typeof name === "string" && packageMatches(name, this.target.packagePath, dirname(path)) ? index : -1
    }).filter(index => index !== -1)
    if (matches.length !== 1) throw new Error(matches.length ? "Multiple UltraOpenCode registrations exist in this global profile. Retain one before editing defaults." : "UltraOpenCode is not registered in this global profile. Install it globally before editing defaults.")
    const index = matches[0]!, entry = native.plugins[index]
    const options = parseConfigOptions(typeof entry === "string" ? {} : entry.options)
    return { path, source, native, index, options, revision: digest({ path, source }) }
  }
  async read(): Promise<SettingsSnapshot> {
    const { path, revision, options } = await this.document()
    return { path, revision, overrides: editableSettings(options), inherited: parseConfig({}), effective: parseConfig(options) }
  }
  async save(revision: string, overrides: EditableSettings, models: readonly AvailableModel[], signal?: AbortSignal, replaceAdvanced = false): Promise<SettingsSnapshot & { backup?: string }> {
    const initial = await this.document()
    return serializeSettingsWrite(initial.path, async () => {
      signal?.throwIfAborted()
      this.beforeWrite()
      const before = await this.document()
      if (before.revision !== revision) throw new Error("Global defaults changed. Reopen the editor before saving.")
      const options = editSettings(before.options, overrides, models, replaceAdvanced)
      if (isDeepStrictEqual(options, before.options)) return this.read()
      const entry = before.native.plugins[before.index]
      let source = before.source
      const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" }
      const set = (path: (string | number)[], value: unknown) => { source = applyEdits(source, modify(source, path, value, { formattingOptions })) }
      if (typeof entry === "string") set(["plugins", before.index], { package: entry, options })
      else if (entry.options === undefined) set(["plugins", before.index, "options"], options)
      else for (const key of editableKeys) {
        if (isDeepStrictEqual(before.options[key], options[key])) continue
        if (key === "prompts" && before.options.prompts && options.prompts) {
          for (const role of roles) {
            if (before.options.prompts[role] !== options.prompts[role]) set(["plugins", before.index, "options", key, role], options.prompts[role])
          }
        } else set(["plugins", before.index, "options", key], options[key])
      }
      const backup = await replaceSettingsFile({
        path: before.path, previous: before.source, source,
        backupDirectory: join(dirname(before.path), ".ultraopencode", "settings-backups"),
        temporaryDirectory: join(dirname(before.path), ".ultraopencode", "settings-temp"),
        signal, beforeWrite: this.beforeWrite,
        assertCurrent: async () => { if ((await this.document()).revision !== revision) throw new Error("Global defaults changed. Reopen the editor before saving.") },
      })
      return { path: before.path, revision: digest({ path: before.path, source }), inherited: parseConfig({}), effective: parseConfig(options), overrides: editableSettings(options), ...(backup ? { backup } : {}) }
    })
  }
}
