import type { Differ } from "effect"
import { Predicate, Record as EffectRecord, Schema } from "effect"
import {
  deriveDescriptor,
  derivePatchSchema,
  isRuntimePatch,
  type Descriptor,
  type RuntimePatch
} from "./internal/patchSchema.ts"

/** A patch that leaves its input unchanged. */
export interface Empty {
  readonly _tag: "Empty"
}

/** A patch that replaces its input. */
export interface Replace<A> {
  readonly _tag: "Replace"
  readonly value: A
}

/** An explicitly authored append operation. */
export interface Append<A extends string | ReadonlyArray<unknown>> {
  readonly _tag: "Append"
  readonly value: A
}

/** A patch that removes an optional struct field. */
export interface Remove {
  readonly _tag: "Remove"
}

type FieldPatch<S extends Schema.Top> = Patch<S> | (S extends { readonly "~type.optionality": "optional" } ? Remove
  : never)

/** A patch for the named fields of a struct. */
export interface StructPatch<Fields extends Schema.Struct.Fields> {
  readonly _tag: "Struct"
  readonly fields: { readonly [K in keyof Fields]?: FieldPatch<Fields[K]> }
}

/** Patches applied sequentially from left to right. */
export interface Sequence<S extends Schema.Top> {
  readonly _tag: "Sequence"
  readonly first: Patch<S>
  readonly second: Patch<S>
}

type StringKeyedStruct<Fields extends Schema.Struct.Fields, A> =
  Extract<keyof Fields, symbol> extends never ? keyof Fields extends never ? never : A : never

type SpecificPatch<S extends Schema.Top> =
  S extends Schema.String ? Schema.String extends S ? Append<string> : never
    : S extends Schema.$Array<infer Item> ? Append<ReadonlyArray<Item["Type"]>>
    : S extends Schema.Struct<infer Fields> ? StringKeyedStruct<Fields, StructPatch<Fields>>
    : never

/** The tagged patch data emitted for a particular schema. */
export type Patch<S extends Schema.Top> = Empty | Replace<S["Type"]> | SpecificPatch<S> | Sequence<S>

const commandTypeId: unique symbol = Symbol("effect-delta/Command")

interface ReplaceCommand<A> {
  readonly [commandTypeId]: "Replace"
  readonly value: A
}

interface AppendCommand<A extends string | ReadonlyArray<unknown>> {
  readonly [commandTypeId]: "Append"
  readonly value: A
}

interface RemoveCommand {
  readonly [commandTypeId]: "Remove"
}

type FieldUpdate<S extends Schema.Top> =
  | ReplaceCommand<S["Type"]>
  | (S extends Schema.String ? S["Type"] | (Schema.String extends S ? AppendCommand<string> : never)
    : S extends Schema.$Array<infer Item> ? S["Type"] | AppendCommand<ReadonlyArray<Item["Type"]>>
    : S extends Schema.Struct<infer Fields> ? StringKeyedStruct<Fields, StructUpdate<Fields>>
    : S["Type"])
  | (S extends { readonly "~type.optionality": "optional" } ? RemoveCommand : never)

/** A schema-shaped direct update for a struct. */
export type StructUpdate<Fields extends Schema.Struct.Fields> = {
  readonly [K in keyof Fields]?: FieldUpdate<Fields[K]>
}

type RootUpdate<S extends Schema.Top> =
  | ReplaceCommand<S["Type"]>
  | (S extends Schema.String ? Schema.String extends S ? AppendCommand<string> : never
    : S extends Schema.$Array<infer Item> ? AppendCommand<ReadonlyArray<Item["Type"]>>
    : S extends Schema.Struct<infer Fields> ? StringKeyedStruct<Fields, StructUpdate<Fields>>
    : never)

/** A schema-derived Effect Differ with direct authoring support. */
export interface Delta<S extends Schema.Schema<unknown>> extends Differ.Differ<S["Type"], Patch<S>> {
  /** Schema for exactly the patch values accepted by this delta. */
  readonly schema: Schema.Codec<Patch<S>, Schema.Json>
  /** Converts an unambiguous authoring command or struct update into patch data. */
  readonly fromUpdate: (update: RootUpdate<S>) => Patch<S>
}

const empty: Empty = { _tag: "Empty" }

/** Authors an explicit replacement. */
export const replace = <A>(value: A): ReplaceCommand<A> => ({ [commandTypeId]: "Replace", value })

/** Authors an append, accepted only where the target schema supports it. */
export const append = <A extends string | ReadonlyArray<unknown>>(value: A): AppendCommand<A> => ({
  [commandTypeId]: "Append",
  value
})

/** Authors removal of an optional struct field. */
export const remove = (): RemoveCommand => ({ [commandTypeId]: "Remove" })

interface RuntimeDelta {
  readonly kind: "replace" | "string" | "array" | "struct"
  readonly diff: (oldValue: unknown, newValue: unknown) => RuntimePatch
  readonly fromFieldUpdate: (update: unknown) => RuntimePatch
  readonly patchOne: (oldValue: unknown, patch: RuntimePatch) => unknown
}

interface RuntimeField {
  readonly delta: RuntimeDelta
  readonly optional: boolean
}

const fail = (message: string): never => {
  throw new TypeError(`effect-delta: ${message}`)
}

const command = (input: unknown): "Replace" | "Append" | "Remove" | undefined =>
  Predicate.isObject(input) ? input[commandTypeId] as "Replace" | "Append" | "Remove" | undefined : undefined

const hasOwn = (input: unknown, key: PropertyKey): input is object =>
  Predicate.isObject(input) && Object.hasOwn(input, key)

const ownValue = (input: object, key: string): unknown =>
  Object.hasOwn(input, key) ? (input as Record<string, unknown>)[key] : undefined

const define = (target: object, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  })
}

const clone = (input: object): Record<string, unknown> => {
  const output = Object.create(Object.getPrototypeOf(input)) as Record<string, unknown>
  for (const key of Reflect.ownKeys(input)) define(output, key, (input as Record<PropertyKey, unknown>)[key])
  return output
}

const makeFields = (): Record<string, RuntimePatch> => Object.create(null) as Record<string, RuntimePatch>

const apply = (delta: RuntimeDelta, oldValue: unknown, patch: RuntimePatch): unknown => {
  let value = oldValue
  const pending = [patch]
  while (pending.length > 0) {
    const current = pending.pop() as RuntimePatch
    if (current._tag === "Sequence") {
      pending.push(current.second, current.first)
    } else {
      value = delta.patchOne(value, current)
    }
  }
  return value
}

const fromCommand = (delta: RuntimeDelta, input: unknown): RuntimePatch | undefined => {
  switch (command(input)) {
    case "Replace":
      if (!hasOwn(input, "value")) return fail("malformed replacement command")
      return { _tag: "Replace", value: (input as ReplaceCommand<unknown>).value }
    case "Append": {
      if (!hasOwn(input, "value")) return fail("malformed append command")
      const value = (input as AppendCommand<string | ReadonlyArray<unknown>>).value
      if (delta.kind === "string" && typeof value === "string") return value.length === 0 ? empty : { _tag: "Append", value }
      if (delta.kind === "array" && Array.isArray(value)) return value.length === 0 ? empty : { _tag: "Append", value }
      return fail("Append is not supported by this schema")
    }
    case "Remove":
      return { _tag: "Remove" }
    default:
      return undefined
  }
}

const derive = (descriptor: Descriptor): RuntimeDelta => {
  if (descriptor.fields !== undefined) {
    const fields = new Map<string, RuntimeField>()
    for (const [name, field] of descriptor.fields) {
      fields.set(name, {
        delta: derive(field.descriptor),
        optional: field.optional
      })
    }

    const diff = (oldValue: unknown, newValue: unknown): RuntimePatch => {
      if (Object.is(oldValue, newValue)) return empty
      if (!Predicate.isObject(oldValue) || !Predicate.isObject(newValue)) return { _tag: "Replace", value: newValue }
      if (Object.getPrototypeOf(oldValue) !== Object.getPrototypeOf(newValue)) return { _tag: "Replace", value: newValue }
      const excessKeys = new Set([...Reflect.ownKeys(oldValue), ...Reflect.ownKeys(newValue)])
      for (const key of excessKeys) {
        if (typeof key === "string" && fields.has(key)) continue
        if (
          Object.hasOwn(oldValue, key) !== Object.hasOwn(newValue, key) ||
          !Object.is(oldValue[key], newValue[key])
        ) {
          return { _tag: "Replace", value: newValue }
        }
      }
      const changes = makeFields()
      for (const [name, field] of fields) {
        const hadOld = Object.hasOwn(oldValue, name)
        const hasNew = Object.hasOwn(newValue, name)
        if (hadOld && !hasNew) {
          if (!field.optional) return { _tag: "Replace", value: newValue }
          define(changes, name, { _tag: "Remove" })
        } else if (!hadOld && hasNew) {
          define(changes, name, { _tag: "Replace", value: ownValue(newValue, name) })
        } else if (hadOld) {
          const change = field.delta.diff(ownValue(oldValue, name), ownValue(newValue, name))
          if (change._tag !== "Empty") define(changes, name, change)
        }
      }
      return EffectRecord.isEmptyReadonlyRecord(changes) ? empty : { _tag: "Struct", fields: changes }
    }

    const fromFieldUpdate = (input: unknown): RuntimePatch => {
      const authored = fromCommand(runtime, input)
      if (authored !== undefined) return authored
      if (!Predicate.isObject(input)) return fail("a struct update must be an object or Delta.replace(value)")
      const changes = makeFields()
      for (const name of Object.keys(input)) {
        const field = fields.get(name)
        if (field === undefined) return fail(`unknown struct field ${JSON.stringify(name)}`)
        const value = ownValue(input, name)
        if (command(value) === "Remove" && !field.optional) return fail(`cannot remove required field ${JSON.stringify(name)}`)
        const change = field.delta.fromFieldUpdate(value)
        if (change._tag !== "Empty") define(changes, name, change)
      }
      return EffectRecord.isEmptyReadonlyRecord(changes) ? empty : { _tag: "Struct", fields: changes }
    }

    const patchOne = (oldValue: unknown, patch: RuntimePatch): unknown => {
      switch (patch._tag) {
        case "Empty":
          return oldValue
        case "Replace":
          return patch.value
        case "Struct": {
          if (!Predicate.isObject(oldValue)) return fail("cannot apply a Struct patch to a non-object")
          let output: Record<string, unknown> | undefined
          for (const name of Object.keys(patch.fields)) {
            const field = fields.get(name)
            if (field === undefined) continue
            const rawFieldPatch = ownValue(patch.fields, name)
            const fieldPatch = rawFieldPatch as RuntimePatch
            if (fieldPatch._tag === "Remove") {
              if (Object.hasOwn(oldValue, name)) {
                output ??= clone(oldValue)
                delete output[name]
              }
              continue
            }
            const previous = ownValue(oldValue, name)
            const next = apply(field.delta, previous, fieldPatch)
            if (!Object.hasOwn(oldValue, name) || !Object.is(previous, next)) {
              output ??= clone(oldValue)
              define(output, name, next)
            }
          }
          return output ?? oldValue
        }
        case "Append":
          return fail("Append is not supported by a struct schema")
        case "Remove":
          return fail("Remove is only valid inside an optional struct field")
        case "Sequence":
          return fail("nested Sequence must be applied through the sequence interpreter")
        default:
          return fail("unknown patch operation")
      }
    }

    const runtime: RuntimeDelta = { kind: "struct", diff, fromFieldUpdate, patchOne }
    return runtime
  }

  const kind = descriptor.kind
  const diff = (oldValue: unknown, newValue: unknown): RuntimePatch =>
    Object.is(oldValue, newValue) ? empty : { _tag: "Replace", value: newValue }
  const runtime: RuntimeDelta = {
    kind,
    diff,
    fromFieldUpdate(input) {
      const authored = fromCommand(runtime, input)
      return authored ?? { _tag: "Replace", value: input }
    },
    patchOne(oldValue, patch) {
      switch (patch._tag) {
        case "Empty":
          return oldValue
        case "Replace":
          return patch.value
        case "Append":
          if (kind === "string" && typeof oldValue === "string" && typeof patch.value === "string") {
            return patch.value.length === 0 ? oldValue : oldValue + patch.value
          }
          if (kind === "array" && Array.isArray(oldValue) && Array.isArray(patch.value)) {
            return patch.value.length === 0 ? oldValue : [...oldValue, ...patch.value]
          }
          return fail("invalid Append patch for this schema or value")
        case "Struct":
          return fail("Struct is not supported by this schema")
        case "Remove":
          return fail("Remove is only valid inside an optional struct field")
        case "Sequence":
          return fail("nested Sequence must be applied through the sequence interpreter")
        default:
          return fail("unknown patch operation")
      }
    }
  }
  return runtime
}

/** Derives a delta from the decoded shape of an Effect Schema. */
export const make = <S extends Schema.Schema<unknown>>(schema: S): Delta<S> => {
  const descriptor = deriveDescriptor(schema)
  const runtime = derive(descriptor)
  let patchSchema: Schema.Codec<Patch<S>, Schema.Json> | undefined
  const combine = (first: RuntimePatch, second: RuntimePatch): RuntimePatch => {
    if (first._tag === "Empty") return second
    if (second._tag === "Empty") return first
    return { _tag: "Sequence", first, second }
  }
  const validate = (value: unknown): S["Type"] => {
    try {
      Schema.asserts(schema, value)
      return value
    } catch (cause) {
      throw new TypeError("effect-delta: patched value does not satisfy the schema", { cause })
    }
  }
  return {
    empty: empty as Patch<S>,
    get schema() {
      return patchSchema ??= derivePatchSchema(descriptor) as Schema.Codec<Patch<S>, Schema.Json>
    },
    diff: runtime.diff as Delta<S>["diff"],
    combine: combine as Delta<S>["combine"],
    patch: ((oldValue, patch) => {
      if (!isRuntimePatch(descriptor, patch)) return fail("malformed patch")
      return validate(apply(runtime, oldValue, patch))
    }) as Delta<S>["patch"],
    fromUpdate: runtime.fromFieldUpdate as Delta<S>["fromUpdate"]
  }
}
