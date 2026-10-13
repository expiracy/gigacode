/** Exact native hosts covered by the compatibility and production integration suites. */
export const supportedVersions = ["2.0.25", "2.0.26", "2.0.28"] as const

export function assertHostVersion(version: string): void {
  if (!(supportedVersions as readonly string[]).includes(version)) {
    throw new Error(`Ultra Open Code requires tested OpenCode ${supportedVersions.join(" or ")}; found ${version}. Run the compatibility spike before changing this version gate.`)
  }
}
