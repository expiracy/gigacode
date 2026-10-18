import { expect, test } from "bun:test"
import { packageMatches } from "../src/native-config.ts"

test("recognizes the npm package without confusing similarly named plugins", () => {
  expect(packageMatches("opencode-gigacode", "/installed/plugin", "/profile")).toBe(true)
  expect(packageMatches("opencode-gigacode-extra", "/installed/plugin", "/profile")).toBe(false)
  expect(packageMatches("another-opencode-gigacode", "/installed/plugin", "/profile")).toBe(false)
})

test("recognizes pinned npm registrations and rejects an empty selector", () => {
  expect(packageMatches("opencode-gigacode@0.1.0", "/installed/plugin", "/profile")).toBe(true)
  expect(packageMatches("opencode-gigacode@next", "/installed/plugin", "/profile")).toBe(true)
  expect(packageMatches("opencode-gigacode@", "/installed/plugin", "/profile")).toBe(false)
})
