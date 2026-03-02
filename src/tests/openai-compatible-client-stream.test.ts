import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleClient } from "../agents/openai-compatible-client";

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
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run_"}}]}}]}\n\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"command","arguments":"{\\"command\\":\\"echo"}}]}}]}\n\n'
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
    assert.equal(result.message.tool_calls?.[0]?.function.name, "run_command");
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

    assert.equal(fetchCount, 2);
    assert.equal(streamDeltaCalled, false);
    assert.equal(result.message.content, "fallback message");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
