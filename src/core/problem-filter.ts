import type { BackupConfig } from '../types/index.js';
import type { Logger } from './utils.js';

export const PROBLEM_FILTER_SUPPORTED_CATEGORIES = new Set([
  'submissions',
  'authored',
  'reviewed',
  'solved',
  'corrected',
  'dataadded',
  'board',
]);

export function hasProblemFilter(config: BackupConfig): boolean {
  return (config.problemIds?.length ?? 0) > 0;
}

export function formatProblemIds(problemIds: number[]): string {
  return problemIds.map((problemId) => `#${problemId}`).join(', ');
}

export function matchesProblemFilter(
  config: BackupConfig,
  problemId?: number,
): boolean {
  if (!hasProblemFilter(config)) {
    return true;
  }
  if (problemId === undefined) {
    return false;
  }
  return config.problemIds?.includes(problemId) ?? false;
}

export function filterProblemItems<T extends { problemId: number }>(
  items: T[],
  config: BackupConfig,
  log: Logger,
  label: string,
): T[] {
  if (!hasProblemFilter(config)) {
    return items;
  }

  const filtered = items.filter(({ problemId }) => matchesProblemFilter(config, problemId));
  const matchedIds = new Set(filtered.map(({ problemId }) => problemId));
  const missing = (config.problemIds ?? []).filter((problemId) => !matchedIds.has(problemId));

  log.info(
    `${label}: 문제 번호 필터 적용 (${filtered.length}/${items.length}개) ` +
      `[${formatProblemIds(config.problemIds ?? [])}]`,
  );

  if (missing.length > 0) {
    log.warn(`${label}: 요청한 문제를 목록에서 찾지 못함 [${formatProblemIds(missing)}]`);
  }

  return filtered;
}

export function filterOptionalProblemItems<T extends { problemId?: number }>(
  items: T[],
  config: BackupConfig,
  log: Logger,
  label: string,
): T[] {
  if (!hasProblemFilter(config)) {
    return items;
  }

  const filtered = items.filter(({ problemId }) => matchesProblemFilter(config, problemId));
  const matchedIds = new Set(
    filtered
      .map(({ problemId }) => problemId)
      .filter((problemId): problemId is number => problemId !== undefined),
  );
  const missing = (config.problemIds ?? []).filter((problemId) => !matchedIds.has(problemId));

  log.info(
    `${label}: 문제 번호 필터 적용 (${filtered.length}/${items.length}개) ` +
      `[${formatProblemIds(config.problemIds ?? [])}]`,
  );

  if (missing.length > 0) {
    log.warn(`${label}: 요청한 문제를 목록에서 찾지 못함 [${formatProblemIds(missing)}]`);
  }

  return filtered;
}
