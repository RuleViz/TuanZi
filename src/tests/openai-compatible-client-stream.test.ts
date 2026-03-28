import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleClient } from "../agents/openai-compatible-client";
import { InterruptedAssistantMessageError } from "../agents/model-types";

test("OpenAICompatibleClient should emit streaming content deltas", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"World"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        }
      });
    };

    const client = new OpenAICompatibleClient({
      baseUrl: "https://example.com/v1",
      apiKey: "demo-key"
    });

    let collected = "";
    const result = await client.complete(
      {
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }]
      },
      {
        onContentDelta: (delta) => {
          collected += delta;
        }
      }
    );

    assert.equal(collected, "Hello World");
    assert.equal(result.message.content, "Hello World");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleClient should assemble streamed tool calls", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ba"}}]}}]}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"sh","arguments":"{\\"command\\":\\"echo"}}]}}]}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" hi\\"}"}}]}}]}\n\n'
            )
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        }
      });
    };

    const client = new OpenAICompatibleClient({
      baseUrl: "https://example.com/v1",
      apiKey: "demo-key"
    });

    const result = await client.complete(
      {
        model: "demo-model",
        messages: [{ role: "user", content: "run command" }]
      },
      {
        onContentDelta: () => {
          // ignore
        }
      }
    );

    assert.equal(result.message.role, "assistant");
    assert.equal(result.message.content, "");
    assert.equal(result.message.tool_calls?.length, 1);
    assert.equal(result.message.tool_calls?.[0]?.id, "call_1");
    assert.equal(result.message.tool_calls?.[0]?.function.name, "bash");
    assert.equal(result.message.tool_calls?.[0]?.function.arguments, '{"command":"echo hi"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleClient should fallback to non-stream on stream failure", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = async (_input, init) => {
      fetchCount += 1;
      const parsedBody =
        init && typeof init.body === "string"
          ? (JSON.parse(init.body) as { stream?: boolean })
          : {};
      if (parsedBody.stream === true) {
        throw new Error("stream unavailable");
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "fallback message"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    };

    const client = new OpenAICompatibleClient({
      baseUrl: "https://example.com/v1",
      apiKey: "demo-key"
    });

    let streamDeltaCalled = false;
    const result = await client.complete(
      {
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }]
      },
      {
        onContentDelta: () => {
          streamDeltaCalled = true;
        }
      }
    );

    assert.equal(fetchCount, 4);
    assert.equal(streamDeltaCalled, false);
    assert.equal(result.message.content, "fallback message");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleClient should surface partial streamed content on interruption", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      let readCount = 0;
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                if (readCount === 0) {
                  readCount += 1;
                  return {
                    done: false,
                    value: encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{"content":"partial "}}]}\n\n')
                  };
                }
                const error = new Error("aborted");
                error.name = "AbortError";
                throw error;
              }
            };
          }
        }
      } as unknown as Response;
    };

    const client = new OpenAICompatibleClient({
      baseUrl: "https://example.com/v1",
      apiKey: "demo-key"
    });

    await assert.rejects(
      () => client.complete(
        {
          model: "demo-model",
          messages: [{ role: "user", content: "hi" }]
        },
        {
          onContentDelta: () => {
            // ignore
          }
        }
      ),
      (error) => {
        assert(error instanceof InterruptedAssistantMessageError);
        assert.equal(error.partialMessage.content, "partial ");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleClient should assemble streamed reasoning_content", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"step-1 "}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"step-2"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        }
      });
    };

    const client = new OpenAICompatibleClient({
      baseUrl: "https://example.com/v1",
      apiKey: "demo-key"
    });

    const result = await client.complete(
      {
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }]
      },
      {
        onContentDelta: () => {
          // ignore
        }
      }
    );

    assert.equal(result.message.content, "done");
    assert.equal(result.message.reasoning_content, "step-1 step-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleClient should send default reasoning and thinking options", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = async (_input, init) => {
      capturedBody =
        init && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    };

    const client = new OpenAICompatibleClient({
      baseUrl: "https://example.com/v1",
      apiKey: "demo-key",
      defaultRequestOptions: {
        reasoningEffort: "medium",
        thinking: {
          type: "enabled",
          budget_tokens: 4096
        },
        extraBody: {
          enable_thinking: true
        }
      }
    });

    await client.complete({
      model: "demo-model",
      messages: [{ role: "user", content: "hi" }]
    });

    assert.equal(capturedBody?.["reasoning_effort"], "medium");
    assert.deepEqual(capturedBody?.["thinking"], {
      type: "enabled",
      budget_tokens: 4096
    });
    assert.equal(capturedBody?.["enable_thinking"], true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAICompatibleClient should strip local isMeta field before sending messages", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = async (_input, init) => {
      capturedBody =
        init && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "ok"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    };

    const client = new OpenAICompatibleClient({
      baseUrl: "https://example.com/v1",
      apiKey: "demo-key"
    });

    await client.complete({
      model: "demo-model",
      messages: [
        { role: "system", content: "sys", isMeta: true },
        { role: "user", content: "hello" }
      ]
    });

    const sentMessages = (capturedBody?.["messages"] ?? []) as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(sentMessages), true);
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].isMeta, undefined);
    assert.equal(sentMessages[0].content, "sys");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
