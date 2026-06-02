import type { RuntimeToolSchemaDiagnostic } from "./tool-schema-projection.js";
import { projectRuntimeToolInputSchema } from "./tool-schema-projection.js";

type ToolProjectionField = "name" | "description" | "parameters";
type AnthropicToolChoiceMode = "auto" | "any" | "none";
type AnthropicToolChoiceWithDisable = {
  readonly disable_parallel_tool_use?: boolean;
};
export type AnthropicResolvedToolChoice =
  | AnthropicToolChoiceMode
  | ({ readonly type: "auto" } & AnthropicToolChoiceWithDisable)
  | ({ readonly type: "any" } & AnthropicToolChoiceWithDisable)
  | { readonly type: "none" }
  | ({ readonly type: "tool"; readonly name: string } & AnthropicToolChoiceWithDisable);

type AnthropicToolProjectionDescriptor = {
  readonly [key in ToolProjectionField]?: unknown;
};

export type AnthropicProjectedTool = {
  readonly originalIndex: number;
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown> & { required?: string[] };
};

export type AnthropicToolProjectionSnapshot = {
  readonly tools: readonly AnthropicProjectedTool[];
  readonly diagnostics: readonly RuntimeToolSchemaDiagnostic[];
};

function readObjectStringField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === "string" ? value[field] : undefined;
}

function readDisableParallelToolUse(value: unknown): AnthropicToolChoiceWithDisable {
  return isRecord(value) && typeof value.disable_parallel_tool_use === "boolean"
    ? { disable_parallel_tool_use: value.disable_parallel_tool_use }
    : {};
}

function isAnthropicToolChoiceMode(value: string): value is AnthropicToolChoiceMode {
  return value === "auto" || value === "any" || value === "none";
}

function readToolField(
  tool: object,
  field: ToolProjectionField,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: Reflect.get(tool, field) };
  } catch {
    return { ok: false };
  }
}

function readToolEntry(
  tools: readonly AnthropicToolProjectionDescriptor[],
  toolIndex: number,
): { ok: true; tool: unknown } | { ok: false } {
  try {
    return { ok: true, tool: Reflect.get(tools, String(toolIndex)) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unreadableDiagnostic(toolIndex: number): RuntimeToolSchemaDiagnostic {
  return {
    toolName: `tool[${toolIndex}]`,
    toolIndex,
    violations: [`tool[${toolIndex}] is unreadable`],
  };
}

function normalizeRequired(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

export function snapshotAnthropicToolProjectionInputs(
  tools: readonly AnthropicToolProjectionDescriptor[] | undefined,
): AnthropicToolProjectionSnapshot {
  if (!tools) {
    return { tools: [], diagnostics: [] };
  }

  let length: number;
  try {
    length = tools.length;
  } catch {
    return { tools: [], diagnostics: [unreadableDiagnostic(0)] };
  }

  const projectedTools: AnthropicProjectedTool[] = [];
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    const entry = readToolEntry(tools, toolIndex);
    if (!entry.ok || !isRecord(entry.tool)) {
      diagnostics.push(unreadableDiagnostic(toolIndex));
      continue;
    }

    const name = readToolField(entry.tool, "name");
    const toolName =
      name.ok && typeof name.value === "string" && name.value ? name.value : `tool[${toolIndex}]`;
    const descriptorViolations = name.ok ? [] : [`${toolName}.name is unreadable`];
    if (!name.ok || typeof name.value !== "string" || !name.value) {
      diagnostics.push({
        toolName,
        toolIndex,
        violations:
          descriptorViolations.length > 0
            ? descriptorViolations
            : [`${toolName}.name must be a non-empty string`],
      });
      continue;
    }

    const parameters = readToolField(entry.tool, "parameters");
    if (!parameters.ok) {
      diagnostics.push({
        toolName,
        toolIndex,
        violations: [`${toolName}.parameters is unreadable`],
      });
      continue;
    }

    const schemaProjection = projectRuntimeToolInputSchema(
      parameters.value,
      `${toolName}.parameters`,
    );
    if (schemaProjection.violations.length > 0 || !isRecord(schemaProjection.schema)) {
      diagnostics.push({
        toolName,
        toolIndex,
        violations: schemaProjection.violations,
      });
      continue;
    }

    const description = readToolField(entry.tool, "description");
    const required = normalizeRequired(schemaProjection.schema.required);
    projectedTools.push({
      originalIndex: toolIndex,
      name: name.value,
      ...(description.ok && typeof description.value === "string"
        ? { description: description.value }
        : {}),
      parameters: {
        ...schemaProjection.schema,
        ...(required ? { required } : {}),
      },
    });
  }

  return { tools: projectedTools, diagnostics };
}

export function resolveAnthropicToolChoiceForProjectedTools(
  toolChoice: unknown,
  toolNames: readonly string[],
): AnthropicResolvedToolChoice | undefined {
  if (typeof toolChoice === "string") {
    return isAnthropicToolChoiceMode(toolChoice) && (toolChoice === "none" || toolNames.length > 0)
      ? toolChoice
      : undefined;
  }
  if (!isRecord(toolChoice)) {
    return undefined;
  }
  const type = readObjectStringField(toolChoice, "type");
  if (type === "none") {
    return { type };
  }
  if ((type === "auto" || type === "any") && toolNames.length > 0) {
    return { type, ...readDisableParallelToolUse(toolChoice) };
  }
  if (type === "tool") {
    const name = readObjectStringField(toolChoice, "name");
    return name && toolNames.includes(name)
      ? { type, name, ...readDisableParallelToolUse(toolChoice) }
      : { type: "none" };
  }
  return undefined;
}
