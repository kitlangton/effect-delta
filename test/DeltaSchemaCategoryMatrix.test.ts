import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Delta from "effect-delta"

const roundtripReplacement = <S extends Schema.Schema<unknown>>(
  schema: S,
  before: S["Type"],
  value: S["Type"]
): unknown => {
  const delta = Delta.make(schema)
  const codec = Schema.toCodecJson(delta.schema)
  const patch = delta.fromUpdate(Delta.replace(value))
  const encoded = Schema.encodeSync(codec)(patch)
  const decoded = Schema.decodeSync(codec)(encoded)
  assert.deepStrictEqual(delta.patch(before, decoded), value)
  return encoded
}

describe("Delta schema category matrix", () => {
  it("roundtrips primitive and literal replacements and rejects invalid payloads", () => {
    const cases = [
      [Schema.Number, 1, 2, "bad"],
      [Schema.Boolean, false, true, 1],
      [Schema.Null, null, null, undefined],
      [Schema.Literal("ready"), "ready", "ready", "waiting"]
    ] as const

    for (const [schema, before, after, invalid] of cases) {
      const delta = Delta.make(schema)
      const patch = delta.diff(before, after)
      const decoded = Schema.decodeUnknownSync(delta.schema)(Schema.encodeSync(delta.schema)(patch))
      assert.deepStrictEqual(delta.patch(before, decoded), after)
      assert.throws(() => Schema.decodeUnknownSync(delta.schema)({ _tag: "Replace", value: invalid }))
    }
  })

  it("roundtrips sparse nested and optional struct operations", () => {
    const Model = Schema.Struct({
      profile: Schema.Struct({
        name: Schema.String,
        details: Schema.Struct({ city: Schema.String, zip: Schema.Number }),
        address: Schema.optionalKey(Schema.Struct({ city: Schema.String, zip: Schema.Number }))
      }),
      note: Schema.optionalKey(Schema.String)
    })
    const delta = Delta.make(Model)
    const before = {
      profile: {
        name: "Ada",
        details: { city: "London", zip: 1 },
        address: { city: "Oxford", zip: 2 }
      },
      note: "old"
    }
    const patch = delta.fromUpdate({
      profile: { details: { city: "Paris" }, address: Delta.remove() },
      note: Delta.remove()
    })
    const encoded = Schema.encodeSync(delta.schema)(patch)
    const decoded = Schema.decodeSync(delta.schema)(encoded)

    assert.deepStrictEqual(delta.patch(before, decoded), {
      profile: { name: "Ada", details: { city: "Paris", zip: 1 } }
    })
    assert.throws(() => Schema.decodeUnknownSync(delta.schema)({
      _tag: "Struct",
      fields: { profile: { _tag: "Remove" } }
    }))
  })

  it("distinguishes homogeneous arrays from fixed and variadic tuples", () => {
    const array = Delta.make(Schema.Array(Schema.Number))
    const append = Schema.decodeUnknownSync(array.schema)({ _tag: "Append", value: [2, 3] })
    assert.deepStrictEqual(array.patch([1], append), [1, 2, 3])
    assert.throws(() => Schema.decodeUnknownSync(array.schema)({ _tag: "Append", value: ["bad"] }))

    const tuple = Delta.make(Schema.Tuple([Schema.String, Schema.Number]))
    const tuplePatch = tuple.diff(["a", 1], ["b", 2])
    assert.strictEqual(tuplePatch._tag, "Replace")
    assert.deepStrictEqual(tuple.patch(["a", 1], Schema.decodeUnknownSync(tuple.schema)(tuplePatch)), ["b", 2])
    assert.throws(() => Schema.decodeUnknownSync(tuple.schema)({ _tag: "Append", value: ["c"] }))

    const variadic = Delta.make(Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number]))
    const variadicPatch = variadic.diff(["a", 1], ["a", 1, 2])
    assert.strictEqual(variadicPatch._tag, "Replace")
    assert.deepStrictEqual(variadic.patch(["a", 1], variadicPatch), ["a", 1, 2])
  })

  it("uses replacement for unions while validating the selected member", () => {
    const Value = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("count"), value: Schema.Number })
    ])
    const delta = Delta.make(Value)
    const before = { kind: "text" as const, value: "one" }
    const after = { kind: "count" as const, value: 2 }
    const patch = delta.diff(before, after)

    assert.strictEqual(patch._tag, "Replace")
    assert.deepStrictEqual(delta.patch(before, Schema.decodeUnknownSync(delta.schema)(patch)), after)
    assert.throws(() => Schema.decodeUnknownSync(delta.schema)({
      _tag: "Replace",
      value: { kind: "count", value: "two" }
    }))
  })

  it("enforces checked schemas on decode and after append application", () => {
    const Positive = Schema.Number.check(Schema.isGreaterThan(0))
    const positive = Delta.make(Positive)
    assert.throws(() => Schema.decodeUnknownSync(positive.schema)({ _tag: "Replace", value: 0 }))

    const Short = Schema.String.check(Schema.isMaxLength(4))
    const short = Delta.make(Short)
    const suffix = Schema.decodeUnknownSync(short.schema)({ _tag: "Append", value: "cd" })
    assert.strictEqual(short.patch("ab", suffix), "abcd")
    assert.throws(() => short.patch("abc", suffix), /patched value does not satisfy the schema/)

  })

  it("roundtrips transformed Date, BigInt, and class values through canonical JSON", () => {
    assert.deepStrictEqual(
      roundtripReplacement(Schema.NumberFromString, 1, 42),
      { _tag: "Replace", value: 42 }
    )
    assert.deepStrictEqual(
      roundtripReplacement(
        Schema.DateFromString,
        new Date("2000-01-01T00:00:00.000Z"),
        new Date("2026-06-01T02:03:04.000Z")
      ),
      { _tag: "Replace", value: "2026-06-01T02:03:04.000Z" }
    )
    assert.deepStrictEqual(
      roundtripReplacement(Schema.BigIntFromString, 1n, 9007199254740993n),
      { _tag: "Replace", value: "9007199254740993" }
    )

    class Event extends Schema.Class<Event>("CategoryMatrixEvent")({
      id: Schema.BigIntFromString,
      at: Schema.DateFromString
    }) {}
    const encoded = roundtripReplacement(
      Event,
      new Event({ id: 1n, at: new Date("2000-01-01T00:00:00.000Z") }),
      new Event({ id: 2n, at: new Date("2026-06-02T00:00:00.000Z") })
    )
    assert.deepStrictEqual(encoded, {
      _tag: "Replace",
      value: { id: "2", at: "2026-06-02T00:00:00.000Z" }
    })
  })

  it("falls back to replacement for declarations and recursive schemas", () => {
    type Token = string & { readonly Token: unique symbol }
    const Token = Schema.declare<Token>(
      (input): input is Token => typeof input === "string" && input.startsWith("token_")
    )
    const token = Delta.make(Token)
    const oldToken = "token_old" as Token
    const newToken = "token_new" as Token
    assert.deepStrictEqual(token.diff(oldToken, newToken), { _tag: "Replace", value: newToken })
    const tokenPatch = token.diff(oldToken, newToken)
    assert.throws(() => Schema.encodeSync(token.schema)(tokenPatch))

    interface Node {
      readonly value: string
      readonly child?: Node
    }
    let Node: Schema.Codec<Node>
    Node = Schema.Struct({
      value: Schema.String,
      child: Schema.optionalKey(Schema.suspend(() => Node))
    })
    const recursive = Delta.make(Node)
    const before: Node = { value: "a" }
    const after: Node = { value: "b", child: { value: "c" } }
    const patch = recursive.diff(before, after)
    assert.deepStrictEqual(patch as unknown, {
      _tag: "Struct",
      fields: {
        value: { _tag: "Replace", value: "b" },
        child: { _tag: "Replace", value: { value: "c" } }
      }
    })
    assert.deepStrictEqual(recursive.patch(before, patch), after)
    const decoded = Schema.decodeSync(recursive.schema)(Schema.encodeSync(recursive.schema)(patch))
    assert.deepStrictEqual(recursive.patch(before, decoded), after)
  })

  it("roundtrips registered symbols and safely decodes dangerous field names", () => {
    const symbol = Delta.make(Schema.Symbol)
    const replacement = symbol.diff(Symbol.for("old"), Symbol.for("new"))
    assert.strictEqual(replacement._tag, "Replace")
    const symbolCodec = Schema.toCodecJson(symbol.schema)
    const encodedSymbol = Schema.encodeSync(symbolCodec)(replacement)
    const decodedSymbol = Schema.decodeSync(symbolCodec)(encodedSymbol)
    assert.deepStrictEqual(encodedSymbol, { _tag: "Replace", value: "Symbol(new)" })
    assert.strictEqual(symbol.patch(Symbol.for("old"), decodedSymbol), Symbol.for("new"))

    const Dangerous = Schema.Struct({
      ["__proto__"]: Schema.String,
      constructor: Schema.String,
      prototype: Schema.String
    })
    const dangerous = Delta.make(Dangerous)
    const before = JSON.parse('{"__proto__":"old","constructor":"old","prototype":"old"}')
    const wire = JSON.parse(
      '{"_tag":"Struct","fields":{"__proto__":{"_tag":"Replace","value":"new"},"constructor":{"_tag":"Replace","value":"new"},"prototype":{"_tag":"Replace","value":"new"}}}'
    )
    const patch = Schema.decodeUnknownSync(dangerous.schema)(wire)
    const after = dangerous.patch(before, patch)
    assert.strictEqual(Object.getPrototypeOf(after), Object.prototype)
    assert.deepStrictEqual(after, JSON.parse('{"__proto__":"new","constructor":"new","prototype":"new"}'))
    assert.strictEqual(({} as { polluted?: unknown }).polluted, undefined)
  })

  it("uses replacement fallback for records and rejects invalid replacement results", () => {
    const Dictionary = Schema.Record(Schema.String, Schema.Number)
    const dictionary = Delta.make(Dictionary)
    const before = { a: 1 }
    const after = { a: 2, b: 3 }
    const patch = dictionary.diff(before, after)
    assert.strictEqual(patch._tag, "Replace")
    assert.strictEqual(dictionary.patch(before, patch), after)
    assert.throws(
      () => dictionary.patch(before, { _tag: "Replace", value: { a: "bad" } } as never),
      /malformed patch/
    )
  })
})
