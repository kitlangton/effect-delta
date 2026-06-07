# effect-delta

Schema-derived, compositional patches for Effect.

Derive a patch from two decoded values, or directly control the operation:

```ts
import { Schema } from "effect"
import * as Delta from "effect-delta"

const AssistantMessage = Schema.Struct({
  id: Schema.String,
  content: Schema.Struct({
    text: Schema.String,
    citations: Schema.Array(Schema.String)
  }),
  usage: Schema.Struct({ outputTokens: Schema.Number }),
  status: Schema.Literals(["streaming", "complete"])
})
const AssistantMessageDelta = Delta.make(AssistantMessage)

const message: typeof AssistantMessage.Type = {
  id: "msg-1",
  content: { text: "Hello", citations: [] },
  usage: { outputTokens: 1 },
  status: "streaming"
}

// Derive a sparse patch from two snapshots.
const derived = AssistantMessageDelta.diff(message, {
  ...message,
  usage: { outputTokens: 2 },
  status: "complete"
})

// Or author the operations directly when you already know what happened.
const controlled = AssistantMessageDelta.fromUpdate({
  content: {
    text: Delta.append(", world!"),
    citations: Delta.append(["https://effect.website"])
  },
  usage: { outputTokens: 3 },
  status: "complete"
})

AssistantMessageDelta.patch(message, controlled)
// {
//   id: "msg-1",
//   content: {
//     text: "Hello, world!",
//     citations: ["https://effect.website"]
//   },
//   usage: { outputTokens: 3 },
//   status: "complete"
// }
```

## Streaming over Effect RPC

For an assistant message with nested content, usage, citations, and status, the
backend can author patches directly and stream them to the frontend:

```ts
// backend
const patch = AssistantMessageDelta.fromUpdate({
  content: { text: Delta.append(chunk) }
})
yield* Queue.offer(outgoing, Schema.decodeUnknownSync(PatchWire)(patch))

// frontend
yield* client.StreamMessage().pipe(
  Stream.runForEach((patch) =>
    Effect.sync(() => {
      message = AssistantMessageDelta.patch(message, patch)
    })
  )
)
```

See [`examples/effect-rpc.ts`](./examples/effect-rpc.ts) for the shared RPC
contract, backend handler, and frontend consumer. The example defines a small
wire Schema for the patch subset accepted by that endpoint, so RPC validates
patches at the transport boundary.

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
