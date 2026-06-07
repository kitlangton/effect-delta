# effect-delta

Schema-derived, compositional patches for Effect.

Derive a patch from two decoded values, or directly control the operation:

```ts
import { Schema } from "effect"
import * as Delta from "effect-delta"

const Message = Schema.Struct({ text: Schema.String })
const MessageDelta = Delta.make(Message)

const derived = MessageDelta.diff({ text: "hello" }, { text: "hello world" })
// { _tag: "Struct", fields: { text: { _tag: "Replace", value: "hello world" } } }

const controlled = MessageDelta.fromUpdate({ text: Delta.append(" world") })
MessageDelta.patch({ text: "hello" }, controlled)
// { text: "hello world" }
```

`Delta.make(schema)` implements Effect's `Differ.Differ<Value, Patch>` and adds
`fromUpdate`. Automatic string and array diffs conservatively replace. Append is
explicit and is supported by string and variable-length array schemas. Checked
strings, arrays, and plain non-empty structs retain these operations when the
final patched value satisfies the schema. Symbol-keyed and other unsupported
struct shapes use replacement.

Use `Delta.replace(value)` to replace a whole value, including a value whose
fields look like patch tags. Use `Delta.remove()` only for optional struct
fields. `fromUpdate` converts these unambiguous authoring commands into plain,
inspectable tagged patch objects.

Version 0.1 does not expose a patch Schema. Validate external patch data with a
Schema or another boundary validator before passing it to `patch`; unsupported
or malformed operations may throw. Every patched result is synchronously
validated against the decoded schema.
