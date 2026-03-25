import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const base = process.cwd();
const streamListenersSource = readFileSync(
  join(base, "src", "renderer", "src", "features", "chat", "stream-listeners.ts"),
  "utf8"
);
const messageRenderSource = readFileSync(
  join(base, "src", "renderer", "src", "features", "chat", "message-render.ts"),
  "utf8"
);
const sendMessageSource = readFileSync(
  join(base, "src", "renderer", "src", "features", "chat", "send-message.ts"),
  "utf8"
);
const ipcContractsSource = readFileSync(
  join(base, "src", "shared", "ipc-contracts.ts"),
  "utf8"
);
const chatResumeStoreSource = readFileSync(
  join(base, "src", "main", "chat-resume-store.ts"),
  "utf8"
);
const chatTaskServiceSource = readFileSync(
  join(base, "src", "main", "services", "chat-task-service.ts"),
  "utf8"
);

// Step 1: Thinking chain collapse/expand regression
test("streaming thinking listener sets dataset.expandedContent during accumulation", () => {
  assert.match(
    streamListenersSource,
    /thinkingBlock\.block\.dataset\.expandedContent\s*=\s*currentSegmentThinkingText/,
    "onThinking handler must sync expandedContent with accumulated text"
  );
});

test("finalizeThinkingBlock persists output to dataset.expandedContent", () => {
  assert.match(
    streamListenersSource,
    /thinkingBlock\.block\.dataset\.expandedContent\s*=\s*thinkingBlock\.output\.textContent/,
    "finalizeThinkingBlock must copy textContent into dataset.expandedContent"
  );
});

test("finalizeThinkingBlock settles the last thinking title using stored segment timing", () => {
  assert.match(
    streamListenersSource,
    /dataset\.thinkingStartedAt/,
    "Thinking blocks must store a segment start timestamp for final settlement"
  );
  assert.match(
    streamListenersSource,
    /Thought for \$\{elapsed\}s/,
    "Last thinking segment should settle from Thinking... to a completed title"
  );
});

test("addAssistantMessage sets dataset.expandedContent for historical thinking blocks", () => {
  assert.match(
    messageRenderSource,
    /block\.dataset\.expandedContent\s*=\s*segment/,
    "Historical thinking block must have expandedContent set"
  );
});

// Step 2: reasoning_content / thinking field mismatch
test("ChatMessageSnapshot includes reasoning_content field", () => {
  assert.match(
    chatResumeStoreSource,
    /reasoning_content\?\s*:\s*string/,
    "ChatMessageSnapshot must have optional reasoning_content field"
  );
});

test("chat-task-service reads reasoning_content with thinking fallback", () => {
  assert.match(
    chatTaskServiceSource,
    /partialAssistantMessage\?\.reasoning_content\s*\?\?.*partialAssistantMessage\?\.thinking/,
    "streamedThinking init must prefer reasoning_content over thinking"
  );
});

// Step 3: IPC contracts expose resumeState
test("ChatResumeSnapshot in IPC contracts includes resumeState field", () => {
  assert.match(
    ipcContractsSource,
    /resumeState\?\s*:\s*unknown/,
    "ChatResumeSnapshot must expose resumeState"
  );
});

test("SendMessagePayload in IPC contracts includes resumeState field", () => {
  const sendPayloadBlock = ipcContractsSource.slice(
    ipcContractsSource.indexOf("interface SendMessagePayload"),
    ipcContractsSource.indexOf("}", ipcContractsSource.indexOf("interface SendMessagePayload")) + 1
  );
  assert.match(
    sendPayloadBlock,
    /resumeState/,
    "SendMessagePayload must include resumeState"
  );
});

// Step 4: Frontend auto-sends resumeState on resume
test("sendMessage checks last turn interrupted and loads resumeState", () => {
  assert.match(
    sendMessageSource,
    /lastTurn\.interrupted/,
    "sendMessage must check if last turn was interrupted"
  );
  assert.match(
    sendMessageSource,
    /getResumeState/,
    "sendMessage must call getResumeState when resuming"
  );
  assert.match(
    sendMessageSource,
    /resumeState:\s*resumeStatePayload/,
    "sendMessage must attach resumeState to the payload"
  );
});
