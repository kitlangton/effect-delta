import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Delta from "effect-delta"

const Message = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  author: Schema.Struct({ name: Schema.String }),
  tags: Schema.Array(Schema.String)
})

describe("Delta", () => {
  const delta = Delta.make(Message)
  const before = { id: 1, text: "hello", author: { name: "Ada" }, tags: ["effect"] }

  it("preserves references for empty and nested empty patches", () => {
    assert.strictEqual(delta.diff(before, before), delta.empty)
    assert.strictEqual(delta.patch(before, delta.empty), before)
    assert.strictEqual(delta.combine(delta.empty, delta.empty), delta.empty)
    assert.strictEqual(delta.fromUpdate({ author: {} }), delta.empty)
    assert.strictEqual(delta.patch(before, delta.fromUpdate({ author: {} })), before)
  })

  it("conservatively replaces strings during automatic diffing", () => {
    assert.deepStrictEqual(delta.diff(before, { ...before, text: "hello world" }), {
      _tag: "Struct",
      fields: { text: { _tag: "Replace", value: "hello world" } }
    })
  })

  it("supports explicit string and array appends and normalizes no-ops", () => {
    const patch = delta.fromUpdate({
      text: Delta.append(" world"),
      tags: Delta.append(["schema"])
    })
    assert.deepStrictEqual(delta.patch(before, patch), {
      ...before,
      text: "hello world",
      tags: ["effect", "schema"]
    })
    assert.strictEqual(delta.fromUpdate({ text: Delta.append(""), tags: Delta.append([]) }), delta.empty)
  })

  it("supports checked operations and validates the final value", () => {
    const nonEmpty = Delta.make(Schema.NonEmptyString)
    assert.strictEqual(nonEmpty.patch("a", nonEmpty.fromUpdate(Delta.append("b"))), "ab")
    assert.throws(
      () => nonEmpty.patch("a", nonEmpty.fromUpdate(Delta.replace(""))),
      /malformed patch/
    )

    const MaxTwo = Schema.Array(Schema.String).check(Schema.isMaxLength(2))
    const maxTwo = Delta.make(MaxTwo)
    assert.deepStrictEqual(maxTwo.patch(["a"], maxTwo.fromUpdate(Delta.append(["b"]))), ["a", "b"])
    assert.throws(
      () => maxTwo.patch(["a", "b"], maxTwo.fromUpdate(Delta.append(["c"]))),
      /patched value does not satisfy the schema/
    )

    const Range = Schema.Struct({ min: Schema.Number, max: Schema.Number }).check(
      Schema.makeFilter(({ min, max }) => min <= max, { expected: "min <= max" })
    )
    const range = Delta.make(Range)
    assert.deepStrictEqual(range.patch({ min: 1, max: 3 }, range.fromUpdate({ min: 2 })), { min: 2, max: 3 })
    assert.throws(
      () => range.patch({ min: 1, max: 3 }, range.fromUpdate({ min: 4 })),
      /patched value does not satisfy the schema/
    )
  })

  it("constructs nested sparse struct patches and roundtrips", () => {
    const after = { ...before, id: 2, author: { name: "Grace" } }
    const patch = delta.diff(before, after)
    assert.deepStrictEqual(Object.keys(patch._tag === "Struct" ? patch.fields : {}), ["id", "author"])
    assert.deepStrictEqual(delta.patch(before, patch), after)
    assert.deepStrictEqual(delta.patch(before, delta.fromUpdate({ author: { name: "Grace" } })), {
      ...before,
      author: { name: "Grace" }
    })
  })

  it("replaces when unmodeled struct state changes", () => {
    const Struct = Schema.Struct({ value: Schema.Number })
    const struct = Delta.make(Struct)
    const symbol = Symbol("extra")

    const cases: ReadonlyArray<readonly [object, object]> = [
      [{ value: 1, extra: "old" }, { value: 2, extra: "new" }],
      [{ value: 1 }, { value: 2, extra: true }],
      [{ value: 1, extra: true }, { value: 2 }],
      [{ value: 1, [symbol]: "old" }, { value: 2, [symbol]: "new" }],
      [
        Object.defineProperty({ value: 1 }, "hidden", { value: "old" }),
        Object.defineProperty({ value: 2 }, "hidden", { value: "new" })
      ],
      [
        Object.create({ kind: "old" }, { value: { enumerable: true, writable: true, value: 1 } }),
        Object.create({ kind: "new" }, { value: { enumerable: true, writable: true, value: 2 } })
      ]
    ]

    for (const [before, after] of cases) {
      const patch = struct.diff(before as { readonly value: number }, after as { readonly value: number })
      assert.strictEqual(patch._tag, "Replace")
      assert.strictEqual(struct.patch(before as { readonly value: number }, patch), after)
    }
  })

  it("allows sparse patches when unmodeled struct state is unchanged", () => {
    const Struct = Schema.Struct({ value: Schema.Number })
    const struct = Delta.make(Struct)
    const symbol = Symbol("extra")
    const shared = { shared: true }
    const before = { value: 1, extra: shared, [symbol]: shared }
    const after = { value: 2, extra: shared, [symbol]: shared }

    const patch = struct.diff(before, after)
    assert.strictEqual(patch._tag, "Struct")
    assert.deepStrictEqual(struct.patch(before, patch), after)
    assert.strictEqual((struct.patch(before, patch) as typeof before)[symbol], shared)
  })

  it("does not confuse tagged domain values with authoring commands", () => {
    const Tagged = Schema.Struct({
      payload: Schema.Struct({ _tag: Schema.String, value: Schema.Number })
    })
    const tagged = Delta.make(Tagged)
    const before = { payload: { _tag: "Old", value: 1 } }
    const replacement = { _tag: "Replace", value: 2 }
    const patch = tagged.fromUpdate({ payload: Delta.replace(replacement) })
    const decoded = Schema.decodeUnknownSync(tagged.schema)(patch)
    assert.deepStrictEqual(tagged.patch(before, patch), { payload: replacement })
    assert.deepStrictEqual(tagged.patch(before, decoded), { payload: replacement })
    assert.deepStrictEqual(patch, {
      _tag: "Struct",
      fields: { payload: { _tag: "Replace", value: replacement } }
    })
  })

  it("preserves optional property presence exactly", () => {
    const Optional = Schema.Struct({
      key: Schema.optionalKey(Schema.String),
      value: Schema.optional(Schema.String)
    })
    const optional = Delta.make(Optional)
    const absent = {}
    const explicit = { value: undefined }
    const present = { key: "x", value: "x" }

    assert.deepStrictEqual(optional.patch(absent, optional.diff(absent, explicit)), explicit)
    assert.strictEqual(Object.hasOwn(optional.patch(absent, optional.diff(absent, explicit)), "value"), true)
    assert.deepStrictEqual(optional.patch(absent, optional.diff(absent, present)), present)
    assert.deepStrictEqual(optional.patch(present, optional.diff(present, absent)), absent)
    assert.deepStrictEqual(optional.patch(present, optional.fromUpdate({ key: Delta.remove() })), { value: "x" })
    assert.throws(
      () => optional.fromUpdate({ value: Delta.append("x") } as never),
      /Append is not supported/
    )
  })

  it("handles __proto__ fields without changing prototypes", () => {
    const Proto = Schema.Struct({
      ["__proto__"]: Schema.String,
      ["constructor"]: Schema.String,
      ["prototype"]: Schema.String,
      safe: Schema.optionalKey(Schema.String)
    })
    const proto = Delta.make(Proto)
    const before = Object.create(null) as {
      readonly __proto__: string
      readonly constructor: string
      readonly prototype: string
      readonly safe?: string
    }
    Object.defineProperty(before, "__proto__", { enumerable: true, configurable: true, value: "old" })
    Object.defineProperty(before, "constructor", { enumerable: true, configurable: true, value: "old" })
    Object.defineProperty(before, "prototype", { enumerable: true, configurable: true, value: "old" })
    const patch = proto.fromUpdate({
      ["__proto__"]: "new",
      ["constructor"]: "new",
      ["prototype"]: "new",
      safe: "yes"
    })
    const next = proto.patch(before, patch)
    assert.strictEqual(Object.getPrototypeOf(next), null)
    assert.strictEqual(Object.hasOwn(next, "__proto__"), true)
    assert.strictEqual(next.__proto__, "new")
    assert.strictEqual(next.constructor, "new")
    assert.strictEqual(next.prototype, "new")
    assert.strictEqual(next.safe, "yes")

    const removal = Object.create(null) as { readonly safe: ReturnType<typeof Delta.remove> }
    Object.defineProperty(removal, "safe", { enumerable: true, value: Delta.remove() })
    const removed = proto.patch(next, proto.fromUpdate(removal as never))
    assert.strictEqual(Object.getPrototypeOf(removed), null)
    assert.strictEqual(Object.hasOwn(removed, "safe"), false)
  })

  it("uses replacement fallback for empty structs, unions, and unknown values", () => {
    const emptyStruct = Delta.make(Schema.Struct({}))
    assert.deepStrictEqual(emptyStruct.diff(1, "x"), { _tag: "Replace", value: "x" })
    assert.strictEqual(emptyStruct.patch(1, emptyStruct.diff(1, "x")), "x")

    const union = Delta.make(Schema.Union([Schema.String, Schema.Number]))
    assert.deepStrictEqual(union.diff("1", "12"), { _tag: "Replace", value: "12" })

    const unknown = Delta.make(Schema.Unknown)
    const oldValue = { nested: 1 }
    const newValue = { nested: 2 }
    const patch = unknown.diff(oldValue, newValue)
    assert.deepStrictEqual(patch, { _tag: "Replace", value: newValue })
    assert.strictEqual(unknown.patch(oldValue, patch), newValue)
  })

  it("uses replacement fallback for symbol-keyed structs", () => {
    const key = Symbol.for("effect-delta/test")
    const SymbolStruct = Schema.Struct({ [key]: Schema.String, value: Schema.Number })
    const symbolStruct = Delta.make(SymbolStruct)
    const before = { [key]: "old", value: 1 }
    const after = { [key]: "new", value: 2 }
    const patch = symbolStruct.diff(before, after)
    assert.deepStrictEqual(patch, { _tag: "Replace", value: after })
    assert.strictEqual(symbolStruct.patch(before, patch), after)

    const codec = symbolStruct.schema
    assert.throws(() => Schema.encodeSync(codec)(patch))
    assert.throws(() => Schema.decodeUnknownSync(codec)({ _tag: "Replace", value: {} }))
  })

  it("applies patches immutably", () => {
    const next = delta.patch(before, delta.fromUpdate({ author: { name: "Grace" } }))
    assert.notStrictEqual(next, before)
    assert.notStrictEqual(next.author, before.author)
    assert.strictEqual(next.tags, before.tags)
    assert.deepStrictEqual(before.author, { name: "Ada" })
  })

  it("patches frozen, sealed, and non-configurable source objects", () => {
    const Optional = Schema.Struct({ value: Schema.Number, note: Schema.optionalKey(Schema.String) })
    const optional = Delta.make(Optional)
    const nonConfigurable = { note: "old" } as { value: number; note: string }
    Object.defineProperty(nonConfigurable, "value", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: 1
    })
    const sources: ReadonlyArray<{ readonly value: number; readonly note?: string }> = [
      Object.freeze({ value: 1, note: "old" }),
      Object.seal({ value: 1, note: "old" }),
      nonConfigurable
    ]
    for (const source of sources) {
      const changed = optional.patch(source, optional.fromUpdate({ value: 2 }))
      assert.deepStrictEqual(changed, { value: 2, note: "old" })
      assert.strictEqual(Object.getPrototypeOf(changed), Object.getPrototypeOf(source))
      assert.strictEqual(Object.getOwnPropertyDescriptor(changed, "value")?.configurable, true)
      const removed = optional.patch(source, optional.fromUpdate({ note: Delta.remove() }))
      assert.deepStrictEqual(removed, { value: 1 })
    }
  })

  it("derives a schema for replace, append, nested struct, and sequence patches", () => {
    const replacements = delta.diff(before, { ...before, id: 2 })
    const nested = delta.fromUpdate({ author: { name: "Grace" } })
    const append = delta.fromUpdate({ text: Delta.append(" world") })
    const sequence = delta.combine(append, nested)

    for (const codec of [delta.schema, Schema.toCodecJson(delta.schema)]) {
      const decode = Schema.decodeSync(codec)
      const encode = Schema.encodeSync(codec)
      for (const patch of [replacements, nested, append, sequence]) {
        const decoded = decode(encode(patch))
        assert.notStrictEqual(encode(patch), null)
        assert.deepStrictEqual(delta.patch(before, decoded), delta.patch(before, patch))
      }
    }
  })

  it("derives Remove only for optional struct fields", () => {
    const Optional = Schema.Struct({ required: Schema.String, optional: Schema.optionalKey(Schema.String) })
    const optional = Delta.make(Optional)
    const jsonCodec = Schema.toCodecJson(optional.schema)
    const decode = Schema.decodeSync(jsonCodec)
    const encode = Schema.encodeSync(jsonCodec)
    const patch = optional.fromUpdate({ optional: Delta.remove() })

    assert.deepStrictEqual(decode(encode(patch)), patch)
    assert.deepStrictEqual(optional.patch({ required: "x", optional: "y" }, decode(encode(patch))), { required: "x" })
    assert.throws(() => decode({
      _tag: "Struct",
      fields: { required: { _tag: "Remove" } }
    }))
  })

  it("uses suffix schemas rather than whole-value checks for Append", () => {
    const NonEmpty = Delta.make(Schema.NonEmptyString)
    const MaxTwo = Delta.make(Schema.Array(Schema.String).check(Schema.isMaxLength(2)))

    const emptySuffix = Schema.decodeUnknownSync(NonEmpty.schema)({ _tag: "Append", value: "" })
    const arraySuffix = Schema.decodeUnknownSync(MaxTwo.schema)({ _tag: "Append", value: ["a", "b", "c"] })
    assert.deepStrictEqual(emptySuffix, { _tag: "Append", value: "" })
    assert.deepStrictEqual(arraySuffix, { _tag: "Append", value: ["a", "b", "c"] })
    assert.throws(() => MaxTwo.patch([], arraySuffix), /patched value does not satisfy the schema/)
  })

  it("roundtrips transformed replacement values through canonical JSON", () => {
    const transformed = Delta.make(Schema.NumberFromString)
    const patch = transformed.fromUpdate(Delta.replace(42))
    for (const codec of [transformed.schema, Schema.toCodecJson(transformed.schema)]) {
      const encoded = Schema.encodeSync(codec)(patch)
      const decoded = Schema.decodeSync(codec)(encoded)
      assert.deepStrictEqual(encoded, { _tag: "Replace", value: 42 })
      assert.deepStrictEqual(decoded, patch)
      assert.strictEqual(transformed.patch(1, decoded), 42)
    }
  })

  it("does not apply patch-envelope exactness to Replace values", () => {
    const Value = Schema.Struct({ value: Schema.Number })
    const value = Delta.make(Value)
    const patch = value.fromUpdate(Delta.replace({ value: 2, extra: true } as typeof Value.Type))
    const encoded = Schema.encodeSync(value.schema)(patch)
    const decoded = Schema.decodeSync(value.schema)(encoded)
    assert.deepStrictEqual(encoded, { _tag: "Replace", value: { value: 2 } })
    assert.deepStrictEqual(value.patch({ value: 1 }, decoded), { value: 2 })
  })

  it("roundtrips Date and class replacement values through direct and derived JSON codecs", () => {
    class Event extends Schema.Class<Event>("Event")({
      name: Schema.String,
      at: Schema.Date
    }) {}
    const event = Delta.make(Event)
    const value = new Event({ name: "launch", at: new Date("2026-01-02T03:04:05.000Z") })
    const patch = event.fromUpdate(Delta.replace(value))

    for (const codec of [event.schema, Schema.toCodecJson(event.schema)]) {
      const encoded = Schema.encodeSync(codec)(patch)
      const decoded = Schema.decodeSync(codec)(encoded)
      const next = event.patch(new Event({ name: "old", at: new Date(0) }), decoded)
      assert.notStrictEqual(encoded, null)
      assert.strictEqual(next.name, "launch")
      assert.strictEqual(next.at.toISOString(), "2026-01-02T03:04:05.000Z")
    }
  })

  it("asserts 40k-deep runtime sequences iteratively", () => {
    const string = Delta.make(Schema.String)
    let valid: Delta.Patch<typeof Schema.String> = string.fromUpdate(Delta.append("x"))
    for (let index = 1; index < 40_000; index++) {
      valid = { _tag: "Sequence", first: valid, second: string.fromUpdate(Delta.append("x")) }
    }
    assert.doesNotThrow(() => Schema.asserts(string.schema, valid))

    let malformed: unknown = { _tag: "Empty", extra: true }
    for (let index = 1; index < 40_000; index++) {
      malformed = { _tag: "Sequence", first: malformed, second: { _tag: "Empty" } }
    }
    let failure: unknown
    try {
      Schema.asserts(string.schema, malformed)
    } catch (error) {
      failure = error
    }
    assert.ok(failure instanceof Error)
    assert.strictEqual(failure instanceof RangeError, false)
  })
})
