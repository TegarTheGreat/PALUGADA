/**
 * Model access.
 *
 * Only an interface and a deterministic fake ship in Phase 0. The PRD leaves
 * the model-per-tier calibration open (section 14.4) and section 12 asks for
 * per-role model abstraction so a provider outage does not take the platform
 * with it, so binding to one vendor now would be guessing at a decision the
 * owner has not made. Every call is traced (F11.1) regardless of provider.
 */
export interface LlmRequest {
  model: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
}

export interface LlmResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface LlmClient {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

/**
 * Test double that records every call.
 *
 * The call counter is what makes F5.1 checkable: after a crash and restart, a
 * resumed task must not have re-issued the calls it already completed, and
 * counting them is the only way to prove replay rather than assume it.
 */
export class RecordingLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  #responder: (request: LlmRequest, index: number) => string;

  constructor(responder: (request: LlmRequest, index: number) => string = (_r, i) => `response-${i}`) {
    this.#responder = responder;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const index = this.calls.length;
    this.calls.push(request);
    const content = this.#responder(request, index);
    return {
      content,
      inputTokens: 100,
      outputTokens: 50,
      costCents: 1,
    };
  }

  get callCount(): number {
    return this.calls.length;
  }
}
