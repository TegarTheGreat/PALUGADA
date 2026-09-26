/** The shapes the owner API answers with, as the pages read them. */

export interface Company {
  id: string;
  slug: string;
  name: string;
  frozen: boolean;
}

export interface InboxItem {
  id: string;
  kind: 'approval' | 'incident' | 'escalation' | string;
  status: string;
  title: string;
  actionSummary: string;
  rationale: string;
  tier: number | null;
  estimatedCostCents: number;
  consequenceIfDenied: string;
  taskId: string | null;
  expiresAt: string | null;
  createdAt: string;
  capabilityName: string | null;
  roleSlug: string | null;
  divisionName: string | null;
  goalChain: Array<{ kind: string; statement: string }>;
}

export interface Digest {
  day: string;
  moneySpentCents: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksHalted: number;
  openInboxItems: number;
  openIncidents: number;
  highlights: string[];
}

export interface Retro {
  weekEnding: string;
  tasksCompleted: number;
  tasksStopped: number;
  moneySpentCents: number;
  costliestDivisions: Array<{ label: string; costCents: number }>;
  sopCandidatesPending: number;
  decisionsRecorded: number;
}

export interface Spend {
  limitCents: number;
  pausedAt: string | null;
  pauseReason: string | null;
  overrideUntil: string | null;
  periodStart: string;
  periodEnd: string;
  spentCents: number;
}

export interface CostPeriod {
  period: string;
  costCents: number;
  tokens: number;
}

export interface Goal {
  id: string;
  parentId: string | null;
  kind: string;
  slug: string;
  statement: string;
  status: string;
}

export interface Division {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  depth: number;
  maxConcurrency: number;
  escalationRole: string | null;
  escalateAfterMinutes: number | null;
  openTasks: number;
  grants: Array<{ capability: string; tier: number | null }>;
}

export interface Role {
  id: string;
  divisionId: string;
  slug: string;
  model: string;
  runtime: string | null;
  tools: string[];
  heartbeatMinutes: number | null;
  dormantUntil: string | null;
  frozenAt: string | null;
  frozenReason: string | null;
  openTasks: number;
  doneLastWeek: number;
}

export interface Structure {
  projects: Array<{ id: string; slug: string; name: string }>;
  goals: Goal[];
  divisions: Division[];
  roles: Role[];
}

export type WorkGroup = 'active' | 'waiting' | 'done' | 'stopped';

export interface WorkItem {
  id: string;
  status: string;
  haltReason: string | null;
  summary: string;
  roleSlug: string;
  divisionName: string;
  goal: string | null;
  schedule: string | null;
  priority: number;
  attempt: number;
  attemptMax: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  costCents: number;
  parentTaskId: string | null;
}

export interface ActivityItem {
  id: string;
  type: string;
  actor: string;
  occurredAt: string;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export interface Account {
  id: string;
  label: string;
  scopeType: string;
  scopeId: string | null;
  scopeName: string | null;
  parentId: string | null;
  tokensMax: number;
  tokensSpent: number;
  tokensReserved: number;
  moneyMaxCents: number;
  moneySpentCents: number;
}

export interface Schedule {
  id: string;
  slug: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  roleSlug: string;
  divisionName: string;
  priority: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  failure: string | null;
}

export interface Device {
  id: string;
  name: string;
  runtime: string;
  status: string;
  quarantined: boolean;
  pairedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  keyFingerprint: string | null;
}

export interface ClosedDecision {
  id: string;
  kind: string;
  title: string;
  actionSummary: string;
  tier: number | null;
  status: string;
  decision: string | null;
  note: string | null;
  via: string | null;
  closedReason: string | null;
  taskId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface TraceStep {
  at: string;
  kind: string;
  name: string;
  detail: Record<string, unknown>;
}

export interface TraceRun {
  agentRunId: string;
  roleSlug: string;
  status: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  haltReason: string | null;
  steps: TraceStep[];
  tokens: { input: number; output: number };
  costCents: number;
}

export interface Trace {
  reason?: string;
  runs: TraceRun[];
  calls: Array<{
    id: string;
    kind: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    latencyMs: number | null;
    occurredAt: string;
  }>;
}

export interface Skill {
  id: string;
  slug: string;
  scopeType: string;
  activeVersion: string | null;
  quarantined: boolean;
  origin: string | null;
}

export interface Publisher {
  label: string;
  fingerprint: string;
  revokedAt: string | null;
}
