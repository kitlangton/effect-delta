import { Cause, Effect, Queue, Schema, Stream } from "effect"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as Delta from "effect-delta"

// Shared application state.
const AssistantMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("assistant"),
  content: Schema.Struct({
    text: Schema.String,
    citations: Schema.Array(Schema.String)
  }),
  usage: Schema.Struct({ outputTokens: Schema.Number }),
  status: Schema.Literals(["streaming", "complete"])
})
const AssistantMessageDelta = Delta.make(AssistantMessage)

class StreamAssistantMessage extends Rpc.make("StreamAssistantMessage", {
  payload: { messageId: Schema.String },
  success: AssistantMessageDelta.schema,
  stream: true
}) {}

export const MessageRpcs = RpcGroup.make(StreamAssistantMessage)

// Backend: author semantic patches directly from model events.
export const MessageRpcsLive = MessageRpcs.toLayer(Effect.gen(function*() {
  return MessageRpcs.of({
    StreamAssistantMessage: Effect.fnUntraced(function*() {
      const outgoing = yield* Queue.unbounded<typeof AssistantMessageDelta.schema.Type, Cause.Done>()
      const send = (patch: typeof AssistantMessageDelta.schema.Type) => Queue.offer(outgoing, patch)

      yield* Effect.forEach(["Effect", " RPC", " streams patches."], (chunk) =>
        send(AssistantMessageDelta.fromUpdate({
          content: { text: Delta.append(chunk) }
        }))).pipe(
          Effect.andThen(send(AssistantMessageDelta.fromUpdate({
            content: { citations: Delta.append(["https://effect.website"]) },
            usage: { outputTokens: 6 },
            status: "complete"
          }))),
          Effect.andThen(Queue.end(outgoing)),
          Effect.forkScoped
        )

      return outgoing
    })
  })
}))

// Frontend: apply every patch to one local message.
// `client` comes from `RpcClient.make(MessageRpcs)`.
export const consumeMessage = (
  client: {
    readonly StreamAssistantMessage: (
      payload: { readonly messageId: string }
    ) => Stream.Stream<typeof AssistantMessageDelta.schema.Type>
  }
) =>
  Effect.gen(function*() {
    let message: typeof AssistantMessage.Type = {
      id: "msg-1",
      role: "assistant",
      content: { text: "", citations: [] },
      usage: { outputTokens: 0 },
      status: "streaming"
    }

    yield* client.StreamAssistantMessage({ messageId: message.id }).pipe(
      Stream.runForEach((patch) =>
        Effect.sync(() => {
          message = AssistantMessageDelta.patch(message, patch)
        })
      )
    )

    return message
  })
