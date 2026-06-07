import { Predicate, Schema, SchemaAST, SchemaTransformation } from "effect"

export type RuntimePatch =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Replace"; readonly value: unknown }
  | { readonly _tag: "Append"; readonly value: string | ReadonlyArray<unknown> }
  | { readonly _tag: "Remove" }
  | { readonly _tag: "Struct"; readonly fields: Readonly<Record<string, RuntimePatch>> }
  | { readonly _tag: "Sequence"; readonly first: RuntimePatch; readonly second: RuntimePatch }

export interface Descriptor {
  readonly schema: Schema.Top
  readonly kind: "replace" | "string" | "array" | "struct"
  readonly value: (input: unknown) => boolean
  readonly appendSchema: Schema.Top | undefined
  readonly appendElement: ((input: unknown) => boolean) | undefined
  readonly fields: ReadonlyMap<string, FieldDescriptor> | undefined
}

export interface FieldDescriptor {
  readonly descriptor: Descriptor
  readonly optional: boolean
}

const isPlainStruct = (ast: SchemaAST.AST): ast is SchemaAST.Objects =>
  SchemaAST.isObjects(ast) &&
  ast.encoding === undefined &&
  ast.propertySignatures.length > 0 &&
  ast.indexSignatures.length === 0 &&
  ast.propertySignatures.every((property) => typeof property.name === "string")

const isAppendString = (ast: SchemaAST.AST): ast is SchemaAST.String =>
  SchemaAST.isString(ast) && ast.encoding === undefined

const isAppendArray = (ast: SchemaAST.AST): ast is SchemaAST.Arrays =>
  SchemaAST.isArrays(ast) && ast.encoding === undefined && ast.elements.length === 0 && ast.rest.length === 1

export const deriveDescriptor = (schema: Schema.Top): Descriptor => {
  const ast = schema.ast
  const struct = isPlainStruct(ast) ? ast : undefined
  const kind: Descriptor["kind"] = struct !== undefined
    ? "struct"
    : isAppendString(ast)
    ? "string"
    : isAppendArray(ast)
    ? "array"
    : "replace"
  const fields: ReadonlyMap<string, FieldDescriptor> | undefined = struct !== undefined
    ? new Map(struct.propertySignatures.map((property): readonly [string, FieldDescriptor] => [String(property.name), {
      descriptor: deriveDescriptor(Schema.make(property.type)),
      optional: SchemaAST.isOptional(property.type)
    }]))
    : undefined
  const appendSchema = kind === "array" ? Schema.make((ast as SchemaAST.Arrays).rest[0]) : undefined
  return {
    schema,
    kind,
    value: Schema.is(Schema.toType(schema)),
    appendSchema,
    appendElement: appendSchema === undefined ? undefined : Schema.is(Schema.toType(appendSchema)),
    fields
  }
}

const hasExactKeys = (input: object, keys: ReadonlyArray<string>): boolean => {
  const ownKeys = Reflect.ownKeys(input)
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === "string" && keys.includes(key))
}

type GuardFrame =
  | { readonly _tag: "Enter"; readonly descriptor: Descriptor; readonly patch: unknown; readonly allowRemove: boolean }
  | { readonly _tag: "Leave"; readonly patch: object }

export const isRuntimePatch = (root: Descriptor, input: unknown): input is RuntimePatch => {
  const pending: Array<GuardFrame> = [{ _tag: "Enter", descriptor: root, patch: input, allowRemove: false }]
  const active = new WeakSet<object>()
  while (pending.length > 0) {
    const frame = pending.pop() as GuardFrame
    if (frame._tag === "Leave") {
      active.delete(frame.patch)
      continue
    }
    const { allowRemove, descriptor, patch } = frame
    if (!Predicate.isObject(patch) || typeof patch._tag !== "string") return false
    switch (patch._tag) {
      case "Empty":
        if (!hasExactKeys(patch, ["_tag"])) return false
        break
      case "Replace":
        if (!hasExactKeys(patch, ["_tag", "value"]) || !descriptor.value(patch.value)) return false
        break
      case "Append":
        if (!hasExactKeys(patch, ["_tag", "value"])) return false
        if (descriptor.kind === "string") {
          if (typeof patch.value !== "string") return false
        } else if (descriptor.kind === "array") {
          if (!Array.isArray(patch.value) || !patch.value.every(descriptor.appendElement as (input: unknown) => boolean)) {
            return false
          }
        } else return false
        break
      case "Remove":
        if (!allowRemove || !hasExactKeys(patch, ["_tag"])) return false
        break
      case "Struct": {
        if (
          !hasExactKeys(patch, ["_tag", "fields"]) ||
          descriptor.fields === undefined ||
          !Predicate.isObject(patch.fields) ||
          active.has(patch)
        ) return false
        active.add(patch)
        pending.push({ _tag: "Leave", patch })
        for (const key of Reflect.ownKeys(patch.fields)) {
          if (typeof key !== "string") return false
          const field = descriptor.fields.get(key)
          if (field === undefined) return false
          pending.push({
            _tag: "Enter",
            descriptor: field.descriptor,
            patch: patch.fields[key],
            allowRemove: field.optional
          })
        }
        break
      }
      case "Sequence":
        if (!hasExactKeys(patch, ["_tag", "first", "second"]) || active.has(patch)) return false
        active.add(patch)
        pending.push(
          { _tag: "Leave", patch },
          { _tag: "Enter", descriptor, patch: patch.second, allowRemove: false },
          { _tag: "Enter", descriptor, patch: patch.first, allowRemove: false }
        )
        break
      default:
        return false
    }
  }
  return true
}

const define = (target: object, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value })
}

const fieldsRecord = <A>(): Record<string, A> => Object.create(null) as Record<string, A>

const exact = <S extends Schema.Top>(schema: S): S =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } }) as S

const hasUnannotatedDeclaration = (root: SchemaAST.AST): boolean => {
  const pending = [root]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const ast = pending.pop() as SchemaAST.AST
    if (seen.has(ast)) continue
    seen.add(ast)
    switch (ast._tag) {
      case "Declaration":
        if (ast.annotations?.toCodecJson === undefined && ast.annotations?.toCodec === undefined) return true
        pending.push(...ast.typeParameters)
        break
      case "Arrays":
        pending.push(...ast.elements, ...ast.rest)
        break
      case "Objects":
        for (const property of ast.propertySignatures) pending.push(property.type)
        for (const index of ast.indexSignatures) pending.push(index.parameter, index.type)
        break
      case "Union":
        pending.push(...ast.types)
        break
      case "Suspend":
        pending.push(ast.thunk())
        break
    }
  }
  return false
}

const canonicalJson = (schema: Schema.Top): Schema.Codec<unknown, Schema.Json> => {
  const typeSchema = Schema.toType(schema)
  if (hasUnannotatedDeclaration(typeSchema.ast)) return Schema.Never as Schema.Codec<unknown, Schema.Json>
  try {
    return Schema.toCodecJson(typeSchema).annotate({
      parseOptions: { onExcessProperty: "ignore" }
    }) as Schema.Codec<unknown, Schema.Json>
  } catch {
    return Schema.Never as Schema.Codec<unknown, Schema.Json>
  }
}

type WireOperation =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Replace"; readonly value: unknown }
  | { readonly _tag: "Append"; readonly value: string | ReadonlyArray<unknown> }
  | { readonly _tag: "Remove" }
  | { readonly _tag: "Struct"; readonly fields: Readonly<Record<string, WirePatch>> }
type WirePatch = WireOperation | { readonly _tag: "Sequence"; readonly patches: ReadonlyArray<WireOperation> }

const decodeWirePatch = (wire: WirePatch): RuntimePatch => {
  if (wire._tag === "Struct") {
    const fields = fieldsRecord<RuntimePatch>()
    for (const key of Object.keys(wire.fields)) define(fields, key, decodeWirePatch(wire.fields[key]))
    return { _tag: "Struct", fields }
  }
  if (wire._tag !== "Sequence") return wire
  let level = wire.patches.map(decodeWirePatch)
  while (level.length > 1) {
    const next: Array<RuntimePatch> = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length
        ? { _tag: "Sequence", first: level[index], second: level[index + 1] }
        : level[index])
    }
    level = next
  }
  return level[0]
}

const encodeWirePatch = (patch: RuntimePatch): WirePatch => {
  if (patch._tag === "Sequence") {
    const patches: Array<WireOperation> = []
    const pending: Array<RuntimePatch> = [patch]
    while (pending.length > 0) {
      const current = pending.pop() as RuntimePatch
      if (current._tag === "Sequence") pending.push(current.second, current.first)
      else patches.push(encodeWirePatch(current) as WireOperation)
    }
    return { _tag: "Sequence", patches }
  }
  if (patch._tag === "Struct") {
    const fields = fieldsRecord<WirePatch>()
    for (const key of Object.keys(patch.fields)) define(fields, key, encodeWirePatch(patch.fields[key]))
    return { _tag: "Struct", fields }
  }
  return patch
}

export const derivePatchSchema = (descriptor: Descriptor): Schema.Codec<RuntimePatch, Schema.Json> => {
  const members: Array<Schema.Top> = [
    exact(Schema.TaggedStruct("Empty", {})),
    exact(Schema.TaggedStruct("Replace", { value: canonicalJson(descriptor.schema) }))
  ]
  if (descriptor.kind === "string") {
    members.push(exact(Schema.TaggedStruct("Append", { value: Schema.String })))
  } else if (descriptor.kind === "array") {
    members.push(exact(Schema.TaggedStruct("Append", {
      value: Schema.Array(canonicalJson(descriptor.appendSchema as Schema.Top))
    })))
  } else if (descriptor.fields !== undefined) {
    const fields: Schema.Struct.Fields = Object.create(null) as Schema.Struct.Fields
    for (const [name, field] of descriptor.fields) {
      const patch = derivePatchSchema(field.descriptor)
      define(fields, name, Schema.optionalKey(field.optional
        ? Schema.Union([patch, exact(Schema.TaggedStruct("Remove", {}))])
        : patch))
    }
    members.push(exact(Schema.TaggedStruct("Struct", { fields: exact(Schema.Struct(fields)) })))
  }
  const operation = Schema.Union(members) as unknown as Schema.Codec<WireOperation, Schema.Json>
  const sequence = exact(Schema.TaggedStruct("Sequence", {
    patches: Schema.Array(operation).check(Schema.isMinLength(2))
  }))
  const wire = Schema.Union([operation, sequence]) as unknown as Schema.Codec<WirePatch, Schema.Json>
  const runtime = Schema.declare<RuntimePatch>(
    (input): input is RuntimePatch => isRuntimePatch(descriptor, input),
    { identifier: "effect-delta/Patch", message: "Invalid effect-delta runtime patch" }
  )
  return wire.pipe(Schema.decodeTo(runtime, SchemaTransformation.transform({
    decode: decodeWirePatch,
    encode: encodeWirePatch
  }))) as Schema.Codec<RuntimePatch, Schema.Json>
}
