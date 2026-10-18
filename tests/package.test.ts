import { expect, test } from "bun:test"
import { assertPackageContents, packageCommand } from "../scripts/check-package.ts"

const runtimeFiles = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "index.ts", "tui.ts", "scripts/cli.ts", "scripts/install.ts", "scripts/doctor.ts", "src/plugin.ts", "src/config.ts"]

test("the npm artifact rejects saved project state", () => {
  expect(() => assertPackageContents([...runtimeFiles, ".gigacode/state.sqlite"])).toThrow("Unexpected packaged file: .gigacode/state.sqlite")
})

test("the npm artifact must include both host entrypoints and the installed CLI", () => {
  expect(() => assertPackageContents(runtimeFiles.filter(path => path !== "tui.ts"))).toThrow("Missing packaged file: tui.ts")
})

test("the npm artifact includes its diagnostic CLI and release notes", () => {
  expect(() => assertPackageContents(runtimeFiles)).not.toThrow()
})

test("the npm artifact must contain the installed doctor's implementation", () => {
  expect(() => assertPackageContents(runtimeFiles.filter(path => path !== "scripts/doctor.ts"))).toThrow("Missing packaged file: scripts/doctor.ts")
})

test("the release artifact must include its licence", () => {
  expect(() => assertPackageContents(runtimeFiles.filter(path => path !== "LICENSE"))).toThrow("Missing packaged file: LICENSE")
})

test("Windows npm operations run through its command shim with whitespace paths kept as arguments", () => {
  const args = ["npm", "pack", "--pack-destination", "C:\\Release Files\\artifacts"]
  expect(packageCommand(args, "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "npm.cmd", ...args.slice(1)])
})
