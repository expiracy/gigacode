import { describe, expect, test } from "bun:test"
import { parseCommand } from "../src/commands.ts"

describe("deterministic gigacode command parsing", () => {
  test("explicit read-only recipes preserve multiline task scope and reject ambiguous selection", () => {
    expect(parseCommand('/gigacode plan --recipe deep-review Inspect "quoted" callers\nand errors')).toEqual({ type: "plan", recipe: "deep-review", task: 'Inspect "quoted" callers\nand errors' })
    for (const text of ["plan --recipe", "plan --recipe deep-review", "plan --recipe unknown Review", "start --recipe deep-review Review", "-- --recipe deep-review Review"]) expect(() => parseCommand(text)).toThrow()
  })
  test("preserves task text and accepts the explicit start alias", () => {
    expect(parseCommand('plan Fix "quoted  text"\nwith a second line')).toEqual({ type: "plan", task: 'Fix "quoted  text"\nwith a second line' })
    expect(parseCommand("start inspect the status parser")).toEqual({ type: "start", task: "inspect the status parser" })
    expect(parseCommand("-- fix race conditions")).toEqual({ type: "start", task: "fix race conditions" })
    expect(parseCommand("/gigacode plan design an API")).toEqual({ type: "plan", task: "design an API" })
  })

  test("parses control commands without guessed arguments", () => {
    expect(parseCommand("run run-1@3")).toEqual({ type: "run", id: "run-1", revision: 3 })
    expect(parseCommand("status")).toEqual({ type: "status" })
    expect(parseCommand("status run-1")).toEqual({ type: "status", id: "run-1" })
    expect(parseCommand("inspect run-1 critic")).toEqual({ type: "inspect", id: "run-1", taskId: "critic" })
    expect(parseCommand("retry run-1 implement")).toEqual({ type: "retry", id: "run-1", taskId: "implement" })
    for (const type of ["pause", "resume", "cancel", "export"] as const) expect(parseCommand(`${type} run-1`)).toEqual({ type, id: "run-1" })
    for (const type of ["config", "on", "off"] as const) expect(parseCommand(type)).toEqual({ type })
  })

  test("rejects unknown, ambiguous, missing, and surplus input", () => {
    for (const text of ["", "strat fix it", "fix it", "plan", "--", "run x", "run x@0", "run x@1 more", "retry x", "inspect", "inspect x a b", "status x y", "config model", "on now", "pause ../x", "run x@1.5", "cancel x@3"]) {
      expect(() => parseCommand(text)).toThrow()
    }
  })

  test("records explicit answers and strict budget increases without guessing text", () => {
    expect(parseCommand('input run-1 Use the local API,\nwith offline tests.')).toEqual({ type: "input", id: "run-1", answer: 'Use the local API,\nwith offline tests.' })
    expect(parseCommand('budget run-1 {"attempts":30,"runMs":3600000}')).toEqual({ type: "budget", id: "run-1", limits: { attempts: 30, runMs: 3600000 } })
    for (const text of ['input run-1', 'budget run-1', 'budget run-1 {"bad":10}', 'budget run-1 {"workers":0}', 'budget run-1 []', 'budget run-1 {}']) expect(() => parseCommand(text)).toThrow()
  })
})
