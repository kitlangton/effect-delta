# effect-delta

`effect-delta` will explore schema-derived, compositional patches for Effect Small.

## Starting Point

Effect Small already defines the core algebra:

```ts
interface Differ<Value, Patch> {
  readonly empty: Patch
  readonly diff: (oldValue: Value, newValue: Value) => Patch
  readonly combine: (first: Patch, second: Patch) => Patch
  readonly patch: (oldValue: Value, patch: Patch) => Value
}
```

It also provides `Schema.toDifferJsonPatch`, which derives patches through a
schema's canonical JSON representation.

The original Scala `delta` library instead derived specialized patches from a
datatype's algebraic structure. Its central round-trip law was:

```ts
differ.patch(before, differ.diff(before, after)) === after
```

## Design Goal

`effect-delta` should provide schema-directed, compositional patches beyond
canonical JSON Patch. Patches must support both:

- derivation by comparing an old and new value
- direct construction when the producer already knows which operation occurred

The motivating example is streaming data: a producer should be able to emit an
append operation for a particular field without retaining an old snapshot and
diffing it against a new snapshot.

Automatic string diffing uses replacement by default. Detecting whether one
string extends another requires scanning the existing prefix, can become
quadratic across repeated growing snapshots, and guesses producer intent.
Append is therefore an explicitly authored operation for producers that already
know they received a suffix.

## Decisions For 0.1

1. Patches operate on decoded Schema values.
2. `Delta.make(schema)` returns an Effect `Differ` plus `fromUpdate` for direct,
   schema-shaped construction. Application uses the canonical Differ `patch`.
3. Authoring commands are symbol-marked and cannot collide with domain values.
   Emitted patches are plain tagged data: Empty, Replace, Append, Remove,
   Struct, and Sequence.
4. Empty is an identity, derived patches roundtrip, and combine applies its
   operands sequentially from left to right.
5. Non-empty, string-keyed plain structs recurse and preserve optional field
   presence. Strings and variable-length arrays support explicit append;
   attached checks do not remove these structural operations because the final
   decoded result is validated against the original schema. Automatic changes
   conservatively replace. Empty or symbol-keyed structs, unions, declarations,
   transforms, index signatures, primitives, unknown values, and other
   unsupported shapes use replacement.
6. Replacement is the universal fallback and can also be authored explicitly.
7. Patches are trusted typed values. A patch Schema and external-data validation
   are deferred until they can be derived faithfully.

## Status

Initial 0.1 implementation complete and publication checks covered. Checked
schemas retain safe structural authoring and reject invalid final values.
Literals, templates, brands, tuples, symbol-keyed structs, and unsupported
shapes are rejected statically. Recursive and custom derivation, patch Schemas,
and schema-evolution guarantees remain future work.
