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
      /patched value does not satisfy the schema/
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
    assert.deepStrictEqual(tagged.patch(before, patch), { payload: replacement })
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
  })

  it("combines in constant time and applies large sequences stack-safely", () => {
    const string = Delta.make(Schema.String)
    let combined = string.empty
    for (let index = 0; index < 40_000; index++) combined = string.combine(combined, string.fromUpdate(Delta.append("x")))
    assert.strictEqual(combined._tag, "Sequence")
    assert.strictEqual(string.patch("", combined).length, 40_000)

    const append = delta.fromUpdate({ text: Delta.append(" world") })
    const replace = delta.fromUpdate({ text: "goodbye" })
    assert.deepStrictEqual(
      delta.patch(before, delta.combine(append, replace)),
      delta.patch(delta.patch(before, append), replace)
    )
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

  it("throws on malformed or impossible trusted patches", () => {
    assert.throws(() => delta.patch(before, { _tag: "Bogus" } as never), /unknown patch operation/)
    assert.throws(() => delta.patch(before, null as never), /malformed patch/)
    assert.throws(() => delta.patch(before, { _tag: "Sequence", first: null, second: delta.empty } as never), /malformed Sequence/)
    assert.throws(() => delta.patch(before, { _tag: "Replace" } as never), /malformed Replace/)
    assert.throws(() => Delta.make(Schema.String).patch("a", { _tag: "Append" } as never), /malformed Append/)
    assert.throws(
      () => delta.patch(before, { _tag: "Append", value: "x" } as never),
      /Append is not supported/
    )
    assert.throws(
      () => delta.patch(before, { _tag: "Struct", fields: { missing: { _tag: "Empty" } } } as never),
      /unknown struct field/
    )
  })
})
