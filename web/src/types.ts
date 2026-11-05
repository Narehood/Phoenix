export type User = {
  id: string;
  name: string;
  role: "admin" | "operator" | "viewer";
  active: boolean;
};
export type Service = {
  name: string;
  load: string;
  active: string;
  sub: string;
};
export type Process = { pid: number; name: string; memoryBytes: number };
export type Reading = {
  measuredAt: number;
  collectedAt: number;
  cpuPercent: number | null;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  networkRx: number;
  networkTx: number;
  networkRxBps: number | null;
  networkTxBps: number | null;
  uptimeSeconds: number;
  bootId: string;
  processes: Process[];
  services: Service[];
  collectionErrors: string[];
};
export type Host = {
  id: string;
  name: string;
  os: string;
  osVersion: string;
  addresses: string[];
  tags: string[];
  groups: string[];
  connectionMethod: string;
  agentVersion: string;
  lastContact: number;
  revoked: boolean;
  verified: boolean;
  certificateFingerprint: string;
  generation: number;
  bootId: string;
  connectivity: string;
  freshness: string;
  resourceHealth: string;
  latest: Reading | null;
};
export type Result = {
  state: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: number;
  finishedAt: number;
  truncated: boolean;
};
export type Job = {
  id: string;
  hostId: string;
  actor: string;
  action: string;
  args: { service?: string; diagnostic?: string };
  state: string;
  createdAt: number;
  expiresAt: number;
  deadline: number;
  dispatchedAt: number;
  finishedAt: number;
  cancelRequested: boolean;
  canCancel?: boolean;
  canReadOutput?: boolean;
  hostName?: string;
  rebootObserved: boolean;
  result?: Result;
};
export type Audit = {
  id: number;
  at: number;
  actor: string;
  hostId: string;
  action: string;
  jobId: string;
  state: string;
};
export type Observation = {
  monitorId: string;
  nodeId: string;
  state: string;
  checkedAt: number;
  latencyMs: number;
};
export type Monitor = {
  monitor: { id: string; name: string; intervalMs: number; nodeIds: string[] };
  state: string;
  observations: Observation[] | null;
  maintenanceIds: string[];
  unknownNodes: number;
  configConflict: boolean;
};
export type Source = {
  id: string;
  node: { id: string; name: string };
  revision: string;
  collectedAt: number;
  measuredAt: number;
  freshness: string;
  error: string;
  monitors: Monitor[];
  maintenance: unknown[];
};
export type Mapping = { hostId: string; sourceId: string; monitorId: string };
export type Canary = { sources: Source[]; mappings: Mapping[]; now: number };
export type Grant = { scopeType: string; scope: string; action: string };
export type Project = {
  id: string;
  name: string;
  description: string;
  modules: string[];
  archived: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type ProjectCapability = {
  id: string;
  enabled: boolean;
  state: string;
  reason: string;
  actions: string[];
};
export type ProjectCapabilities = {
  contractVersion: number;
  projectId: string;
  revision: number;
  permissions: string[] | null;
  modules: ProjectCapability[];
};
export type ProjectEvent = {
  at: number;
  actor: string;
  action: string;
  revision: number;
};
export type Collection<T> = {
  state: string;
  truncated: boolean;
  items: T[] | null;
};
export type PullRequest = {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  updatedAt: string;
  dependencyUpdate: boolean;
  updateKind: string;
  mergeable: string;
  reviewState: string;
  checks: string;
};
export type WorkflowRun = {
  name: string;
  url: string;
  status: string;
  conclusion: string;
  sha: string;
};
export type DependabotAlert = {
  number: number;
  package: string;
  ecosystem: string;
  severity: string;
  summary: string;
  fixedIn: string;
  url: string;
};
export type GitHubSnapshot = {
  repository: {
    fullName: string;
    url: string;
    private: boolean;
    archived: boolean;
    defaultBranch: string;
    pushedAt: string;
  };
  pulls: Collection<PullRequest>;
  defaultBranchCI: Collection<WorkflowRun>;
  alerts: Collection<DependabotAlert>;
  codeScanning: string;
  secretScanning: string;
  dependencyCoverage: string;
};
export type GitHubView = {
  configured: boolean;
  repository: string;
  enabled: boolean;
  revision: number;
  state: string;
  freshness: string;
  error: string;
  lastAttemptAt: number;
  collectedAt: number;
  nextAttemptAt: number;
  snapshot: GitHubSnapshot | null;
};
