import { Schema } from "effect"
import * as Delta from "effect-delta"

Delta.make(Schema.String).fromUpdate(Delta.append("x"))
Delta.make(Schema.Array(Schema.String)).fromUpdate(Delta.append(["x"]))
Delta.make(Schema.NonEmptyString).fromUpdate(Delta.append("x"))
Delta.make(Schema.Array(Schema.String).check(Schema.isMaxLength(2))).fromUpdate(Delta.append(["x"]))

// @ts-expect-error literal strings do not support append
Delta.make(Schema.Literal("x")).fromUpdate(Delta.append("x"))

// @ts-expect-error fixed tuples do not support append
Delta.make(Schema.Tuple([Schema.String])).fromUpdate(Delta.append(["x"]))

// @ts-expect-error template literal schemas do not support append
Delta.make(Schema.TemplateLiteral(["id-", Schema.String])).fromUpdate(Delta.append("x"))

const Branded = Schema.String.pipe(Schema.brand("Branded"))
// @ts-expect-error branded strings do not support append
Delta.make(Branded).fromUpdate(Delta.append("x"))

// @ts-expect-error unsupported schemas do not expose Struct patches
Delta.make(Schema.Unknown).patch({}, { _tag: "Struct", fields: {} })

const Required = Delta.make(Schema.Struct({ value: Schema.String }))
// @ts-expect-error required fields cannot be removed
Required.fromUpdate({ value: Delta.remove() })

const Optional = Delta.make(Schema.Struct({ value: Schema.optionalKey(Schema.String) }))
Optional.fromUpdate({ value: Delta.remove() })

const symbolKey = Symbol.for("effect-delta/types")
const SymbolStruct = Delta.make(Schema.Struct({ [symbolKey]: Schema.String, value: Schema.Number }))
// @ts-expect-error symbol-keyed structs are replacement-only
SymbolStruct.fromUpdate({ value: 1 })
// @ts-expect-error symbol-keyed structs do not expose Struct patches
SymbolStruct.patch({ [symbolKey]: "x", value: 1 }, { _tag: "Struct", fields: { value: { _tag: "Empty" } } })
