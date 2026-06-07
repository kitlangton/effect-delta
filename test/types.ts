import { Schema } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as Delta from "effect-delta"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2 ? true : false
  : false

const expectTrue = (_value: true): void => {}

const Model = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  nested: Schema.Struct({ count: Schema.Number, note: Schema.optionalKey(Schema.String) }),
  tags: Schema.Array(Schema.String)
})
const modelDelta: Delta.Delta<typeof Model> = Delta.make(Model)
expectTrue(true as Equal<(typeof modelDelta.schema)["Type"], Delta.Patch<typeof Model>>)
expectTrue(true as Equal<(typeof modelDelta.schema)["Encoded"], Schema.Json>)

const nestedPatch = modelDelta.fromUpdate({
  title: Delta.append("!"),
  nested: { count: 2, note: Delta.remove() },
  tags: Delta.append(["typed"])
})
expectTrue(true as Equal<typeof nestedPatch, Delta.Patch<typeof Model>>)
modelDelta.fromUpdate({ nested: { count: 2 } })
modelDelta.fromUpdate({ nested: Delta.replace({ count: 2 }) })
modelDelta.fromUpdate({ nested: { note: Delta.remove() } })
// @ts-expect-error nested scalar updates retain their decoded field type
modelDelta.fromUpdate({ nested: { count: "2" } })
// @ts-expect-error unknown nested fields are rejected
modelDelta.fromUpdate({ nested: { missing: true } })
// @ts-expect-error required nested fields cannot be removed
modelDelta.fromUpdate({ nested: { count: Delta.remove() } })

const Optional = Schema.Struct({
  optionalKey: Schema.optionalKey(Schema.String),
  optionalValue: Schema.optional(Schema.String),
  required: Schema.String
})
const optionalDelta = Delta.make(Optional)
optionalDelta.fromUpdate({ optionalKey: Delta.remove(), optionalValue: Delta.remove() })
// @ts-expect-error required fields cannot be removed
optionalDelta.fromUpdate({ required: Delta.remove() })

Delta.make(Schema.String).fromUpdate(Delta.append("suffix"))
Delta.make(Schema.Array(Schema.Number)).fromUpdate(Delta.append([1, 2]))
Delta.make(Schema.NonEmptyString).fromUpdate(Delta.append("suffix"))
Delta.make(Schema.Array(Schema.Number).check(Schema.isMaxLength(2))).fromUpdate(Delta.append([1]))
// @ts-expect-error string literals are replacement-only
Delta.make(Schema.Literal("fixed")).fromUpdate(Delta.append("suffix"))
// @ts-expect-error tuples are replacement-only
Delta.make(Schema.Tuple([Schema.String, Schema.Number])).fromUpdate(Delta.append(["x", 1]))
// @ts-expect-error template literals are replacement-only
Delta.make(Schema.TemplateLiteral(["id-", Schema.String])).fromUpdate(Delta.append("suffix"))
const Branded = Schema.String.pipe(Schema.brand("Branded"))
// @ts-expect-error branded strings are replacement-only
Delta.make(Branded).fromUpdate(Delta.append("suffix"))
// @ts-expect-error numbers do not support append
Delta.make(Schema.Number).fromUpdate(Delta.append("suffix"))
// @ts-expect-error unions do not support append
Delta.make(Schema.Union([Schema.String, Schema.Number])).fromUpdate(Delta.append("suffix"))
// @ts-expect-error unknown schemas do not support append
Delta.make(Schema.Unknown).fromUpdate(Delta.append("suffix"))

const emptyPatch: Delta.Empty = { _tag: "Empty" }
const replacePatch: Delta.Replace<string> = { _tag: "Replace", value: "next" }
const appendStringPatch: Delta.Append<string> = { _tag: "Append", value: "suffix" }
const appendArrayPatch: Delta.Append<ReadonlyArray<number>> = { _tag: "Append", value: [1] }
const removePatch: Delta.Remove = { _tag: "Remove" }
const structPatch: Delta.StructPatch<typeof Model.fields> = {
  _tag: "Struct",
  fields: { title: appendStringPatch, nested: { _tag: "Struct", fields: { note: removePatch } } }
}
const sequencePatch: Delta.Sequence<typeof Schema.String> = {
  _tag: "Sequence",
  first: emptyPatch,
  second: appendStringPatch
}
const modelPatch: Delta.Patch<typeof Model> = structPatch
void [replacePatch, appendArrayPatch, sequencePatch, modelPatch]
// @ts-expect-error Remove is not a root patch variant
const rootRemovePatch: Delta.Patch<typeof Model> = removePatch
const requiredRemovePatch: Delta.StructPatch<typeof Model.fields> = {
  _tag: "Struct",
  // @ts-expect-error required fields reject Remove in patch data
  fields: { id: removePatch }
}
void [rootRemovePatch, requiredRemovePatch]

const CheckedStruct = Schema.Struct({ value: Schema.Number }).check(Schema.makeFilter(({ value }) => value >= 0))
const checkedStructDelta = Delta.make(CheckedStruct)
checkedStructDelta.fromUpdate({ value: 1 })
expectTrue(true as Equal<(typeof checkedStructDelta.schema)["Type"], Delta.Patch<typeof CheckedStruct>>)

const transformedDelta = Delta.make(Schema.NumberFromString)
transformedDelta.fromUpdate(Delta.replace(42))
expectTrue(true as Equal<(typeof transformedDelta.schema)["Type"], Delta.Patch<typeof Schema.NumberFromString>>)
expectTrue(true as Equal<(typeof transformedDelta.schema)["Encoded"], Schema.Json>)
// @ts-expect-error transformed schemas accept decoded replacement values
transformedDelta.fromUpdate(Delta.replace("42"))
// @ts-expect-error transformed strings are replacement-only
transformedDelta.fromUpdate(Delta.append("2"))

const symbolKey = Symbol.for("effect-delta/types")
const SymbolStruct = Delta.make(Schema.Struct({ [symbolKey]: Schema.String, value: Schema.Number }))
// @ts-expect-error symbol-keyed structs are replacement-only
SymbolStruct.fromUpdate({ value: 1 })
// @ts-expect-error symbol-keyed structs do not expose Struct patches
SymbolStruct.patch({ [symbolKey]: "x", value: 1 }, { _tag: "Struct", fields: { value: emptyPatch } })

const GetPatch = Rpc.make("GetPatch", { success: modelDelta.schema })
expectTrue(true as Equal<typeof GetPatch.successSchema, typeof modelDelta.schema>)
expectTrue(true as Equal<(typeof GetPatch.successSchema)["Type"], Delta.Patch<typeof Model>>)
// @ts-expect-error RPC success values must match the patch schema
const invalidRpcSuccess: (typeof GetPatch.successSchema)["Type"] = { _tag: "Replace", value: { id: "1" } }
void invalidRpcSuccess
