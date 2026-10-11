import { expect, test } from "bun:test"
import { isolatedEnvironment } from "./host.ts"

test("child environment excludes inherited provider credentials and redirects state", () => {
  process.env.ULTRA_SPIKE_PRIVATE_TEST = "do-not-forward"
  try {
    const environment = isolatedEnvironment("C:\\fixture", "local-password")
    expect(environment.ULTRA_SPIKE_PRIVATE_TEST).toBeUndefined()
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.OPENCODE_CONFIG_DIR).toContain("fixture")
    expect(environment.XDG_DATA_HOME).toContain("fixture")
    expect(environment.OPENCODE_DB).toContain("fixture")
    expect(environment.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
  } finally {
    delete process.env.ULTRA_SPIKE_PRIVATE_TEST
  }
})
