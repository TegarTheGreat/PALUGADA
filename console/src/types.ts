/** The shapes the owner API answers with, as the pages read them. */

export type Stage = 'explore' | 'validate' | 'build' | 'launch' | 'grow' | 'wind_down';

export interface Company {
  id: string;
  slug: string;
  name: string;
  frozen: boolean;
  /** What the company produces in; null follows the deployment's default. */
  workLanguage: string | null;
  /** What its agents write to the owner and each other in; null follows the default. */
  talkLanguage: string | null;
  /** Where the company is in its life (0057); null until the owner sets one. */
  stage: Stage | null;
  /** The first metric on its highest active goal, or null when nothing is measured yet. */
  headline: {
    name: string;
    unit: Metric['unit'];
    target: number;
    value: number | null;
    verified: boolean | null;
    progress: number | null;
  } | null;
  /** The role the owner talks to (0068); null only while the company has no roles. */
  ceo: { roleId: string; slug: string; displayName: string | null } | null;
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
  /** A question an agent asked with `owner.ask`: answered, not approved. */
  question: string | null;
  /** The answers it offered to choose from, when it offered some. */
  options: string[] | null;
  goalChain: Array<{ kind: string; statement: string }>;
  /** When an item the owner put off comes back (0060). */
  snoozedUntil: string | null;
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
  /** Tasks under this goal or any goal beneath it: finished, and in all. */
  tasksDone: number;
  tasksTotal: number;
  /** What the goal is measured by, with where each stands. */
  metrics: Metric[];
}

export interface Metric {
  id: string;
  goalId: string;
  slug: string;
  name: string;
  unit: 'currency' | 'count' | 'ratio' | 'percent';
  direction: 'up' | 'down';
  baseline: number;
  target: number;
  dueOn: string | null;
  sourceCapability: string | null;
  latest: { value: number; observedAt: string; verified: boolean; recordedBy: string } | null;
  progress: number | null;
  history: Array<{ value: number; observedAt: string; verified: boolean }>;
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
  /** Who the role is and how it works: first in every run's context. */
  charter: string;
  doneCriteria: string[];
  /** Who it is: the name the owner calls it, its title, and the way of working it takes after. */
  displayName: string | null;
  title: string | null;
  persona: RolePersona | null;
}

/** The persona a role takes after, and the owner's own words about how it should be. */
export interface RolePersona {
  preset?: string;
  notes?: string;
}

/** A way of working a role can take after (src/domain/personas.ts). */
export interface PersonaPreset {
  id: string;
  title: string;
  label: string;
  inspiredBy: string;
  principles: string[];
  manner: string;
  decides: string;
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
  /** What it produced, in one line, once it has; null before. */
  result: string | null;
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
  progress: {
    stepsDone: number;
    currentStep: string | null;
    currentStepStatus: string | null;
    planSteps: number | null;
    worker: string | null;
    heartbeatAt: string | null;
    deadlineAt: string | null;
  };
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

export type MemoryKind = 'working' | 'episodic' | 'semantic' | 'procedural';

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  body: string;
  scopeType: string;
  scopeName: string | null;
  confidence: number;
  unverified: boolean;
  source: string;
  factKind: string | null;
  approval: string;
  supersededBy: string | null;
  createdAt: string;
}

/** Something a task wrote down for a person to read: a document, an email. */
export interface Deliverable {
  step: number;
  capability: string;
  title: string;
  path: string;
  text: string;
  words: number | null;
  to: string | null;
  at: string | null;
}

/** One task with what it produced (`GET /tasks/:taskId`). */
export interface TaskDetail {
  id: string;
  status: string;
  input: unknown;
  output: unknown;
  deliverables: Deliverable[];
  /** The owner's last word on it, or null. */
  feedback: { verdict: 'good' | 'needs_work'; note: string | null; at: string } | null;
}

/** One thing the search found, in any company (`GET /api/search`). */
export interface SearchHit {
  kind: 'task' | 'decision' | 'memory';
  id: string;
  companyId: string;
  company: string;
  title: string;
  detail: string | null;
  status: string | null;
  at: string;
}

/** When one role finishes, another takes over (0058). */
export interface HandoffRule {
  id: string;
  fromRoleId: string;
  fromRoleSlug: string;
  toRoleId: string;
  toRoleSlug: string;
  brief: string;
  enabled: boolean;
  createdAt: string;
}

/** How a trigger's caller proves itself (0056). */
export type TriggerScheme = 'bearer' | 'github' | 'stripe' | 'slack' | 'standard';

/** An inbound trigger (0054): a URL another service posts events to. */
export interface Trigger {
  id: string;
  slug: string;
  publicId: string;
  roleId: string;
  roleSlug: string;
  goalId: string;
  instruction: string;
  maxPerHour: number;
  enabled: boolean;
  scheme: TriggerScheme;
  /** Where a signed trigger's secret is kept; never the secret. */
  secretRef: string | null;
  /** False for a restored trigger until a token is made for it. */
  hasToken: boolean;
  deliveriesLastHour: number;
  lastDeliveryAt: string | null;
  createdAt: string;
}

/** One recorded version of a piece of configuration (F3.9). */
export interface ConfigVersion {
  id: string;
  kind: string;
  subjectId: string | null;
  version: number;
  snapshot: Record<string, unknown>;
  summary: string;
  changedBy: string;
  createdAt: string;
}

/** A policy as the company's policy list shows it. */
export interface PolicyRow {
  id: string;
  slug: string;
  effect: string;
  condition: unknown;
  mode: string;
  scope: 'platform' | 'company' | 'division';
  division: string | null;
  createdAt: string;
}
