import { renameSync } from "node:fs"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { AvailableModel, Config } from "./types.ts"
import { modelRef, parseConfigOptions, resolveProjectConfig, strictRecord, type ConfigOptions } from "./config.ts"
import { assertPlainPath, digest } from "./workspace.ts"

export type EditableSettings = Pick<ConfigOptions, "models" | "limits" | "checks">
export interface SettingsSnapshot { path: string; revision: string; overrides: EditableSettings; inherited: Config; effective: Config }
export interface SettingsModel extends AvailableModel { name: string }
export interface SettingsView extends SettingsSnapshot { models: SettingsModel[]; blocked?: string }

export class ProjectSettings {
  private writing: Promise<unknown> = Promise.resolve()
  constructor(readonly directory: string, private readonly nativeOptions: unknown, private readonly backupDirectory = join(directory, ".ultracode", "settings-backups"), private readonly beforeWrite = () => {}) {}
  private async document() {
    const path = join(this.directory, "ultracode.json")
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
    const overrides: EditableSettings = {}
    for (const key of ["models", "limits", "checks"] as const) if (options[key] !== undefined) Object.assign(overrides, { [key]: options[key] })
    return { path, revision, overrides, inherited, effective }
  }
  save(revision: string, overrides: EditableSettings, models: readonly AvailableModel[], signal?: AbortSignal): Promise<SettingsSnapshot & { backup?: string }> {
    const work = this.writing.then(async () => {
      signal?.throwIfAborted()
      this.beforeWrite()
      const before = await this.document()
      if (before.revision !== revision) throw new Error("Project settings changed. Reopen the editor before saving.")
      const edited = parseConfigOptions(strictRecord(overrides, ["models", "limits", "checks"], "editable settings"))
      const references = (value: ConfigOptions) => new Map(Object.entries({ default: value.models?.default, ...Object.fromEntries(Object.entries(value.models?.roles ?? {}).map(([key, ref]) => [`roles.${key}`, ref])), ...Object.fromEntries(Object.entries(value.models?.stages ?? {}).map(([key, ref]) => [`stages.${key}`, ref])) }))
      const previous = references(before.options)
      for (const [key, reference] of references(edited)) {
        if (!reference || reference === "inherit" || previous.get(key) === reference) continue
        const ref = modelRef(reference), model = models.find(model => model.providerID === ref.providerID && model.id === ref.id)
        if (!model || model.tools === false) throw new Error(`Model ${reference} is not available with tool support; no fallback was selected`)
        if (ref.variant && !model.variants.includes(ref.variant)) throw new Error(`Variant ${ref.variant} is not available for ${ref.providerID}/${ref.id}`)
      }
      const options = { ...before.options }
      for (const key of ["models", "limits", "checks"] as const) delete options[key]
      Object.assign(options, edited)
      if (isDeepStrictEqual(options, before.options)) return this.read()
      const effective = await resolveProjectConfig(this.nativeOptions, this.directory, options)
      const source = JSON.stringify(options, null, 2) + "\n"
      if (source === before.source) return this.read()
      let backup: string | undefined
      if (before.source !== undefined) {
        assertPlainPath(this.backupDirectory)
        await mkdir(this.backupDirectory, { recursive: true })
        backup = join(this.backupDirectory, `${Date.now()}-${crypto.randomUUID()}.json`)
        await writeFile(backup, before.source, { flag: "wx", mode: 0o600 })
      }
      const temporaryDirectory = join(this.directory, ".ultracode", "settings-temp")
      assertPlainPath(temporaryDirectory)
      await mkdir(temporaryDirectory, { recursive: true })
      const temporary = join(temporaryDirectory, `${crypto.randomUUID()}.json`)
      await writeFile(temporary, source, { flag: "wx", mode: 0o600 })
      try {
        const current = await this.document()
        if (current.revision !== revision) throw new Error("Project settings changed. Reopen the editor before saving.")
        // No asynchronous gap between the final workflow guard and atomic replacement.
        signal?.throwIfAborted()
        this.beforeWrite()
        assertPlainPath(before.path)
        renameSync(temporary, before.path)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      return { path: before.path, revision: digest({ source, inherited: before.inherited }), inherited: before.inherited, effective, overrides: edited, ...(backup ? { backup } : {}) }
    })
    this.writing = work.then(() => {}, () => {})
    return work
  }
}
