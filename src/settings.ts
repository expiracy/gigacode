import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { AvailableModel, Config } from "./types.ts"
import { parseConfigOptions, resolveProjectConfig, type ConfigOptions } from "./config.ts"
import { editableSettings, editSettings, type EditableSettings } from "./settings-values.ts"
import { replaceSettingsFile, serializeSettingsWrite } from "./settings-file.ts"
import { assertPlainPath, digest } from "./workspace.ts"
import { projectConfigPath, runtimeDirectory } from "./paths.ts"

export type { EditableSettings } from "./settings-values.ts"

export interface SettingsSnapshot { path: string; revision: string; overrides: EditableSettings; inherited: Config; effective: Config }
export type SettingsScope = "project" | "global"
export interface SettingsModel extends AvailableModel { name: string }
export interface SettingsView extends SettingsSnapshot { models: SettingsModel[]; blocked?: string; scope?: SettingsScope; reloadRequired?: boolean }

export class ProjectSettings {
  constructor(readonly directory: string, private readonly nativeOptions: unknown, private readonly backupDirectory = join(runtimeDirectory(directory), "settings-backups"), private readonly beforeWrite = () => {}) {}
  private async document() {
    const path = projectConfigPath(this.directory)
    assertPlainPath(path)
    let source: string | undefined
    try { source = await readFile(path, "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    let options: ConfigOptions
    try { options = parseConfigOptions(source === undefined ? {} : JSON.parse(source)) }
    catch { throw new Error(`Cannot edit ${path}: correct the invalid project configuration first`) }
    const inherited = await resolveProjectConfig(this.nativeOptions, this.directory)
    const effective = await resolveProjectConfig(this.nativeOptions, this.directory, options)
    return { path, source, options, inherited, effective, revision: digest({ source: source ?? null, inherited }) }
  }
  async read(): Promise<SettingsSnapshot> {
    const { path, revision, options, inherited, effective } = await this.document()
    return { path, revision, overrides: editableSettings(options), inherited, effective }
  }
  save(revision: string, overrides: EditableSettings, models: readonly AvailableModel[], signal?: AbortSignal, replaceAdvanced = false): Promise<SettingsSnapshot & { backup?: string }> {
    return serializeSettingsWrite(join(this.directory, "ultraopencode.json"), async () => {
      signal?.throwIfAborted()
      this.beforeWrite()
      const before = await this.document()
      if (before.revision !== revision) throw new Error("Project settings changed. Reopen the editor before saving.")
      const options = editSettings(before.options, overrides, models, replaceAdvanced)
      if (isDeepStrictEqual(options, before.options)) return this.read()
      const effective = await resolveProjectConfig(this.nativeOptions, this.directory, options)
      const source = JSON.stringify(options, null, 2) + "\n"
      if (source === before.source) return this.read()
      const backup = await replaceSettingsFile({
        path: before.path, previous: before.source, source, backupDirectory: this.backupDirectory,
        temporaryDirectory: join(runtimeDirectory(this.directory), "settings-temp"), signal, beforeWrite: this.beforeWrite,
        assertCurrent: async () => { if ((await this.document()).revision !== revision) throw new Error("Project settings changed. Reopen the editor before saving.") },
      })
      return { path: before.path, revision: digest({ source, inherited: before.inherited }), inherited: before.inherited, effective, overrides: editableSettings(options), ...(backup ? { backup } : {}) }
    })
  }
}
