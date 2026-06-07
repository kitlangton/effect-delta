import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Delta from "effect-delta"

const Value = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  optional: Schema.optionalKey(Schema.String),
  nested: Schema.Struct({ value: Schema.Number }),
  items: Schema.Array(Schema.Number)
})

const delta = Delta.make(Value)
const symbol = Symbol("adversarial")

const captureFailure = (run: () => unknown): Error => {
  let failure: unknown
  try {
    run()
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error)
  assert.strictEqual(failure instanceof RangeError, false)
  return failure
}

const decodeFailure = (input: unknown): void => {
  captureFailure(() => Schema.decodeUnknownSync(delta.schema)(input))
}

describe("Delta schema adversarial transport", () => {
  it("accepts shared runtime patch DAGs while rejecting actual cycles", () => {
    const string = Delta.make(Schema.String)
    const append = string.fromUpdate(Delta.append("x"))
    const pair = string.combine(append, append)
    const shared = string.combine(pair, pair)

    assert.strictEqual(string.patch("", shared), "xxxx")
    assert.doesNotThrow(() => Schema.asserts(string.schema, shared))
    const encoded = Schema.encodeSync(string.schema)(shared)
    assert.strictEqual((encoded as { readonly patches: ReadonlyArray<unknown> }).patches.length, 4)
    assert.strictEqual(string.patch("", Schema.decodeSync(string.schema)(encoded)), "xxxx")

    const cycle: { _tag: "Sequence"; first: unknown; second: typeof append } = {
      _tag: "Sequence",
      first: null,
      second: append
    }
    cycle.first = cycle
    captureFailure(() => Schema.asserts(string.schema, cycle))
    captureFailure(() => Schema.encodeSync(string.schema)(cycle as never))
    captureFailure(() => string.patch("", cycle as never))
  })

  it("rejects malformed tags and missing, extra, or symbol keys at every envelope", () => {
    const invalid: ReadonlyArray<unknown> = [
      null,
      [],
      {},
      { _tag: null },
      { _tag: "Unknown" },
      { _tag: "Empty", extra: true },
      { _tag: "Empty", [symbol]: true },
      { _tag: "Replace" },
      { _tag: "Replace", value: { id: 1 }, extra: true },
      { _tag: "Replace", value: { id: 1 }, [symbol]: true },
      { _tag: "Append" },
      { _tag: "Append", value: "x" },
      { _tag: "Struct" },
      { _tag: "Struct", fields: null },
      { _tag: "Struct", fields: {}, extra: true },
      { _tag: "Struct", fields: {}, [symbol]: true },
      { _tag: "Struct", fields: { [symbol]: { _tag: "Empty" } } },
      { _tag: "Struct", fields: { missing: { _tag: "Empty" } } },
      { _tag: "Struct", fields: { id: { _tag: "Empty", extra: true } } },
      { _tag: "Struct", fields: { nested: { _tag: "Struct", fields: {}, extra: true } } },
      { _tag: "Struct", fields: { nested: { _tag: "Struct", fields: { missing: { _tag: "Empty" } } } } },
      { _tag: "Sequence" },
      { _tag: "Sequence", patches: null },
      { _tag: "Sequence", patches: [], extra: true },
      { _tag: "Sequence", patches: [{ _tag: "Empty" }, { _tag: "Empty" }], [symbol]: true },
      { _tag: "Sequence", patches: [{ _tag: "Empty" }, { _tag: "Empty", extra: true }] }
    ]

    for (const input of invalid) decodeFailure(input)
  })

  it("rejects empty, singleton, and recursively nested wire sequences without defects", () => {
    const invalid = [
      { _tag: "Sequence", patches: [] },
      { _tag: "Sequence", patches: [{ _tag: "Empty" }] },
      {
        _tag: "Sequence",
        patches: [
          { _tag: "Empty" },
          { _tag: "Sequence", patches: [{ _tag: "Empty" }, { _tag: "Empty" }] }
        ]
      },
      {
        _tag: "Struct",
        fields: {
          nested: {
            _tag: "Struct",
            fields: {
              value: {
                _tag: "Sequence",
                patches: [{ _tag: "Empty" }, { _tag: "Empty" }]
              }
            }
          }
        }
      }
    ]

    for (const input of invalid) decodeFailure(input)
  })

  it("rejects cyclic wire and runtime sequences without RangeError", () => {
    const cyclicWire: { _tag: string; patches: Array<unknown> } = { _tag: "Sequence", patches: [] }
    cyclicWire.patches.push({ _tag: "Empty" }, cyclicWire)
    decodeFailure(cyclicWire)

    const cyclicRuntime: {
      _tag: "Sequence"
      first: unknown
      second: { readonly _tag: "Empty" }
    } = { _tag: "Sequence", first: null, second: { _tag: "Empty" } }
    cyclicRuntime.first = cyclicRuntime

    captureFailure(() => Schema.asserts(delta.schema, cyclicRuntime))
    captureFailure(() => Schema.encodeSync(delta.schema)(cyclicRuntime as never))
    captureFailure(() => delta.patch({ id: 1, text: "", nested: { value: 1 }, items: [] }, cyclicRuntime as never))
  })

  it("rejects invalid field, remove, append, and replacement operations", () => {
    const invalid: ReadonlyArray<unknown> = [
      { _tag: "Remove" },
      { _tag: "Append", value: "root" },
      { _tag: "Replace", value: null },
      { _tag: "Replace", value: { id: "1", text: "", nested: { value: 1 }, items: [] } },
      { _tag: "Struct", fields: { id: { _tag: "Remove" } } },
      { _tag: "Struct", fields: { optional: { _tag: "Remove", extra: true } } },
      { _tag: "Struct", fields: { id: { _tag: "Append", value: 1 } } },
      { _tag: "Struct", fields: { text: { _tag: "Append", value: ["x"] } } },
      { _tag: "Struct", fields: { items: { _tag: "Append", value: [1, "2"] } } },
      { _tag: "Struct", fields: { nested: { _tag: "Append", value: [] } } },
      { _tag: "Struct", fields: { nested: { _tag: "Struct", fields: { value: { _tag: "Remove" } } } } }
    ]

    for (const input of invalid) decodeFailure(input)
  })

  it("encodes and decodes 40k operations as one flat sequence", () => {
    const string = Delta.make(Schema.String)
    let patch: Delta.Patch<typeof Schema.String> = string.empty
    for (let index = 0; index < 40_000; index++) {
      patch = string.combine(patch, string.fromUpdate(Delta.append("x")))
    }

    const encoded = Schema.encodeSync(string.schema)(patch)
    if (encoded === null || typeof encoded !== "object" || Array.isArray(encoded)) assert.fail("expected object")
    if (!("_tag" in encoded) || !("patches" in encoded)) assert.fail("expected Sequence envelope")
    assert.strictEqual(encoded._tag, "Sequence")
    assert.ok(Array.isArray(encoded.patches))
    assert.strictEqual(encoded.patches.length, 40_000)

    const decoded = Schema.decodeUnknownSync(string.schema)(encoded)
    assert.strictEqual(string.patch("", decoded).length, 40_000)
    assert.deepStrictEqual(Schema.encodeSync(string.schema)(decoded), encoded)
  })

  it("normalizes replacement values to canonical JSON and is codec-idempotent", () => {
    class Event extends Schema.Class<Event>("AdversarialEvent")({
      at: Schema.Date,
      count: Schema.NumberFromString,
      details: Schema.Struct({ enabled: Schema.Boolean })
    }) {}

    const event = Delta.make(Event)
    const codec1 = Schema.toCodecJson(event.schema)
    const codec2 = Schema.toCodecJson(codec1)
    const patch = event.fromUpdate(Delta.replace(new Event({
      at: new Date("2026-02-03T04:05:06.000Z"),
      count: 42,
      details: { enabled: true, ignored: "strip" } as never
    })))

    const encoded1 = Schema.encodeSync(codec1)(patch)
    const encoded2 = Schema.encodeSync(codec2)(patch)
    assert.deepStrictEqual(encoded1, encoded2)
    assert.deepStrictEqual(encoded1, {
      _tag: "Replace",
      value: {
        at: "2026-02-03T04:05:06.000Z",
        count: 42,
        details: { enabled: true }
      }
    })

    const decoded1 = Schema.decodeUnknownSync(codec1)(encoded1)
    const decoded2 = Schema.decodeUnknownSync(codec2)(encoded2)
    assert.deepStrictEqual(Schema.encodeSync(codec1)(decoded1), encoded1)
    assert.deepStrictEqual(Schema.encodeSync(codec2)(decoded2), encoded2)
  })

  it("roundtrips through JSON stringify and parse", () => {
    const before = { id: 1, text: "a", nested: { value: 1 }, items: [1] }
    const patch = delta.combine(
      delta.fromUpdate({ text: Delta.append("b"), items: Delta.append([2]) }),
      delta.fromUpdate({ optional: "present", nested: { value: 2 } })
    )
    const codec = Schema.toCodecJson(delta.schema)
    const encoded = Schema.encodeSync(codec)(patch)
    const transported: unknown = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(codec)(transported)

    assert.deepStrictEqual(delta.patch(before, decoded), {
      id: 1,
      text: "ab",
      optional: "present",
      nested: { value: 2 },
      items: [1, 2]
    })
    assert.deepStrictEqual(Schema.encodeSync(codec)(decoded), transported)
  })

  it("roundtrips RPC-style NonEmptyArray success wrapping", () => {
    const Success = Schema.NonEmptyArray(delta.schema)
    const codec = Schema.toCodecJson(Success)
    const patches = [
      delta.fromUpdate({ text: Delta.append("b") }),
      delta.fromUpdate({ items: Delta.append([2]), optional: "present" })
    ] as const

    const encoded = Schema.encodeSync(codec)(patches)
    const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(encoded)))
    let result: typeof Value.Type = { id: 1, text: "a", nested: { value: 1 }, items: [1] }
    for (const patch of decoded) result = delta.patch(result, patch)

    assert.deepStrictEqual(result, {
      id: 1,
      text: "ab",
      optional: "present",
      nested: { value: 1 },
      items: [1, 2]
    })
    captureFailure(() => Schema.decodeUnknownSync(codec)([]))
  })

  it("fails cleanly for non-JSON local Unknown replacements", () => {
    const unknown = Delta.make(Schema.Unknown)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const values: ReadonlyArray<unknown> = [
      Symbol("local"),
      () => "local",
      { local: Symbol("nested") },
      { local: () => "nested" },
      cyclic
    ]

    for (const value of values) {
      const patch = unknown.fromUpdate(Delta.replace(value))
      captureFailure(() => Schema.encodeSync(unknown.schema)(patch))
      captureFailure(() => Schema.encodeSync(Schema.toCodecJson(unknown.schema))(patch))
    }
  })

  it("always exposes schema and defers unsupported canonical payload failures", () => {
    const key = Symbol("field")
    const symbolStruct = Delta.make(Schema.Struct({ [key]: Schema.String }))
    const symbolPatch = symbolStruct.fromUpdate(Delta.replace({ [key]: "value" }))
    assert.ok(Schema.isSchema(symbolStruct.schema))
    captureFailure(() => Schema.encodeSync(symbolStruct.schema)(symbolPatch))
    captureFailure(() => Schema.decodeUnknownSync(symbolStruct.schema)({ _tag: "Replace", value: {} }))

    type Token = string & { readonly Token: unique symbol }
    const Token = Schema.declare<Token>((input): input is Token => typeof input === "string")
    const token = Delta.make(Token)
    const tokenPatch = token.fromUpdate(Delta.replace("token" as Token))
    assert.ok(Schema.isSchema(token.schema))
    captureFailure(() => Schema.encodeSync(token.schema)(tokenPatch))
    captureFailure(() => Schema.decodeUnknownSync(token.schema)({ _tag: "Replace", value: null }))

    const Nested = Schema.Struct({ tokens: Schema.Array(Token) })
    const nested = Delta.make(Nested)
    const nestedPatch = nested.fromUpdate(Delta.replace({ tokens: ["token" as Token] }))
    assert.ok(Schema.isSchema(nested.schema))
    captureFailure(() => Schema.encodeSync(nested.schema)(nestedPatch))
    captureFailure(() => Schema.encodeSync(Schema.toCodecJson(nested.schema))(nestedPatch))
  })
})
