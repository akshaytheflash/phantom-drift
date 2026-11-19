export { canonicalJson, hashValue, sha256Hex } from "./canonical.js";
export {
  computeMac,
  GENESIS_MAC,
  macInput,
  verifyChain,
  verifyMac,
  type ChainVerification,
  type LedgerKey,
  type SignedEntry
} from "./ledger.js";
export {
  decodeInvisible,
  encodeInvisible,
  parseMarkers,
  stripMarkersDeep,
  stripMarkersFromText,
  type Marker
} from "./markers.js";
export {
  buildObservation,
  collectPages,
  indexSources,
  sourceKey,
  stringLeaves,
  type ListFetcher,
  type Observation,
  type ObservationInput,
  type SourceKind,
  type SourceRecord
} from "./snapshot.js";
export {
  classifyChanges,
  maxSeverity,
  rank,
  SEVERITY_ORDER,
  tokenDiff,
  tokenize,
  type ChangeClass,
  type Continuation,
  type DriftReport,
  type Severity,
  type SourceChange
} from "./drift.js";
export {
  LedgerError,
  ServerLedger,
  formatMeridian,
  type LedgerBody,
  type LedgerEventEntry,
  type LedgerObservationEntry,
  type LedgerVerification,
  type StoredEntry
} from "./store.js";
export {
  ConfigError,
  defaultConfigCandidates,
  discoverServers,
  expandEnv,
  findServer,
  parseConfig,
  stripJsonComments,
  type ConfigFormat,
  type DiscoveredServer,
  type ServerSpec
} from "./config.js";
export {
  connectServer,
  collectObservationInput,
  errorMessage,
  readClientMeta,
  type CollectOptions,
  type ConnectOptions,
  type CollectResult
} from "./session.js";
export {
  LineDecoder,
  runProxy,
  type ProxyEvent,
  type ProxyHandle,
  type ProxyOptions
} from "./proxy.js";
export {
  captureServer,
  createService,
  diffObservations,
  ledgerFor,
  markTaint,
  observeServer,
  sessionId,
  summariseServer,
  verifyLedger,
  type LedgerSummary,
  type MarkResult,
  type ObserveResult,
  type ServiceOptions,
  type VerifyResult
} from "./service.js";
export { formatReport, truncate, verdictFor, type ReportInput, type Verdict } from "./report.js";
export { ensureDir, KeyStore, resolvePaths, serverId, type PhantomPaths } from "./home.js";
export { run, parseArgs, UsageError, VERSION, type RunResult } from "./cli.js";
