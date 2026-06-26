import { html, LitElement, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { t } from "../i18n/index.ts";
import { GatewayBrowserClient, type GatewayHelloOk } from "../ui/gateway.ts";
import { BrowserSetupModel, type SetupModelStatus, type SetupPlannerStep } from "./model.ts";

type WizardStep = SetupPlannerStep & {
  id: string;
  format?: "plain";
  executor?: "gateway" | "client";
};

type WizardResult = {
  done: boolean;
  status?: "running" | "done" | "cancelled" | "error";
  step?: WizardStep;
  error?: string;
};

type SetupMessage = {
  role: "assistant" | "user" | "system";
  text: string;
};

function setupGatewayUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const basePath = window.location.pathname.replace(/\/setup\/?$/u, "");
  return `${protocol}//${window.location.host}${basePath}`;
}

function readTokenFromHash(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token")?.trim() ?? "";
  if (token) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return token;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeSetupPlannerValue(
  step: SetupPlannerStep,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (step.type === "select") {
    const option = step.options?.find(
      (candidate) =>
        sameValue(candidate.value, value) ||
        (typeof value === "string" && candidate.label.toLowerCase() === value.toLowerCase()),
    );
    return option ? { ok: true, value: option.value } : { ok: false };
  }
  if (step.type === "multiselect") {
    if (!Array.isArray(value)) {
      return { ok: false };
    }
    const normalized: unknown[] = [];
    for (const item of value) {
      const option = step.options?.find(
        (candidate) =>
          sameValue(candidate.value, item) ||
          (typeof item === "string" && candidate.label.toLowerCase() === item.toLowerCase()),
      );
      if (!option) {
        return { ok: false };
      }
      normalized.push(option.value);
    }
    return { ok: true, value: normalized };
  }
  if (step.type === "confirm") {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  }
  if (step.type === "text") {
    return typeof value === "string" ? { ok: true, value } : { ok: false };
  }
  return { ok: false };
}

export class SetupApp extends LitElement {
  private client: GatewayBrowserClient | null = null;
  private readonly model = new BrowserSetupModel();
  private messages: SetupMessage[] = [];
  private step: WizardStep | null = null;
  private wizardSessionId: string | null = null;
  private modelStatus: SetupModelStatus = { state: "idle" };
  private connectionState = t("setup.connecting");
  private errorMessage = "";
  private textValue = "";
  private selectedValues: unknown[] = [];
  private busy = false;
  private completed = false;
  private heartbeatTimer: number | null = null;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    const token = readTokenFromHash();
    if (!token) {
      this.errorMessage = "The setup link is missing its one-time token.";
      return;
    }
    this.client = new GatewayBrowserClient({
      url: setupGatewayUrl(),
      token,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      onHello: (hello) => void this.handleHello(hello),
      onClose: ({ reason, error }) => {
        this.connectionState = error?.message || `Setup host disconnected: ${reason || "closed"}`;
        this.requestUpdate();
      },
    });
    this.client.start();
    void this.loadModel();
  }

  override disconnectedCallback(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.client && this.wizardSessionId && !this.completed) {
      void this.client
        .request("wizard.cancel", { sessionId: this.wizardSessionId })
        .catch(() => undefined);
    }
    this.client?.stop();
    void this.model.dispose();
    super.disconnectedCallback();
  }

  protected override render() {
    return html`
      <main class="setup-shell">
        <header class="setup-header">
          <div>
            <p class="setup-eyebrow">${t("setup.eyebrow")}</p>
            <h1>${t("setup.title")}</h1>
          </div>
          <div class="setup-status" data-state=${this.modelStatus.state}>
            <span class="setup-status__dot"></span>
            ${this.statusLabel()}
          </div>
        </header>

        <section class="setup-content" aria-live="polite">
          <div class="setup-chat">
            ${this.messages.map(
              (message) => html`
                <article
                  class=${classMap({
                    "setup-message": true,
                    [`setup-message--${message.role}`]: true,
                  })}
                >
                  <span class="setup-message__role">${message.role}</span>
                  <p>${message.text}</p>
                </article>
              `,
            )}
            ${this.errorMessage
              ? html`<p class="setup-error" role="alert">${this.errorMessage}</p>`
              : nothing}
            ${this.completed
              ? html`
                  <div class="setup-complete">
                    <strong>${t("setup.setupComplete")}</strong>
                    <span>${t("setup.closeTab")}</span>
                  </div>
                `
              : nothing}
          </div>

          <aside class="setup-step" aria-label="Current setup step">
            <p class="setup-step__eyebrow">${this.connectionState}</p>
            ${this.step
              ? html`
                  <h2>${this.step.title?.trim() || t("setup.currentStep")}</h2>
                  ${this.step.message
                    ? html`<p class="setup-step__message">${this.step.message}</p>`
                    : nothing}
                  ${this.renderStepInput(this.step)}
                `
              : html`<p class="setup-step__message">${t("setup.waiting")}</p>`}
          </aside>
        </section>

        <footer class="setup-footer">
          <span>${t("setup.localModel")}</span>
          <span>${t("setup.noApiKey")}</span>
        </footer>
      </main>
    `;
  }

  private statusLabel(): string {
    switch (this.modelStatus.state) {
      case "loading":
        return t("setup.modelLoading");
      case "ready":
        return t("setup.modelReady");
      case "error":
        return t("setup.structuredMode");
      default:
        return t("setup.modelPreparing");
    }
  }

  private renderStepInput(step: WizardStep) {
    if (step.type === "note" || step.type === "progress" || step.type === "action") {
      return html`
        <button
          class="setup-button setup-button--primary"
          ?disabled=${this.busy}
          @click=${() => void this.submitValue(null)}
        >
          ${t("setup.continue")}
        </button>
      `;
    }
    if (step.type === "select") {
      return html`
        <div class="setup-options">
          ${(step.options ?? []).map(
            (option) => html`
              <button
                class=${classMap({
                  "setup-option": true,
                  "setup-option--selected": sameValue(this.selectedValues[0], option.value),
                })}
                ?disabled=${this.busy}
                @click=${() => {
                  this.selectedValues = [option.value];
                  void this.submitValue(option.value);
                }}
              >
                <span>${option.label}</span>
                ${option.hint ? html`<small>${option.hint}</small>` : nothing}
              </button>
            `,
          )}
        </div>
      `;
    }
    if (step.type === "multiselect") {
      return html`
        <div class="setup-options">
          ${(step.options ?? []).map(
            (option) => html`
              <label class="setup-option setup-option--checkbox">
                <input
                  type="checkbox"
                  .checked=${this.selectedValues.some((value) => sameValue(value, option.value))}
                  ?disabled=${this.busy}
                  @change=${(event: Event) => this.toggleOption(option.value, event)}
                />
                <span>${option.label}</span>
                ${option.hint ? html`<small>${option.hint}</small>` : nothing}
              </label>
            `,
          )}
        </div>
        <button
          class="setup-button setup-button--primary"
          ?disabled=${this.busy}
          @click=${() => void this.submitValue(this.selectedValues)}
        >
          ${t("setup.continue")}
        </button>
      `;
    }
    if (step.type === "confirm") {
      return html`
        <div class="setup-actions">
          <button
            class="setup-button setup-button--primary"
            ?disabled=${this.busy}
            @click=${() => void this.submitValue(true)}
          >
            ${t("setup.yes")}
          </button>
          <button
            class="setup-button"
            ?disabled=${this.busy}
            @click=${() => void this.submitValue(false)}
          >
            ${t("setup.no")}
          </button>
        </div>
      `;
    }
    return html`
      <form
        class="setup-form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void this.submitText();
        }}
      >
        <input
          class="setup-input"
          type=${step.sensitive ? "password" : "text"}
          .value=${this.textValue}
          placeholder=${step.placeholder ?? ""}
          autocomplete=${step.sensitive ? "off" : "on"}
          @input=${(event: Event) => {
            this.textValue = (event.target as HTMLInputElement).value;
          }}
          ?disabled=${this.busy}
        />
        <button
          class="setup-button setup-button--primary"
          type="submit"
          ?disabled=${this.busy || !this.textValue.trim()}
        >
          ${t("setup.continue")}
        </button>
        ${step.sensitive
          ? nothing
          : html`
              <button
                class="setup-button"
                type="button"
                ?disabled=${this.busy || !this.textValue.trim()}
                @click=${() => void this.submitValue(this.textValue.trim())}
              >
                ${t("setup.useExactValue")}
              </button>
            `}
      </form>
      ${step.sensitive
        ? html`<p class="setup-sensitive-note">${t("setup.sensitiveNote")}</p>`
        : nothing}
    `;
  }

  private async handleHello(_hello: GatewayHelloOk): Promise<void> {
    if (!this.client) {
      return;
    }
    this.connectionState = t("setup.connected");
    try {
      const workspace = new URLSearchParams(window.location.search).get("workspace")?.trim();
      const result = await this.client.request<WizardResult & { sessionId?: string }>(
        "wizard.start",
        {
          mode: "local",
          ...(workspace ? { workspace } : {}),
        },
      );
      this.wizardSessionId = result.sessionId ?? null;
      this.applyWizardResult(result);
      this.startHeartbeat();
      this.requestUpdate();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
    }
  }

  private startHeartbeat(): void {
    if (!this.client || !this.wizardSessionId || this.heartbeatTimer !== null) {
      return;
    }
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.client || !this.wizardSessionId || this.completed) {
        return;
      }
      void this.client
        .request("wizard.status", { sessionId: this.wizardSessionId })
        .catch(() => undefined);
    }, 15_000);
  }

  private async loadModel(): Promise<void> {
    try {
      await this.model.initialize();
    } catch {
      // Structured wizard controls remain usable when WebGPU is unavailable.
    }
    this.modelStatus = this.model.status;
    this.requestUpdate();
  }

  private async submitText(): Promise<void> {
    const text = this.textValue.trim();
    const step = this.step;
    if (!text || !step) {
      return;
    }
    if (step.sensitive) {
      this.textValue = "";
      this.messages = [...this.messages, { role: "user", text: t("setup.sensitiveSubmitted") }];
      await this.submitValue(text);
      return;
    }
    this.messages = [...this.messages, { role: "user", text }];
    if (this.modelStatus.state !== "ready") {
      this.textValue = "";
      await this.submitValue(text);
      return;
    }
    this.textValue = "";
    this.busy = true;
    this.requestUpdate();
    try {
      const result = await this.model.plan({ step, userText: text });
      if (result?.reply) {
        this.messages = [...this.messages, { role: "assistant", text: result.reply }];
      }
      const normalized = result
        ? normalizeSetupPlannerValue(step, result.value)
        : { ok: false as const };
      if (normalized.ok) {
        this.busy = false;
        await this.submitValue(normalized.value);
      } else if (result?.value !== null && result?.value !== undefined) {
        this.messages = [...this.messages, { role: "system", text: t("setup.plannerFallback") }];
      }
    } catch {
      this.messages = [
        ...this.messages,
        {
          role: "system",
          text: t("setup.plannerFallback"),
        },
      ];
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private toggleOption(value: unknown, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedValues = checked
      ? [...this.selectedValues, value]
      : this.selectedValues.filter((candidate) => !sameValue(candidate, value));
    this.requestUpdate();
  }

  private async submitValue(value: unknown): Promise<void> {
    if (!this.client || !this.wizardSessionId || !this.step || this.busy) {
      return;
    }
    const stepId = this.step.id;
    this.busy = true;
    this.requestUpdate();
    try {
      const result = await this.client.request<WizardResult>("wizard.next", {
        sessionId: this.wizardSessionId,
        answer: { stepId, value },
      });
      this.applyWizardResult(result);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private applyWizardResult(result: WizardResult): void {
    if (result.error) {
      this.errorMessage = result.error;
    }
    if (result.done) {
      this.step = null;
      this.completed = result.status === "done";
      this.messages = [
        ...this.messages,
        {
          role: result.status === "done" ? "assistant" : "system",
          text:
            result.status === "done" ? t("setup.setupComplete") : result.error || "Setup ended.",
        },
      ];
      return;
    }
    this.step = result.step ?? null;
    this.textValue = "";
    this.selectedValues = [];
    if (result.step?.type === "note" && result.step.message) {
      this.messages = [...this.messages, { role: "assistant", text: result.step.message }];
    }
  }
}
