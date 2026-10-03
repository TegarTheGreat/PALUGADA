/** The shapes the owner API answers with, as the pages read them. */

export type Stage = 'explore' | 'validate' | 'build' | 'launch' | 'grow' | 'wind_down';

export interface Company {
  id: string;
  slug: string;
  name: string;
  frozen: boolean;
  /** When a closing company is erased (0088); null when it is not closing. */
  eraseAfter: string | null;
  /** What the company produces in; null follows the deployment's default. */
  workLanguage: string | null;
  /** What its agents write to the owner and each other in; null follows the default. */
  talkLanguage: string | null;
  /** Whether a model judges low-tier calls after the work read content from outside (0092). */
  guardian: boolean;
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
  /** The name the owner gave that role. */
  roleName: string | null;
  divisionName: string | null;
  /** A question an agent asked with `owner.ask`: answered, not approved. */
  question: string | null;
  /** The answers it offered to choose from, when it offered some. */
  options: string[] | null;
  goalChain: Array<{ kind: string; statement: string }>;
  /** When an item the owner put off comes back (0060). */
  snoozedUntil: string | null;
  /** What an approval's action is called with, redacted; absent on anything else. */
  input?: unknown;
  /** Whether it may be approved for a while (0083): a policy asked, at tier 2 or below. */
  allowFor?: boolean;
  /** How many skills a skill card asks about: one, or all a bundle brought (B9). */
  skillCount?: number | null;
  /**
   * What the owner asked on this card and what the agent answered, oldest
   * first; a question still waiting for its answer is last, with none (N6).
   */
  asked?: Array<{ question: string; answer: string | null }>;
}

/** A yes the owner gave for a while (0083). */
export interface StandingApproval {
  id: string;
  roleId: string;
  roleSlug: string;
  /** The name the owner gave the role; the console shows it in place of the code. */
  roleName: string | null;
  capabilityName: string;
  grantedByItem: string;
  createdAt: string;
  expiresAt: string;
  uses: number;
  lastUsedAt: string | null;
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
  /** When the owner retired it; its history is kept and it takes no more values. */
  retiredAt: string | null;
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
  grants: Array<{ capability: string; tier: number | null; maxInFlight: number | null }>;
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
  /** How long one run may take (0084); null is no limit beyond the task's deadline. */
  maxRunSeconds: number | null;
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
  projects: Array<{
    id: string; slug: string; name: string; description: string | null; archivedAt: string | null;
    /** Its own work language (0100); null where its work is in the company's. */
    workLanguage: string | null;
    openTasks: number; doneTasks: number; costCents: number;
  }>;
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
  /** The name the owner gave the role; the console shows it in place of the code. */
  roleName: string | null;
  divisionName: string;
  projectId: string;
  projectName: string;
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
    /** The actions of its plan it has taken; null with no plan. */
    planDone: number | null;
    worker: string | null;
    heartbeatAt: string | null;
    deadlineAt: string | null;
  };
  /** What a task in `waiting_window` waits for; null in any other status (N9). */
  waiting: {
    reason: 'child' | 'window' | 'cheap_hours' | 'vendor' | 'slot' | 'model' | 'service' | 'retry' | null;
    until: string | null;
    on: WaitingRole | null;
    needsYou: WaitingRole | null;
  } | null;
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
  /** What the owner calls it: its division's name, the owner's own label, or null for the whole company. */
  name: string | null;
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
  /** The name the owner gave the role; the console shows it in place of the code. */
  roleName: string | null;
  divisionName: string;
  priority: number;
  /** What each run reserves from its budget account. */
  reserveTokens: number;
  /** The most one run may spend: its role's ceiling for a run (N10). */
  runCeilingTokens: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  failure: string | null;
  /** What a due run does while the last one is still going (F9.1). */
  overlap: 'skip' | 'queue' | 'allow';
  /** How late a missed run may be and still happen; null always runs one. */
  catchUpMinutes: number | null;
  /** The run a queued one is waiting for, while it waits. */
  waitingFor: string | null;
  /** The last run that did not happen, and why. */
  lastSkipped: { occurrence: string; because: 'overlap' | 'late'; occurrences: number; taskId: string | null } | null;
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
  taskId: string;
  roleSlug: string;
  /** The name the owner gave the role; the console shows it in place of the code. */
  roleName: string | null;
  status: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  haltReason: string | null;
  steps: TraceStep[];
  tokens: { input: number; output: number };
  costCents: number;
}

/** What one run was told (0076): the request its runtime received. */
export interface RunBriefing {
  agentRunId: string;
  attempt: number;
  startedAt: string;
  briefing: {
    cut?: boolean;
    characters?: number;
    start?: string;
    task?: { input: Record<string, unknown> };
    contextPack?: {
      charter: string;
      skills: string[];
      memories: string[];
      goalAncestry: Array<{ kind: string; statement: string }>;
      notes: Array<{ title: string; body: string }>;
      workingMemory: Array<{ name: string; output: unknown }>;
    };
    allowedTools?: Array<{ name: string; tier: number }>;
    modelRouting?: { primary: string; fallback: string[] };
    limits?: { tokens: number; wallClockMs: number };
  } | null;
  removed: 'retention' | 'never_kept' | null;
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

/** Where a skill's newest version is on its way to the runs. */
export type SkillStage = 'active' | 'screening' | 'with_reviewer' | 'waiting_for_you' | 'rejected' | 'superseded';

export interface SkillVersion {
  id: string;
  version: number;
  state: string;
  stage: SkillStage;
  author: string;
  changelog: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewTaskId: string | null;
  rejectedReason: string | null;
  activatedAt: string | null;
}

export interface Skill {
  id: string;
  slug: string;
  summary: string;
  scopeType: string;
  divisionId: string | null;
  divisionName: string | null;
  quarantined: boolean;
  origin: string | null;
  activeVersion: number | null;
  checks: number;
  latest: SkillVersion | null;
}

export interface SkillDetail {
  skill: Skill;
  versions: Array<SkillVersion & { body: string }>;
  checks: Array<{ id: string; name: string; expectContains: string[] }>;
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
  /** Learned from content the company did not write; shown to runs as data. */
  outside: boolean;
  /** The finished work that taught it. */
  sourceTaskId: string | null;
  /** How many more times the same lesson has been learned. */
  reinforcedCount: number;
  divisionId: string | null;
}

/** Something a task wrote down for a person to read: a document, an email. */
/** One thing the company produced for a person to read, across every task (the gallery). */
export interface GalleryItem {
  taskId: string;
  step: number;
  capability: string;
  title: string;
  path: string;
  excerpt: string;
  words: number | null;
  to: string | null;
  at: string;
  roleSlug: string;
  roleName: string | null;
  /** What the task that made it was asked to do. */
  task: string;
}

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

/**
 * How a run said it met one done criterion, and whether the platform could
 * check it: `verified` when the evidence cites a tool call of the task that
 * succeeded (`step:<n>`), `claimed` when it is the run's word alone.
 */
export interface DoneReportEntry {
  criterion: string;
  met: boolean;
  evidence: string;
  check: 'verified' | 'claimed';
  steps: Array<{ step: number; capability: string }>;
}

/** One task with what it produced (`GET /tasks/:taskId`). */
export interface TaskDetail {
  id: string;
  status: string;
  input: unknown;
  output: unknown;
  /** The run's report on its done criteria, weighed against its journal; null when it made none. */
  done: DoneReportEntry[] | null;
  deliverables: Deliverable[];
  /** The work it handed to other roles, oldest first, with what each piece came to. */
  handedOn: HandedPiece[];
  /** The task that handed this one on, or null when the owner, a schedule or a trigger gave it. */
  handedBy: { id: string; role: string; roleName: string | null } | null;
  /** The owner's last word on it, or null. */
  feedback: { verdict: 'good' | 'needs_work'; note: string | null; at: string } | null;
}

/** One piece of work a task handed on. */
export interface HandedPiece {
  id: string;
  role: string;
  roleName: string | null;
  status: string;
  result: string | null;
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
  /** The names the owner gave the two roles; shown in place of their codes. */
  fromRoleName: string | null;
  toRoleName: string | null;
  brief: string;
  enabled: boolean;
  createdAt: string;
}

/** How a trigger's caller proves itself (0056). */
export type TriggerScheme = 'bearer' | 'url' | 'github' | 'stripe' | 'slack' | 'standard';

/** An inbound trigger (0054): a URL another service posts events to. */
export interface Trigger {
  id: string;
  slug: string;
  publicId: string;
  roleId: string;
  roleSlug: string;
  /** The name the owner gave the role; the console shows it in place of the code. */
  roleName: string | null;
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
/** One charter's current version (F3.1). */
export interface Charter {
  version: number;
  body: string;
  createdAt: string;
}

/** The company's charter and the platform's above it; null where there is none. */
export interface Charters {
  company: Charter | null;
  platform: Charter | null;
}

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

/** Something owed and not yet anyone's (0070). */
export interface Ticket {
  id: string;
  projectId: string;
  divisionId: string | null;
  title: string;
  body: string;
  status: 'open' | 'in_progress' | 'done' | 'closed';
  priority: number;
  openedBy: 'owner' | 'agent';
  openedByTaskId: string | null;
  workingTaskId: string | null;
  closedReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** A piece of work a waiting task is held up by, and whose it is. */
export interface WaitingRole {
  taskId: string;
  role: string;
  roleName: string | null;
}

/** A staff seat signed in beside the owner (0110): who, what it may do, and its one company. */
export interface Staff {
  name: string;
  kind: 'viewer' | 'approver';
  companyId: string;
}
