import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  fstatSync,
  linkSync,
} from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

export const REPORT_CANDIDATE_SCHEMA_VERSION = 'report-candidate.v1' as const;
export const REPORT_PROMOTION_REQUEST_SCHEMA_VERSION = 'report-promotion-request.v1' as const;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 500;
const MAX_REF_LENGTH = 1_000;
const MAX_REASON_LENGTH = 2_000;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u;

export type ReportAttentionRequest = 'NONE' | 'READ' | 'ANSWER' | 'DECIDE' | 'APPROVE' | 'REQUEST_CHANGE';

export type AgentReportCandidate = {
  schema_version: typeof REPORT_CANDIDATE_SCHEMA_VERSION;
  title?: string;
  report_ref?: string;
  project_ref?: string | null;
  family_ref?: string | null;
  attention: {
    request: ReportAttentionRequest;
    reason_code?: string | null;
    reason?: string | null;
    review_by?: string | null;
    expires_at?: string | null;
  };
};

export type ReportPromotionRequest = {
  schemaVersion: typeof REPORT_PROMOTION_REQUEST_SCHEMA_VERSION;
  contentPath: string;
  title: string;
  reportRef: string;
  sourceRef: string;
  projectRef?: string | null;
  familyRef?: string | null;
  producer: {
    kind: 'AGENT';
    id: string;
    label: string;
  };
  attention: {
    request: ReportAttentionRequest;
    reasonCode?: string | null;
    reason?: string | null;
    reviewBy?: string | null;
    expiresAt?: string | null;
  };
  occurredAt: string;
};

export type ReportCandidateReceipt = {
  schema_version: 'report-candidate-receipt.v1';
  status: 'recorded' | 'already_recorded' | 'not_configured' | 'conflict' | 'write_failed';
  candidate_id: string;
  report_ref: string;
  request_path: string | null;
  error: 'REPORT_PROMOTION_REQUEST_DIR_NOT_CONFIGURED' | 'REPORT_CANDIDATE_CONFLICT' | 'REPORT_CANDIDATE_WRITE_FAILED' | null;
};

type CandidateContext = {
  dispatchId: string;
  artifactPath: string;
  agentId: string;
  defaultTitle: string;
  occurredAt: string;
};

type UnknownRecord = Record<string, unknown>;

export function parseAgentReportCandidate(value: unknown): AgentReportCandidate {
  const root = record(value, 'REPORT_CANDIDATE_INVALID');
  exactKeys(root, ['schema_version', 'title', 'report_ref', 'project_ref', 'family_ref', 'attention'], 'REPORT_CANDIDATE_UNKNOWN_FIELD');
  if (root.schema_version !== REPORT_CANDIDATE_SCHEMA_VERSION) throw new Error('REPORT_CANDIDATE_SCHEMA_UNSUPPORTED');

  const attention = record(root.attention, 'REPORT_CANDIDATE_ATTENTION_INVALID');
  exactKeys(attention, ['request', 'reason_code', 'reason', 'review_by', 'expires_at'], 'REPORT_CANDIDATE_ATTENTION_UNKNOWN_FIELD');
  const request = text(attention.request, 'attention.request', 32) as ReportAttentionRequest;
  if (!['NONE', 'READ', 'ANSWER', 'DECIDE', 'APPROVE', 'REQUEST_CHANGE'].includes(request)) {
    throw new Error('REPORT_CANDIDATE_ATTENTION_KIND_INVALID');
  }
  const reasonCode = optionalText(attention.reason_code, 'attention.reason_code', 500);
  const reason = optionalText(attention.reason, 'attention.reason', MAX_REASON_LENGTH);
  const reviewBy = optionalIso(attention.review_by, 'attention.review_by');
  const expiresAt = optionalIso(attention.expires_at, 'attention.expires_at');
  if (request === 'NONE' && [reasonCode, reason, reviewBy, expiresAt].some((entry) => entry !== null)) {
    throw new Error('REPORT_CANDIDATE_ATTENTION_METADATA_WITHOUT_REQUEST');
  }

  return {
    schema_version: REPORT_CANDIDATE_SCHEMA_VERSION,
    ...(root.title === undefined ? {} : { title: text(root.title, 'title', MAX_TITLE_LENGTH) }),
    ...(root.report_ref === undefined ? {} : { report_ref: stableRef(root.report_ref, 'report_ref', MAX_REF_LENGTH) }),
    ...(root.project_ref === undefined ? {} : { project_ref: optionalText(root.project_ref, 'project_ref', MAX_REF_LENGTH) }),
    ...(root.family_ref === undefined ? {} : { family_ref: optionalText(root.family_ref, 'family_ref', MAX_REF_LENGTH) }),
    attention: {
      request,
      ...(reasonCode === null ? {} : { reason_code: reasonCode }),
      ...(reason === null ? {} : { reason }),
      ...(reviewBy === null ? {} : { review_by: reviewBy }),
      ...(expiresAt === null ? {} : { expires_at: expiresAt }),
    },
  };
}

export function buildReportPromotionRequest(candidateValue: unknown, context: CandidateContext): ReportPromotionRequest {
  const candidate = parseAgentReportCandidate(candidateValue);
  const dispatchId = trustedText(context.dispatchId, 'dispatchId', 500);
  const artifactPath = trustedText(context.artifactPath, 'artifactPath', 4_000);
  if (!isAbsolute(artifactPath)) throw new Error('REPORT_CANDIDATE_ARTIFACT_PATH_NOT_ABSOLUTE');
  if (!['.md', '.markdown'].includes(extname(artifactPath).toLowerCase())) {
    throw new Error('REPORT_CANDIDATE_ARTIFACT_TYPE_UNSUPPORTED');
  }
  const agentId = trustedText(context.agentId, 'agentId', 500);
  const occurredAt = strictIso(context.occurredAt, 'occurredAt');
  const title = candidate.title ?? trustedText(context.defaultTitle, 'defaultTitle', MAX_TITLE_LENGTH);
  const reportRef = candidate.report_ref ?? stableRef(`report:dispatch:${dispatchId}`, 'reportRef', MAX_REF_LENGTH);
  const sourceRef = `kapelle-dispatch://${encodeURIComponent(dispatchId)}`;

  return {
    schemaVersion: REPORT_PROMOTION_REQUEST_SCHEMA_VERSION,
    contentPath: artifactPath,
    title,
    reportRef,
    sourceRef,
    ...(candidate.project_ref === undefined ? {} : { projectRef: candidate.project_ref }),
    ...(candidate.family_ref === undefined ? {} : { familyRef: candidate.family_ref }),
    producer: { kind: 'AGENT', id: agentId, label: agentId },
    attention: {
      request: candidate.attention.request,
      ...(candidate.attention.reason_code === undefined ? {} : { reasonCode: candidate.attention.reason_code }),
      ...(candidate.attention.reason === undefined ? {} : { reason: candidate.attention.reason }),
      ...(candidate.attention.review_by === undefined ? {} : { reviewBy: candidate.attention.review_by }),
      ...(candidate.attention.expires_at === undefined ? {} : { expiresAt: candidate.attention.expires_at }),
    },
    occurredAt,
  };
}

export function recordReportPromotionRequest(
  request: ReportPromotionRequest,
  configuredDirectory: string | undefined,
): ReportCandidateReceipt {
  const candidateId = createHash('sha256').update(request.sourceRef).digest('hex').slice(0, 24);
  const base = {
    schema_version: 'report-candidate-receipt.v1' as const,
    candidate_id: candidateId,
    report_ref: request.reportRef,
  };
  const trimmed = configuredDirectory?.trim();
  if (!trimmed) {
    return { ...base, status: 'not_configured', request_path: null, error: 'REPORT_PROMOTION_REQUEST_DIR_NOT_CONFIGURED' };
  }

  try {
    const directory = secureDirectory(trimmed);
    const requestPath = join(directory, `${candidateId}.json`);
    const serialized = `${JSON.stringify(request, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new Error('REPORT_CANDIDATE_WRITE_FAILED');

    if (existsSync(requestPath)) {
      const existing = readBoundedRequest(requestPath);
      return existing === serialized
        ? { ...base, status: 'already_recorded', request_path: requestPath, error: null }
        : { ...base, status: 'conflict', request_path: requestPath, error: 'REPORT_CANDIDATE_CONFLICT' };
    }

    const temporaryPath = join(directory, `.${candidateId}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, serialized, { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporaryPath, requestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = readBoundedRequest(requestPath);
        return existing === serialized
          ? { ...base, status: 'already_recorded', request_path: requestPath, error: null }
          : { ...base, status: 'conflict', request_path: requestPath, error: 'REPORT_CANDIDATE_CONFLICT' };
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporaryPath); } catch { /* already removed or never created */ }
    }
    return { ...base, status: 'recorded', request_path: requestPath, error: null };
  } catch {
    return { ...base, status: 'write_failed', request_path: null, error: 'REPORT_CANDIDATE_WRITE_FAILED' };
  }
}

function secureDirectory(configured: string): string {
  if (!isAbsolute(configured)) throw new Error('REPORT_PROMOTION_REQUEST_DIR_INVALID');
  const normalized = resolve(configured);
  if (!existsSync(normalized)) mkdirSync(normalized, { recursive: true, mode: 0o700 });
  const canonical = realpathSync.native(normalized);
  if (canonical !== normalized) throw new Error('REPORT_PROMOTION_REQUEST_DIR_NOT_CANONICAL');
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('REPORT_PROMOTION_REQUEST_DIR_INVALID');
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('REPORT_PROMOTION_REQUEST_DIR_NOT_OWNER_ONLY');
  }
  return canonical;
}

function readBoundedRequest(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || stat.size < 1n
    || stat.size > BigInt(MAX_REQUEST_BYTES)
    || (stat.mode & 0o077n) !== 0n
    || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error('REPORT_CANDIDATE_EXISTING_REQUEST_INVALID');
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.nlink !== 1n) {
      throw new Error('REPORT_CANDIDATE_EXISTING_REQUEST_CHANGED');
    }
    const bytes = readFileSync(descriptor);
    let contents: string;
    try {
      contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error('REPORT_CANDIDATE_EXISTING_REQUEST_INVALID');
    }
    if (!Buffer.from(contents, 'utf8').equals(bytes)) throw new Error('REPORT_CANDIDATE_EXISTING_REQUEST_INVALID');
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || bytes.byteLength !== Number(before.size)
    ) {
      throw new Error('REPORT_CANDIDATE_EXISTING_REQUEST_CHANGED');
    }
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function record(value: unknown, error: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: string[], error: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(error);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`REPORT_CANDIDATE_${field.toUpperCase().replaceAll('.', '_')}_INVALID`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > max || CONTROL_PATTERN.test(normalized)) {
    throw new Error(`REPORT_CANDIDATE_${field.toUpperCase().replaceAll('.', '_')}_INVALID`);
  }
  return normalized;
}

function trustedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`REPORT_CANDIDATE_${field.toUpperCase().replaceAll('.', '_')}_INVALID`);
  }
  if (Buffer.byteLength(value, 'utf8') > max || CONTROL_PATTERN.test(value)) {
    throw new Error(`REPORT_CANDIDATE_${field.toUpperCase().replaceAll('.', '_')}_INVALID`);
  }
  return value;
}

function stableRef(value: unknown, field: string, max: number): string {
  const ref = text(value, field, max);
  if (!ref.includes(':')) throw new Error(`REPORT_CANDIDATE_${field.toUpperCase().replaceAll('.', '_')}_INVALID`);
  return ref;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, max);
}

function strictIso(value: unknown, field: string): string {
  const candidate = text(value, field, 64);
  if (!ISO_UTC_PATTERN.test(candidate) || new Date(candidate).toISOString() !== candidate) {
    throw new Error(`REPORT_CANDIDATE_${field.toUpperCase().replaceAll('.', '_')}_INVALID`);
  }
  return candidate;
}

function optionalIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return strictIso(value, field);
}
