# Installation, updates, and removal

[Back to README](../README.md) · [Configuration](configuration.md) · [Workflow commands](commands.md)

GigaCode requires Bun 1.3.10 or newer at runtime and accepts only OpenCode 2.0.25, 2.0.26, or 2.0.28. Setup checks the selected host; the plugin checks the live host again when loaded. A connected model with tool support is required for workflows. Git is optional unless you enable isolated parallel writers.

## Install the prerelease

With Bun available on your `PATH`, install the published prerelease channel and explicitly register it with OpenCode:

```sh
npm install --global opencode-gigacode@next
gigacode setup --global
```

Check the [npm listing](https://www.npmjs.com/package/opencode-gigacode) for the current published version. To pin one published release, replace `@next` with `@<version>`. Bun is required at runtime regardless of the installer.

Restart OpenCode and select **GigaCode**. `gigacode help` confirms that the global executable is available. If your shell cannot find it, check that your package manager's global binary directory is on `PATH`.

Setup is explicit. Installing the package alone does not change your OpenCode configuration. Setup registers the installed package's absolute path, so it remains available without a source checkout. Keep the global package installed while registered. Avoid transient `npx` or `bunx` setup commands: their temporary package paths are not durable registrations. For direct source setup and unpublished candidate rehearsals, see [working from source](development.md#working-from-source).

Bun is also supported as the installer: use `bun add --global opencode-gigacode@next`, then the same `gigacode setup --global` command. If using Bun's global installation, `bun pm bin --global` prints the binary directory to add to `PATH`. Keep one package manager responsible for installation, updates, and removal.

### Install a local candidate

A verified local tarball can be installed before registry publication. For example, the `0.1.0-beta.1` candidate uses:

```sh
npm install --global /absolute/path/to/opencode-gigacode-0.1.0-beta.1.tgz
gigacode setup --global
```

Use the actual path and version of the artifact you verified. This command installs local bytes; it does not establish that the candidate is published. Use an isolated profile for release rehearsals and consult [release preparation](development.md#release-checklist) for the candidate's recorded status.

## Select a profile and host

Global setup is the default, so `gigacode setup` and `gigacode setup --global` are equivalent. The global directory is `OPENCODE_CONFIG_DIR` when set, otherwise `XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when XDG is unset. These paths also apply to the supported OpenCode versions on Windows.

To select another global directory:

```sh
gigacode setup --global --config-dir /absolute/path/to/opencode-profile
```

OpenCode must use the same directory through `OPENCODE_CONFIG_DIR`. Check the configuration path printed by setup, especially if a client selects a custom profile or `OPENCODE_CONFIG` file.

For a standalone project registration:

```sh
gigacode setup --project /absolute/path/to/project
```

`gigacode setup --local` selects the current directory. A global installation normally needs only the project's optional `gigacode.json`, without project setup. A project plugin registration replaces that same plugin's global options under OpenCode's rules. For field-by-field inheritance, move its options into `gigacode.json`, then remove only its GigaCode entry from the project's `plugins` array. Different references for one plugin can create duplicate IDs; retain a single registration per intended scope.

If using only an OpenChamber-bundled executable, explicitly select the real file before setup. This PowerShell path is a placeholder:

```powershell
$env:OPENCODE_BIN = "C:\path\to\OpenChamber\resources\opencode-cli\opencode.exe"
gigacode setup --global
```

Setup recognises official CLI and matching native package manifests. For a bare executable on `PATH` or selected through `OPENCODE_BIN`, it checks `--version` in a temporary isolated profile. An invalid explicit selection fails instead of selecting another installed CLI.

## What setup changes

Setup updates the target `opencode.json` or `opencode.jsonc`, registers the plugin, adds `gigacode`, `gigacode-supervisor`, and `gigacode-worker` agents, and sets native delegation depth to at least two. It preserves unrelated providers, models, and permission rules, and saves the original configuration when changed. JSONC is rewritten as formatted JSON; its backup retains comments. Repeating an unchanged setup creates no extra registrations or backups.

You can persist shared options during setup:

```sh
gigacode setup --global --config /absolute/path/to/gigacode-options.json
```

Use [configuration](configuration.md) for option fields and project overrides. Restart OpenCode after setup or package updates so both the plugin and terminal companion reload.

GigaCode requires fresh settings. Settle active workflows from any previous product, then remove that product's plugin registration and agent definitions before loading GigaCode. Create GigaCode settings and permission rules explicitly. GigaCode uses only its current package/agent/tool identifiers, `gigacode.json`, and `.gigacode/`; it does not import previous products' settings, permissions, prompts, or run history. Previous configuration files and runtime directories are left untouched.

## Update

Settle active workflows, install the intended published prerelease with `npm install --global opencode-gigacode@next` or pin a published version with `npm install --global opencode-gigacode@<version>`. Then rerun `gigacode setup --global` against the same profile and restart OpenCode. Repeat setup for any standalone project registrations. Review compatibility before upgrading OpenCode: versions outside the exact allowlist are rejected.

For a local candidate, install its verified tarball instead. For a Bun-managed installation, use `bun add --global` with the published version or tarball. Old saved runs keep their captured settings; configuration changes can invalidate saved proposal fingerprints. The release checks rehearse same-version package replacement; they do not establish compatibility for every future version-to-version upgrade.

## Remove

There is no automated uninstall command. Settle or cancel active workflows, then back up each affected native configuration before editing it:

1. Remove only the GigaCode entry from `plugins`, identified by the installed package path.
2. Remove only the `gigacode`, `gigacode-supervisor`, and `gigacode-worker` agent definitions added by setup. Compare with the setup backup if you customised them.
3. Preserve other plugins, providers, models, permissions, and shared delegation settings. Do not restore an old whole-file backup over newer unrelated edits.
4. Restart OpenCode, then remove the package:

   ```sh
   npm uninstall --global opencode-gigacode
   ```

For a Bun-managed installation, use `bun remove --global opencode-gigacode` instead. Remove registrations from standalone project profiles too before removing the shared package. Project `gigacode.json`, `.gigacode/` state, exports, and setup backups remain available; archive or remove them separately if desired.

## Troubleshooting

Start with the installed CLI's local diagnostic report:

```sh
gigacode doctor
gigacode doctor --json --project /absolute/path/to/project --global-config /absolute/path/to/opencode-profile
```

`doctor` checks package and Bun versions, the selected OpenCode host, native profile registrations, GigaCode agents and delegation depth, and configuration syntax. It makes no model or network calls, does not change configuration or project runtime state, and excludes provider, model, and option values from its report. An explicitly selected host's version probe may use a disposable isolated profile.

The default output is a human-readable checklist; `--json` returns a structured report. Failed checks produce exit status 1; warnings and explicitly unverified checks can still return 0. Live model availability and native permissions remain unverified. Offline inspection cannot fully reproduce OpenCode's ancestor/include discovery; a custom `OPENCODE_CONFIG` file is labelled alongside the setup directory. Confirm the client actually uses the reported profile.

- **Unsupported host:** use one of the three exact supported releases. If using a bundled host, set `OPENCODE_BIN` to that executable and rerun setup.
- **GigaCode is absent:** check the setup output's profile path and its `plugins` entry, then restart the client. In OpenChamber, refresh **Settings → Plugins** and select an explicit connected model if **Auto** hides the agent picker.
- **Duplicate plugin or ambiguous registration:** retain one GigaCode entry in the intended scope and put partial project overrides in `gigacode.json`.
- **No terminal command feedback in OpenChamber:** OpenChamber 2.2.0 does not display deterministic command results. Use GigaCode's conversational entry point or the supported OpenCode terminal; see [client limitations](configuration.md#openchamber-settings).
- **Work is paused or a result is unknown:** inspect the existing run before resuming it. Recovery reconciles saved native sessions; starting another workflow does not resolve an uncertain previous launch.
