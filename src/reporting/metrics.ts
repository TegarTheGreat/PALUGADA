/**
 * What this deployment is doing, for a metrics scraper (section 12).
 *
 * The console answers the owner, and `/api/health` answers a supervisor
 * asking whether the process can work at all. Neither shows an operator the
 * shape of the load over time -- a queue growing behind one busy role, every
 * place of a worker taken, a company's spend climbing toward its ceiling at
 * three in the morning -- and that is what a Prometheus server, and the graphs
 * and alerts built on it, are for. The numbers are served in its text format,
 * which every scraper reads (Prometheus, VictoriaMetrics, Grafana Alloy, the
 * OpenTelemetry collector's Prometheus receiver), rather than pushed to one
 * vendor's API, and without a client library: the format is a few lines of
 * text, and a dependency would be a larger thing to trust than they are.
 *
 * Read from the database at each scrape, over the partial indexes the worker
 * already keeps for claiming, so a scrape costs a handful of index scans:
 * only live work is counted, never the history, which grows without end.
 * What finished is counted by the process that finished it, as counters that
 * start again at zero with it (`WorkerCounts`).
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { withControlPlane } from '../db/tenant.ts';
import { adminPool, appPool } from '../db/pool.ts';
import { SILENT_AFTER_SECONDS } from '../engine/checkout.ts';
import type { WorkerCounts } from '../worker.ts';

type Labels = Record<string, string>;

interface Family {
  name: string;
  type: 'gauge' | 'counter';
  help: string;
  samples: Array<{ labels?: Labels; value: number }>;
}

export interface MetricsSource {
  worker: { counts: WorkerCounts; lastTickAt: Date | null };
}

/** The statuses a task is live in: counted here, where the terminal ones are not. */
const LIVE = ['pending', 'checked_out', 'running', 'waiting_approval', 'waiting_review', 'waiting_window'];

/**
 * How long the event loop was held, measured from the first scrape on.
 * Started lazily, so a deployment with metrics off pays nothing for it.
 */
let loopDelay: IntervalHistogram | null = null;

/** The whole answer to one scrape. */
export async function metricsText(source: MetricsSource): Promise<string> {
  if (!loopDelay) {
    loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
  }
  return render([...processMetrics(), ...poolMetrics(), ...workerMetrics(source.worker), ...await deploymentMetrics()]);
}

function processMetrics(): Family[] {
  const memory = process.memoryUsage();
  // Nanoseconds, over the time since the last scrape; reset so each scrape
  // says what happened since the one before rather than since the start.
  const p99 = loopDelay!.percentile(99) / 1e9;
  const max = loopDelay!.max / 1e9;
  loopDelay!.reset();
  return [
    gauge('process_start_time_seconds', 'When this process started, in seconds since the epoch.',
      Math.round((Date.now() - process.uptime() * 1000) / 1000)),
    gauge('process_resident_memory_bytes', 'Resident memory of this process.', memory.rss),
    gauge('nodejs_heap_used_bytes', 'JavaScript heap in use.', memory.heapUsed),
    gauge('nodejs_heap_total_bytes', 'JavaScript heap reserved.', memory.heapTotal),
    gauge('nodejs_eventloop_delay_p99_seconds',
      'The 99th percentile of how long the event loop was held, since the previous scrape.', finite(p99)),
    gauge('nodejs_eventloop_delay_max_seconds',
      'The longest the event loop was held, since the previous scrape.', finite(max)),
  ];
}

/** Connections to the database, by pool: a pool with callers waiting is the first sign of a stall. */
function poolMetrics(): Family[] {
  const samples: Family['samples'] = [];
  for (const [name, pool] of [['app', appPool()], ['admin', adminPool()]] as const) {
    samples.push(
      { labels: { pool: name, state: 'idle' }, value: pool.idleCount },
      { labels: { pool: name, state: 'busy' }, value: pool.totalCount - pool.idleCount },
      { labels: { pool: name, state: 'waiting' }, value: pool.waitingCount },
    );
  }
  return [{
    name: 'palugada_database_connections', type: 'gauge',
    help: 'Connections to the database this process holds, and callers waiting for one, by pool.',
    samples,
  }];
}

function workerMetrics(source: MetricsSource['worker']): Family[] {
  const counts = source.counts;
  return [
    gauge('palugada_worker_places', 'Places this worker runs tasks in (PALUGADA_WORKER_CONCURRENCY).', counts.places),
    gauge('palugada_worker_places_busy', 'Places running a task now.', counts.busy),
    gauge('palugada_worker_last_tick_timestamp_seconds',
      'When the worker last finished a pass of its housekeeping, in seconds since the epoch; 0 before the first.',
      source.lastTickAt ? source.lastTickAt.getTime() / 1000 : 0),
    {
      name: 'palugada_worker_runs_total', type: 'counter',
      help: 'Runs this worker has finished since it started, by how they ended.',
      samples: [...counts.runs].map(([status, value]) => ({ labels: { status }, value })),
    },
    {
      name: 'palugada_worker_stage_failures_total', type: 'counter',
      help: 'Stages of a pass that failed since this worker started, by stage; the logs say why.',
      samples: [...counts.stageFailures].map(([stage, value]) => ({ labels: { stage }, value })),
    },
    {
      name: 'palugada_worker_loop_failures_total', type: 'counter',
      help: 'Passes of the housekeeping loop, and of a place, that failed outright since this worker started.',
      samples: [
        { labels: { loop: 'tick' }, value: counts.loopFailures.tick },
        { labels: { loop: 'place' }, value: counts.loopFailures.place },
      ],
    },
  ];
}

/**
 * Everything read from the database, on the control plane: the numbers are
 * about every company, and no one company's scope could read them.
 */
async function deploymentMetrics(): Promise<Family[]> {
  return withControlPlane(async (tx) => {
    const stopped = await tx.query<{ stopped: boolean }>(
      'SELECT stop_all_requested_at IS NOT NULL AS stopped FROM platform_control',
    );
    const workers = await tx.query<{ alive: string }>(
      'SELECT count(*) AS alive FROM worker_heartbeats WHERE beat_at >= now() - make_interval(secs => $1)',
      [SILENT_AFTER_SECONDS],
    );
    const companies = await tx.query<{ frozen: boolean; count: string }>(
      'SELECT frozen_at IS NOT NULL AS frozen, count(*) AS count FROM companies GROUP BY 1',
    );
    const tasks = await tx.query<{ slug: string; status: string; count: string }>(
      `SELECT c.slug, t.status, count(*) AS count
         FROM tasks t JOIN companies c ON c.id = t.company_id
        WHERE t.status = ANY($1::text[])
        GROUP BY c.slug, t.status`,
      [LIVE],
    );
    const oldest = await tx.query<{ slug: string; age: number }>(
      `SELECT c.slug, extract(epoch FROM now() - min(t.created_at))::float8 AS age
         FROM tasks t JOIN companies c ON c.id = t.company_id
        WHERE t.status = 'pending'
        GROUP BY c.slug`,
    );
    const runs = await tx.query<{ slug: string; count: string; quiet: number }>(
      `SELECT c.slug, count(*) AS count,
              extract(epoch FROM now() - min(coalesce(r.last_heartbeat_at, r.started_at)))::float8 AS quiet
         FROM agent_runs r JOIN companies c ON c.id = r.company_id
        WHERE r.status = 'running'
        GROUP BY c.slug`,
    );
    const inbox = await tx.query<{ slug: string; kind: string; count: string }>(
      `SELECT c.slug, i.kind, count(*) AS count
         FROM inbox_items i JOIN companies c ON c.id = i.company_id
        WHERE i.status = 'open'
        GROUP BY c.slug, i.kind`,
    );
    const budgets = await tx.query<{
      slug: string; money_spent: string; money_max: string; tokens_spent: string; tokens_max: string;
    }>(
      `SELECT c.slug,
              sum(b.money_spent_cents) AS money_spent, sum(b.money_max_cents) AS money_max,
              sum(b.tokens_spent) AS tokens_spent, sum(b.tokens_max) AS tokens_max
         FROM budget_accounts b JOIN companies c ON c.id = b.company_id
        WHERE b.scope_type = 'company'
        GROUP BY c.slug`,
    );
    return [
      gauge('palugada_platform_stopped', '1 while the owner\'s stop of all work is in effect.',
        stopped.rows[0]?.stopped ? 1 : 0),
      gauge('palugada_workers_alive',
        `Workers of this deployment that have said they are alive in the last ${SILENT_AFTER_SECONDS} seconds.`,
        Number(workers.rows[0]?.alive ?? 0)),
      {
        name: 'palugada_companies', type: 'gauge', help: 'Companies, by whether the owner has frozen them.',
        samples: companies.rows.map((row) => ({
          labels: { state: row.frozen ? 'frozen' : 'active' }, value: Number(row.count),
        })),
      },
      {
        name: 'palugada_tasks', type: 'gauge',
        help: 'Live tasks, by company and status; finished ones are not counted.',
        samples: tasks.rows.map((row) => ({ labels: { company: row.slug, status: row.status }, value: Number(row.count) })),
      },
      {
        name: 'palugada_tasks_pending_oldest_age_seconds', type: 'gauge',
        help: 'Seconds since the oldest pending task of each company was created.',
        samples: oldest.rows.map((row) => ({ labels: { company: row.slug }, value: finite(row.age) })),
      },
      {
        name: 'palugada_runs_running', type: 'gauge', help: 'Runs going on now, by company.',
        samples: runs.rows.map((row) => ({ labels: { company: row.slug }, value: Number(row.count) })),
      },
      {
        name: 'palugada_runs_quiet_seconds', type: 'gauge',
        help: 'Seconds since the quietest running run of each company last showed progress.',
        samples: runs.rows.map((row) => ({ labels: { company: row.slug }, value: finite(row.quiet) })),
      },
      {
        name: 'palugada_inbox_open', type: 'gauge',
        help: 'Items waiting for the owner, by company and kind.',
        samples: inbox.rows.map((row) => ({ labels: { company: row.slug, kind: row.kind }, value: Number(row.count) })),
      },
      {
        name: 'palugada_budget_spent_cents', type: 'gauge',
        help: 'Money a company has spent against its company-wide budget, in cents.',
        samples: budgets.rows.map((row) => ({ labels: { company: row.slug }, value: Number(row.money_spent) })),
      },
      {
        name: 'palugada_budget_limit_cents', type: 'gauge',
        help: 'The ceiling of a company\'s company-wide budget, in cents.',
        samples: budgets.rows.map((row) => ({ labels: { company: row.slug }, value: Number(row.money_max) })),
      },
      {
        name: 'palugada_budget_spent_tokens', type: 'gauge',
        help: 'Tokens a company has spent against its company-wide budget.',
        samples: budgets.rows.map((row) => ({ labels: { company: row.slug }, value: Number(row.tokens_spent) })),
      },
      {
        name: 'palugada_budget_limit_tokens', type: 'gauge',
        help: 'The token ceiling of a company\'s company-wide budget.',
        samples: budgets.rows.map((row) => ({ labels: { company: row.slug }, value: Number(row.tokens_max) })),
      },
    ];
  });
}

function gauge(name: string, help: string, value: number): Family {
  return { name, type: 'gauge', help, samples: [{ value }] };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** The Prometheus text exposition format, version 0.0.4. */
function render(families: Family[]): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const labels = Object.entries(sample.labels ?? {});
      const inside = labels.map(([key, value]) =>
        `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',');
      lines.push(`${family.name}${inside ? `{${inside}}` : ''} ${sample.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
