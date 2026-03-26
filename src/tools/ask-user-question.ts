import { randomUUID } from "node:crypto";
import { asString, asBoolean, asStringArray } from "../core/json-utils";
import type {
  JsonObject,
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
  UserQuestionField,
  UserQuestionOption
} from "../core/types";

export class AskUserQuestionTool implements Tool {
  readonly definition = {
    name: "ask_user_question",
    description:
      "Ask the user one or more structured questions and wait for their answers. " +
      "Supports single-select, multi-select, and free-text question types. " +
      "Use this to gather requirements, preferences, or confirmations before proceeding.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional heading displayed above the question form."
        },
        description: {
          type: "string",
          description: "Optional context or background for the questions."
        },
        fields: {
          type: "array",
          description: "One or more question fields.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique identifier for this field." },
              type: {
                type: "string",
                enum: ["single_select", "multi_select", "text"],
                description: "Question type."
              },
              question: { type: "string", description: "The question text shown to the user." },
              options: {
                type: "array",
                description: "Options for single_select / multi_select types.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display label." },
                    description: { type: "string", description: "Optional explanation." },
                    value: { type: "string", description: "Value returned when selected." }
                  },
                  required: ["label", "value"]
                }
              },
              placeholder: { type: "string", description: "Placeholder for text input." },
              required: {
                type: "boolean",
                description: "Whether the field must be answered. Default true."
              },
              default_value: {
                description: "Default value (string for text/single_select, string[] for multi_select)."
              }
            },
            required: ["id", "type", "question"]
          }
        }
      },
      required: ["fields"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const bridge = context.userInteractionBridge;
    if (!bridge) {
      return {
        ok: false,
        error:
          "User interaction bridge is not available. " +
          "ask_user_question requires a UI environment (desktop app)."
      };
    }

    const rawFields = input.fields;
    if (!Array.isArray(rawFields) || rawFields.length === 0) {
      return { ok: false, error: "fields must be a non-empty array of question fields." };
    }

    const fields: UserQuestionField[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < rawFields.length; i++) {
      const raw = rawFields[i] as JsonObject | null;
      if (!raw || typeof raw !== "object") {
        return { ok: false, error: `fields[${i}] must be an object.` };
      }

      const id = asString(raw.id);
      if (!id || !id.trim()) {
        return { ok: false, error: `fields[${i}].id is required and must be a non-empty string.` };
      }
      if (seenIds.has(id)) {
        return { ok: false, error: `Duplicate field id "${id}" at fields[${i}].` };
      }
      seenIds.add(id);

      const type = asString(raw.type);
      if (type !== "single_select" && type !== "multi_select" && type !== "text") {
        return {
          ok: false,
          error: `fields[${i}].type must be "single_select", "multi_select", or "text". Got "${type}".`
        };
      }

      const question = asString(raw.question);
      if (!question || !question.trim()) {
        return {
          ok: false,
          error: `fields[${i}].question is required and must be a non-empty string.`
        };
      }

      let options: UserQuestionOption[] | undefined;
      if (type === "single_select" || type === "multi_select") {
        if (!Array.isArray(raw.options) || raw.options.length === 0) {
          return {
            ok: false,
            error: `fields[${i}].options is required for ${type} and must be a non-empty array.`
          };
        }
        options = [];
        for (let j = 0; j < raw.options.length; j++) {
          const opt = raw.options[j] as JsonObject | null;
          if (!opt || typeof opt !== "object") {
            return { ok: false, error: `fields[${i}].options[${j}] must be an object.` };
          }
          const label = asString(opt.label);
          const value = asString(opt.value);
          if (!label || !value) {
            return {
              ok: false,
              error: `fields[${i}].options[${j}] requires non-empty label and value.`
            };
          }
          options.push({
            label,
            value,
            ...(asString(opt.description) ? { description: asString(opt.description)! } : {})
          });
        }
      }

      const placeholder = asString(raw.placeholder) ?? undefined;
      const required = asBoolean(raw.required) ?? true;

      let default_value: string | string[] | undefined;
      if (raw.default_value !== undefined && raw.default_value !== null) {
        if (type === "multi_select") {
          const arr = asStringArray(raw.default_value);
          if (arr) {
            default_value = arr;
          }
        } else {
          const str = asString(raw.default_value);
          if (str !== null) {
            default_value = str;
          }
        }
      }

      fields.push({
        id,
        type,
        question,
        ...(options ? { options } : {}),
        ...(placeholder ? { placeholder } : {}),
        required,
        ...(default_value !== undefined ? { default_value } : {})
      });
    }

    const requestId = randomUUID();
    const title = asString(input.title) ?? undefined;
    const description = asString(input.description) ?? undefined;

    try {
      const answer = await bridge.askQuestion({
        requestId,
        title,
        description,
        fields
      });

      return {
        ok: true,
        data: {
          requestId,
          skipped: answer.skipped === true,
          answers: answer.answers
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("abort") ||
        message.includes("interrupt") ||
        message.includes("cancel")
      ) {
        return { ok: false, error: "User question was cancelled." };
      }
      return { ok: false, error: `Failed to ask user question: ${message}` };
    }
  }
}
