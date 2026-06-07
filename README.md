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

const encoded = Schema.encodeSync(AssistantMessageDelta.schema)(controlled)
const decoded = Schema.decodeUnknownSync(AssistantMessageDelta.schema)(encoded)
AssistantMessageDelta.patch(message, decoded)
```

## Streaming over Effect RPC

For an assistant message with nested content, usage, citations, and status, the
backend can author patches directly and stream them to the frontend:

```ts
// backend
const patch = AssistantMessageDelta.fromUpdate({
  content: { text: Delta.append(chunk) }
})
yield* Queue.offer(outgoing, patch)

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
contract, backend handler, and frontend consumer. The RPC success schema is
`AssistantMessageDelta.schema`, so RPC validates patches at the transport
boundary.

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

`delta.schema` is a `Schema.Codec<Patch, Schema.Json>` for RPC and other JSON
boundaries. Binary runtime sequences encode as one flat array and decode to an
equivalent runtime tree: codec roundtrips preserve patch application, not tree
identity. Replacement transport follows the value Schema's canonical JSON codec
and may normalize decoded values, such as stripping accepted excess object
properties. Encoding can still fail when that codec cannot represent a decoded
value as JSON. Accessing `delta.schema` itself is total; unsupported canonical
payloads fail when the corresponding Replace value is encoded or decoded.
Unannotated declarations fail canonical transport unless they provide Effect
`toCodecJson` or `toCodec` annotations; lossy `null` output is never emitted.
Every patched result is also synchronously validated against the decoded value
schema.
