import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { FastCheck as fc } from "effect/testing"
import * as Delta from "effect-delta"

const Value = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  nested: Schema.Struct({ count: Schema.Number, label: Schema.String }),
  tags: Schema.Array(Schema.String),
  note: Schema.optionalKey(Schema.String)
})

type Value = typeof Value.Type

const requiredValue = fc.record({
  id: fc.integer({ min: -1_000, max: 1_000 }),
  text: fc.string({ maxLength: 20 }),
  nested: fc.record({
    count: fc.integer({ min: -1_000, max: 1_000 }),
    label: fc.string({ maxLength: 20 })
  }),
  tags: fc.array(fc.string({ maxLength: 12 }), { maxLength: 8 })
})

const value: fc.Arbitrary<Value> = fc.oneof(
  requiredValue,
  fc.tuple(requiredValue, fc.string({ maxLength: 20 })).map(([input, note]) => ({ ...input, note }))
)

describe("Delta algebra and properties", () => {
  const delta = Delta.make(Value)

  it.prop("roundtrips canonical structs through diff and patch", [value, value], ([before, after]) => {
    assert.deepStrictEqual(delta.patch(before, delta.diff(before, after)), after)
  })

  it.prop("empty is a patch identity and preserves the input reference", [value, value], ([before, after]) => {
    const patch = delta.diff(before, after)

    assert.strictEqual(delta.patch(before, delta.empty), before)
    assert.deepStrictEqual(delta.patch(before, delta.combine(delta.empty, patch)), after)
    assert.deepStrictEqual(delta.patch(before, delta.combine(patch, delta.empty)), after)
  })

  it.prop("combine applies patches sequentially", [value, value, value], ([a, b, c]) => {
    const first = delta.diff(a, b)
    const second = delta.diff(b, c)

    assert.deepStrictEqual(
      delta.patch(a, delta.combine(first, second)),
      delta.patch(delta.patch(a, first), second)
    )
  })

  it.prop("combine is associative by patch behavior", [value, value, value, value], ([a, b, c, d]) => {
    const first = delta.diff(a, b)
    const second = delta.diff(b, c)
    const third = delta.diff(c, d)

    assert.deepStrictEqual(
      delta.patch(a, delta.combine(delta.combine(first, second), third)),
      delta.patch(a, delta.combine(first, delta.combine(second, third)))
    )
  })

  it("composes append, replace, and remove in left-to-right order", () => {
    const before: Value = {
      id: 1,
      text: "start",
      nested: { count: 1, label: "kept" },
      tags: ["a"],
      note: "remove me"
    }
    const append = delta.fromUpdate({ text: Delta.append("+old"), tags: Delta.append(["b"]) })
    const replaceAndRemove = delta.fromUpdate({
      text: Delta.replace("new"),
      nested: Delta.replace({ count: 2, label: "replaced" }),
      note: Delta.remove()
    })
    const appendAgain = delta.fromUpdate({ text: Delta.append("+tail"), tags: Delta.append(["c"]) })
    const patch = delta.combine(delta.combine(append, replaceAndRemove), appendAgain)

    assert.deepStrictEqual(delta.patch(before, patch), {
      id: 1,
      text: "new+tail",
      nested: { count: 2, label: "replaced" },
      tags: ["a", "b", "c"]
    })
  })

  it("preserves untouched references while cloning only changed struct paths", () => {
    const before: Value = {
      id: 1,
      text: "before",
      nested: { count: 1, label: "shared" },
      tags: ["shared"]
    }
    const after = delta.patch(before, delta.fromUpdate({ text: "after" }))

    assert.notStrictEqual(after, before)
    assert.strictEqual(after.nested, before.nested)
    assert.strictEqual(after.tags, before.tags)
    assert.strictEqual(delta.patch(before, delta.fromUpdate({ text: Delta.append("") })), before)
  })

  it.prop("does not mutate frozen canonical inputs", [value, value], ([before, after]) => {
    const snapshot = structuredClone(before)
    Object.freeze(before.nested)
    Object.freeze(before.tags)
    Object.freeze(before)

    assert.deepStrictEqual(delta.patch(before, delta.diff(before, after)), after)
    assert.deepStrictEqual(before, snapshot)
  })

  it.prop(
    "schema encode/decode preserves patch behavior for canonical values",
    [value, value, fc.string({ maxLength: 16 }), fc.array(fc.string({ maxLength: 8 }), { maxLength: 5 })],
    ([before, after, textSuffix, tagSuffix]) => {
      const authored = delta.fromUpdate({
        text: Delta.append(textSuffix),
        tags: Delta.append(tagSuffix),
        note: Delta.remove()
      })
      const patch = delta.combine(delta.diff(before, after), authored)
      const codec = Schema.toCodecJson(delta.schema)
      const encoded = Schema.encodeSync(codec)(patch)
      const decoded = Schema.decodeSync(codec)(encoded)

      assert.deepStrictEqual(delta.patch(before, decoded), delta.patch(before, patch))
      assert.deepStrictEqual(Schema.encodeSync(codec)(decoded), encoded)
    }
  )

})
