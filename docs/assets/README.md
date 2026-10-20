# Product image provenance

These images show GigaCode's actual native OpenCode terminal dialogs. They were captured on 20 October 2026 from source commit `46a4cd484159e204cd7371653e8be9fadad5f467`, using GigaCode `0.1.0-beta.1`, OpenCode `2.0.28`, and Bun `1.3.14` on macOS arm64.

The capture used a new temporary project, Git repository, HOME, OpenCode profile, database, and provider configuration. A loopback provider used the repository's `createWorkflowFixture` helper and returned scripted tool calls. Each capture used five fixture requests and reached `planning · ready` with proposal revision 2. The workflow image uses the objective “Plan upload retries”; the settings image came from the earlier isolated “Add resumable uploads to this API” example. This illustrates the interface and does not evaluate model quality or establish that upload code was implemented.

- `workflows.png` shows `/gigacode status`, including the saved proposal, worker status, and accepted result.
- `settings.png` shows `/gigacode config` → **This project**, with the model, limit, check, and advanced configuration sections. No setting was saved.

The OpenCode client ran in a fresh 120 × 44 PTY. Its emitted terminal stream was decoded with pexpect `4.9.0` and pyte `0.8.2`, then the actual modal cells were rendered to PNG with Pillow `11.3.0` and Menlo. Characters, colours, selection highlighting, and native text truncation come from that cell buffer. The crop removes the surrounding example conversation and temporary project path; no interface text or controls were invented, rearranged, or retouched.

No existing user profile, provider credentials, personal conversation, desktop capture, or paid model was used. The temporary terminal, native server, and fixture provider were stopped after capture. These screenshots replace no private historical `.spike` images.

SHA-256:

```text
f7f75a9e75aa5193dd1e333060cc445880401ab62613107855d76f53a78a0a59  workflows.png
737b73f326e93e2d22ffbe6e3fd8feea8f9dbb7b5230f68e65585b751a185082  settings.png
```

The images are distributed under the repository's MIT licence. README image URLs use a public GitHub revision so npm can load them without a source checkout.
