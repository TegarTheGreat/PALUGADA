/**
 * Traces for an OpenTelemetry collector (the competitive analysis of
 * 2026-09-30, item 13): each finished run as a span, with its steps and its
 * model calls under it, sent over OTLP/HTTP as JSON to the collector the
 * operator names with the standard variables (`OTEL_EXPORTER_OTLP_ENDPOINT`
 * and the rest), so Jaeger, Grafana Tempo, Honeycomb or Datadog show where a
 * company's time and money went beside the operator's other services.
 *
 * What goes: names, times, statuses, models, token counts and cost. What
 * does not: prompts, responses, tool inputs and outputs. A collector is often
 * a vendor's, and a company's words are not the operator's to send there;
 * the console's own trace has them, behind the owner's session.
 *
 * Which runs have gone is kept in the database (0090), under a lease, so
 * replicas do not send one run twice and a restart does not skip one. A
 * collector that is down is tried again on the next tick: the cursor moves
 * only once it has answered 2xx.
 */
import { createHash } from 'node:crypto';
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { VERSION } from '../version.ts';

export interface OtlpTarget {
  /** Where spans are posted: the traces endpoint itself, `…/v1/traces`. */
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
}

export interface OtlpOptions extends OtlpTarget {
  /** Who holds the lease on the cursor while it sends: the worker's id. */
  holder: string;
  fetch?: typeof globalThis.fetch;
  /** Runs sent in one request. */
  batch?: number;
  /**
   * How long after a run finished it is sent. A run's `finished_at` is its
   * transaction's start, so one committing while a batch is read could be
   * stamped before the cursor and never sent; waiting a little closes that.
   */
  settleMs?: number;
  timeoutMs?: number;
  version?: string;
}

/**
 * The collector the standard variables name, or null. Only OTLP over HTTP in
 * JSON is spoken here: a protocol set to anything else is refused by name,
 * rather than sent in a format the collector would reject.
 */
export function otlpFrom(env: NodeJS.ProcessEnv): OtlpTarget | null {
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!traces && !base) return null;
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/json').trim();
  if (protocol !== 'http/json') {
    throw new PalugadaError('config.invalid',
      `OTEL_EXPORTER_OTLP_PROTOCOL is ${protocol}; PALUGADA sends traces as http/json, which every OpenTelemetry collector accepts on its HTTP port`,
      { source: 'OTEL_EXPORTER_OTLP_PROTOCOL' });
  }
  const endpoint = traces || `${base!.replace(/\/+$/, '')}/v1/traces`;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PalugadaError('config.invalid', `the OpenTelemetry endpoint ${endpoint} is not an address`, { source: 'OTEL_EXPORTER_OTLP_ENDPOINT' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PalugadaError('config.invalid', `the OpenTelemetry endpoint ${endpoint} is not http or https`, { source: 'OTEL_EXPORTER_OTLP_ENDPOINT' });
  }
  return {
    endpoint,
    headers: headersFrom(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? ''),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || 'palugada',
  };
}

/** `name=value,name=value`, values percent-encoded, as the OpenTelemetry specification writes them. */
function headersFrom(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim().toLowerCase();
    const value = pair.slice(at + 1).trim();
    try {
      headers[name] = decodeURIComponent(value);
    } catch {
      headers[name] = value;
    }
  }
  return headers;
}

interface RunRow {
  id: string; company_id: string; company_slug: string; task_id: string; role_slug: string | null;
  attempt: number; status: string; tokens_used: string; started_at: Date; finished_at: Date;
}

type Attribute = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } };

const text = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });
const whole = (key: string, value: number | string): Attribute => ({ key, value: { intValue: String(value) } });
const nanos = (at: Date): string => `${BigInt(at.getTime()) * 1_000_000n}`;
const hex = (uuid: string): string => uuid.replace(/-/g, '');
/** A span id: sixteen hex digits, the same every time for the same thing. */
const spanId = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export class OtlpExporter {
  readonly endpoint: string;
  readonly #options: OtlpOptions;

  constructor(options: OtlpOptions) {
    this.endpoint = options.endpoint;
    this.#options = options;
  }

  /** Sends the next batch of finished runs. Answers how many spans went; 0 when another process holds the cursor. */
  async export(): Promise<number> {
    const holder = this.#options.holder;
    const claimed = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ through_at: string; through_id: string }>(
        `UPDATE telemetry_cursor SET holder = $1, held_until = now() + interval '1 minute'
          WHERE held_until < now() OR holder = $1
          RETURNING through_at::text, through_id`,
        [holder]);
      return rows[0] ?? null;
    });
    if (!claimed) return 0;
    try {
      const batch = await this.#read(claimed.through_at, claimed.through_id);
      if (batch.runs.length === 0) return 0;
      await this.#post(batch.spans);
      const last = batch.runs.at(-1)!;
      // From the row itself, not a JavaScript date: a timestamp keeps
      // microseconds a Date drops, and a cursor a microsecond short sends the
      // same run for ever.
      await withControlPlane((tx) => tx.query(
        `UPDATE telemetry_cursor
            SET through_at = (SELECT finished_at FROM agent_runs WHERE id = $1), through_id = $1
          WHERE holder = $2`,
        [last.id, holder]));
      return batch.spans.length;
    } finally {
      await withControlPlane((tx) => tx.query(
        "UPDATE telemetry_cursor SET held_until = '-infinity' WHERE holder = $1", [holder]));
    }
  }

  async #read(throughAt: string, throughId: string): Promise<{ runs: RunRow[]; spans: unknown[] }> {
    return withControlPlane(async (tx) => {
      const { rows: runs } = await tx.query<RunRow>(
        `SELECT r.id, r.company_id, c.slug AS company_slug, r.task_id, role.slug AS role_slug, r.attempt, r.status,
                r.tokens_used, r.started_at, r.finished_at
           FROM agent_runs r
           JOIN companies c ON c.id = r.company_id
           LEFT JOIN roles role ON role.id = r.role_id AND role.company_id = r.company_id
          WHERE r.finished_at IS NOT NULL
            AND r.finished_at < now() - make_interval(secs => $3)
            AND (r.finished_at, r.id) > ($1::timestamptz, $2::uuid)
          ORDER BY r.finished_at, r.id
          LIMIT $4`,
        [throughAt, throughId, (this.#options.settleMs ?? 30_000) / 1000, this.#options.batch ?? 50]);
      const spans: unknown[] = [];
      for (const run of runs) {
        const traceId = hex(run.task_id);
        const runSpan = spanId('run', run.id);
        spans.push({
          traceId, spanId: runSpan, name: `run ${run.role_slug ?? 'role'}`, kind: SPAN_KIND_INTERNAL,
          startTimeUnixNano: nanos(run.started_at), endTimeUnixNano: nanos(run.finished_at),
          attributes: [
            text('palugada.company.id', run.company_id), text('palugada.company.slug', run.company_slug),
            text('palugada.task.id', run.task_id), text('palugada.run.id', run.id),
            text('palugada.role', run.role_slug ?? ''), text('palugada.run.status', run.status),
            whole('palugada.run.attempt', run.attempt), whole('palugada.run.tokens', run.tokens_used),
          ],
          status: run.status === 'succeeded' ? { code: STATUS_OK } : { code: STATUS_ERROR, message: run.status },
        });
        const { rows: steps } = await tx.query<{
          step_index: number; name: string; kind: string; status: string; started_at: Date; committed_at: Date | null;
        }>(
          `SELECT step_index, name, kind, status, started_at, committed_at FROM task_steps
            WHERE task_id = $1 AND started_at BETWEEN $2 AND $3 ORDER BY step_index`,
          [run.task_id, run.started_at, run.finished_at]);
        for (const step of steps) {
          spans.push({
            traceId, spanId: spanId('step', run.task_id, String(step.step_index), step.started_at.toISOString()),
            parentSpanId: runSpan, name: step.name, kind: SPAN_KIND_INTERNAL,
            startTimeUnixNano: nanos(step.started_at), endTimeUnixNano: nanos(step.committed_at ?? run.finished_at),
            attributes: [
              text('palugada.step.kind', step.kind), text('palugada.step.status', step.status), whole('palugada.step.index', step.step_index),
            ],
            status: step.status === 'committed' ? { code: STATUS_OK } : { code: STATUS_ERROR, message: step.status },
          });
        }
        const { rows: calls } = await tx.query<{
          id: string; model: string; kind: string | null; input_tokens: number; output_tokens: number;
          cost_cents: number; latency_ms: number | null; occurred_at: Date;
        }>(
          `SELECT id, model, kind, input_tokens, output_tokens, cost_cents, latency_ms, occurred_at
             FROM llm_traces WHERE agent_run_id = $1 ORDER BY occurred_at`,
          [run.id]);
        for (const call of calls) {
          const ended = call.occurred_at;
          const began = new Date(ended.getTime() - (call.latency_ms ?? 0));
          spans.push({
            traceId, spanId: spanId('model', call.id), parentSpanId: runSpan, name: `chat ${call.model}`, kind: SPAN_KIND_CLIENT,
            startTimeUnixNano: nanos(began), endTimeUnixNano: nanos(ended),
            // The GenAI semantic conventions, so a backend that knows them
            // shows the model and its tokens where it shows any other's.
            attributes: [
              text('gen_ai.operation.name', 'chat'), text('gen_ai.request.model', call.model),
              whole('gen_ai.usage.input_tokens', call.input_tokens), whole('gen_ai.usage.output_tokens', call.output_tokens),
              whole('palugada.cost_cents', call.cost_cents), text('palugada.call.kind', call.kind ?? 'model'),
            ],
            status: { code: STATUS_OK },
          });
        }
      }
      return { runs, spans };
    });
  }

  async #post(spans: unknown[]): Promise<void> {
    const body = {
      resourceSpans: [{
        resource: { attributes: [text('service.name', this.#options.serviceName), text('service.version', this.#options.version ?? VERSION)] },
        scopeSpans: [{ scope: { name: 'palugada', version: this.#options.version ?? VERSION }, spans }],
      }],
    };
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(this.#options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#options.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
      });
    } catch (failure) {
      throw new PalugadaError('capability.unreachable', `the OpenTelemetry collector at ${this.#options.endpoint} could not be reached: ${(failure as Error).message}`, {});
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new PalugadaError('capability.unreachable',
        `the OpenTelemetry collector at ${this.#options.endpoint} answered ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status });
    }
  }
}
