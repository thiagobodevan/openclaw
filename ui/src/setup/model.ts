import type { Conversation, Engine } from "@litert-lm/core";

export const BROWSER_SETUP_MODEL_URL =
  "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm";

const SETUP_MODEL_PREFACE = [
  "You are OpenClaw's local onboarding assistant.",
  "You are a planner only. You cannot run commands, edit files, install packages, or access secrets.",
  "The user is answering the currently displayed setup wizard step.",
  "Return only compact JSON with keys reply and value.",
  "value must be one of the supplied option values, a boolean, a string, or an array of supplied option values.",
  "For sensitive fields, never infer or repeat the value; the UI submits those directly.",
  "If the request does not answer the current step, set value to null and explain what is needed in reply.",
].join("\n");

export type SetupModelStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; message: string };

export type SetupPlannerStep = {
  type: string;
  title?: string;
  message?: string;
  options?: Array<{ value: unknown; label: string; hint?: string }>;
  placeholder?: string;
  sensitive?: boolean;
};

export type SetupPlannerResult = {
  reply: string;
  value: unknown;
};

type LiteRtModule = typeof import("@litert-lm/core");

let liteRtModulePromise: Promise<LiteRtModule> | undefined;

async function loadLiteRtModule(): Promise<LiteRtModule> {
  liteRtModulePromise ??= import("@litert-lm/core");
  return await liteRtModulePromise;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function parseSetupPlannerResult(text: string): SetupPlannerResult | null {
  const json = extractFirstJsonObject(text.trim());
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as { reply?: unknown; value?: unknown };
    if (typeof parsed.reply !== "string") {
      return null;
    }
    return {
      reply: parsed.reply.trim(),
      value: parsed.value ?? null,
    };
  } catch {
    return null;
  }
}

function formatStep(step: SetupPlannerStep): string {
  return JSON.stringify({
    type: step.type,
    title: step.title,
    message: step.message,
    options: step.options,
    placeholder: step.placeholder,
    sensitive: step.sensitive === true,
  });
}

export class BrowserSetupModel {
  private engine: Engine | null = null;
  private conversation: Conversation | null = null;
  private statusValue: SetupModelStatus = { state: "idle" };

  get status(): SetupModelStatus {
    return this.statusValue;
  }

  async initialize(): Promise<void> {
    if (this.conversation) {
      return;
    }
    if (!("gpu" in navigator)) {
      this.statusValue = {
        state: "error",
        message: "This browser does not expose WebGPU.",
      };
      throw new Error(this.statusValue.message);
    }
    this.statusValue = { state: "loading" };
    try {
      const { Engine: EngineConstructor, loadLiteRtLm } = await loadLiteRtModule();
      const basePath = window.location.pathname.replace(/\/setup\/?$/u, "");
      await loadLiteRtLm(new URL(`${basePath}/litert-lm/wasm`, window.location.origin).toString());
      this.engine = await EngineConstructor.create({
        model: BROWSER_SETUP_MODEL_URL,
        mainExecutorSettings: { maxNumTokens: 8192 },
      });
      this.conversation = await this.engine.createConversation({
        preface: {
          messages: [{ role: "system", content: SETUP_MODEL_PREFACE }],
        },
      });
      this.statusValue = { state: "ready" };
    } catch (error) {
      this.statusValue = {
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      await this.dispose();
      throw error;
    }
  }

  async plan(params: {
    step: SetupPlannerStep;
    userText: string;
  }): Promise<SetupPlannerResult | null> {
    await this.initialize();
    if (!this.conversation) {
      return null;
    }
    const response = await this.conversation.sendMessage(
      ["Current setup step:", formatStep(params.step), "", `User message: ${params.userText}`].join(
        "\n",
      ),
    );
    const content = response.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((item: unknown) => {
                if (!item || typeof item !== "object") {
                  return "";
                }
                const itemText = (item as { text?: unknown }).text;
                return typeof itemText === "string" ? itemText : "";
              })
              .join("")
          : "";
    return parseSetupPlannerResult(text);
  }

  cancel(): void {
    this.conversation?.cancel();
  }

  async dispose(): Promise<void> {
    this.conversation = null;
    if (this.engine) {
      await this.engine.delete();
      this.engine = null;
    }
  }
}
