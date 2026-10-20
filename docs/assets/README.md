# Product image provenance

These images show GigaCode in the actual native OpenCode application. They were captured on 20 October 2026 from source commit `65376d7baf7143b6abd6381ace4c3caa2cc5e7f2`, using GigaCode `0.1.0-beta.1`, OpenCode `2.0.28`, and Bun `1.3.14` on macOS arm64.

The capture used a new temporary project, Git repository, HOME, OpenCode profile, database, and provider configuration. A loopback provider used the repository's `createWorkflowFixture` helper and returned scripted tool calls. Eight local fixture requests produced a saved proposal for “Plan upload retries” and a scripted explanation of how to inspect it. The workflow reached `planning · ready` with proposal revision 2. This illustrates the interface and does not evaluate model quality or establish that upload code was implemented.

The initiating native session was created with the real `gigacode` primary agent. The SDK's session record was checked to confirm `agent === "gigacode"`; the native **Gigacode** selection remains visible in the mode bar of every image. OpenCode 2.0.28 has no `--agent` CLI flag, so the client attached to this verified session rather than using an unsupported launch option.

- `workspace.png` shows the normal session page with GigaCode selected and the example proposal conversation.
- `workflows.png` shows `/gigacode status` over the same full application, including the saved proposal, worker status, and available actions.
- `settings.png` shows `/gigacode config` → **This project**, with the application visible behind the settings popup. No setting was saved.

The OpenCode client ran in a fresh 100 × 38 PTY. Its emitted terminal stream was decoded with pexpect `4.9.0` and pyte `0.8.2`, then every viewport cell was rendered to a 1100 × 912 PNG with Pillow `11.3.0` and Menlo. Characters, colours, dimmed backgrounds, selection highlighting, and native text truncation come from that cell buffer. These are full application frames: no modal crop, invented interface, rearranged controls, or retouched text was used.

No existing user profile, provider credentials, personal conversation, desktop capture, or paid model was used. The visible project path belongs only to the disposable example. Expected workflow and settings dialog titles were checked before capture; all three rendered images were visually inspected. The temporary terminal, native server, and fixture provider were stopped after capture. These screenshots do not reuse private historical `.spike` images.

SHA-256:

```text
f3024ca52db9afb875d326d95408f86fe219aa39d3964aac508ec33b98f2f8f4  workspace.png
0f1aecbabc732ff038805f08def9be7c2afa8f19fc8046e7db74dc6450932e68  workflows.png
474cc382df2f7d8457bed3f04f57ac2bf7e58a03a4c635dffcc8a3dcf5dd91f1  settings.png
```

The images are distributed under the repository's MIT licence. README image URLs use a public GitHub revision so npm can load them without a source checkout.

## Logo assets

`logo-dark.svg` and `logo-light.svg` preserve the supplied GigaCode wordmark. `logo.svg` uses the dark variant with its original paths and palette, an accessible title, 18 px padding and a fixed dark background so the README header is readable on both light and dark pages. No external fonts, scripts or resources are used.
