import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';
import type { BackupConfig, Submission } from '../types/index.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { ProgressTracker } from '../core/progress.js';
import {
  parseSubmissionTable,
  parseSourceCode,
  parseSourceProblemId,
  hasNextPage,
} from '../parsers/submission.js';
import { writeJson, writeSourceCode } from '../writers/json-writer.js';
import { ensureDir, createLogger, withPage, langToExt } from '../core/utils.js';
import type { Logger } from '../core/utils.js';
import {
  formatProblemIds,
  hasProblemFilter,
  matchesProblemFilter,
} from '../core/problem-filter.js';

// ------------------------------------------------------------------
// Submission list cache — Phase 1 resume support
// ------------------------------------------------------------------

export interface SubmissionListCache {
  lastSubmissionId?: number;
  pageNum: number;
  complete: boolean;
  submissions: Omit<Submission, 'sourceCode'>[];
}

const CACHE_FILENAME = 'submissions-cache.json';

export async function loadCache(outputDir: string): Promise<SubmissionListCache | null> {
  try {
    const raw = await readFile(join(outputDir, CACHE_FILENAME), 'utf-8');
    return JSON.parse(raw) as SubmissionListCache;
  } catch {
    return null;
  }
}

export async function saveCache(
  outputDir: string,
  cache: SubmissionListCache,
): Promise<void> {
  await writeJson(join(outputDir, CACHE_FILENAME), cache, { atomic: true });
}

/**
 * Migration: rebuild cache from existing submission JSON files on disk.
 * Supports users who started backup before cache feature was added.
 */
export async function migrateFromDisk(
  outputDir: string,
  log: Logger,
): Promise<SubmissionListCache | null> {
  const submissionsDir = join(outputDir, 'submissions');

  let entries: string[];
  try {
    entries = await readdir(submissionsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }

  const jsonFiles = entries.filter(
    (f) => f.endsWith('.json') && !f.endsWith('index.json'),
  );

  if (jsonFiles.length === 0) {
    return null;
  }

  const submissions: Omit<Submission, 'sourceCode'>[] = [];

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(submissionsDir, file), 'utf-8');
      const meta = JSON.parse(raw);
      if (meta.submissionId) {
        submissions.push(meta);
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (submissions.length === 0) {
    return null;
  }

  // Sort newest first (matches BOJ pagination order: newest → oldest)
  submissions.sort((a, b) => b.submissionId - a.submissionId);

  // min(submissionId) = approximately where Phase 1 pagination reached
  const lastSubmissionId = submissions[submissions.length - 1].submissionId;

  log.info(`기존 파일에서 ${submissions.length}건의 제출 메타데이터를 복원했습니다`);

  return {
    lastSubmissionId,
    pageNum: Math.ceil(submissions.length / 20),
    complete: false,
    submissions,
  };
}

export async function scrapeSubmissions(
  context: BrowserContext,
  config: BackupConfig,
  rateLimiter: RateLimiter,
  progress: ProgressTracker,
): Promise<Submission[]> {
  const log = createLogger('submissions');
  const problemFilterActive = hasProblemFilter(config);

  // ------------------------------------------------------------------
  // Phase 1: Collect submission list by paginating through /status
  // ------------------------------------------------------------------
  log.info(`제출 목록 수집 시작: ${config.user}`);

  const allSubmissions: Submission[] = [];
  let pageNum = 0;
  let lastSubmissionId: number | undefined;
  let phase1Complete = false;

  const persistCache = async (complete: boolean) => {
    await saveCache(config.outputDir, {
      lastSubmissionId,
      pageNum,
      complete,
      submissions: allSubmissions.map(({ sourceCode: _, ...rest }) => rest),
    });
  };

  // Resume: load cache or migrate from existing files on disk
  if (config.resume) {
    let cache = await loadCache(config.outputDir);

    if (!cache) {
      log.info('캐시 파일 없음 — 기존 파일에서 복원 시도');
      cache = await migrateFromDisk(config.outputDir, log);
      if (cache) {
        await saveCache(config.outputDir, cache);
        log.info('기존 파일에서 캐시를 생성했습니다');
      }
    }

    if (cache) {
      allSubmissions.push(...(cache.submissions as Submission[]));
      pageNum = cache.pageNum;
      lastSubmissionId = cache.lastSubmissionId;
      phase1Complete = cache.complete;

      log.info(
        `캐시에서 ${allSubmissions.length}건 복원 (페이지 ${pageNum}, ` +
          `${phase1Complete ? '목록 수집 완료' : '이어서 수집'})`,
      );
    }
  }

  // Continue or start Phase 1 pagination
  if (!phase1Complete) {
    let reachedEnd = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      pageNum++;

      // Build URL: first page has no &top= param, subsequent pages use &top=lastId-1
      let url = `https://www.acmicpc.net/status?user_id=${config.user}`;
      if (lastSubmissionId !== undefined) {
        url += `&top=${lastSubmissionId - 1}`;
      }

      const { subs, morePages } = await withPage(context, url, async (page) => {
        const subs = await parseSubmissionTable(page);
        const morePages = subs.length > 0 ? await hasNextPage(page) : false;
        return { subs, morePages };
      });

      const submissions = subs;

      // Stop if the page returned no submissions
      if (submissions.length === 0) {
        log.info(`페이지 ${pageNum}: 제출 없음 — 수집 종료`);
        reachedEnd = true;
        break;
      }

      allSubmissions.push(...submissions);
      log.info(`페이지 ${pageNum} 수집 완료 (${allSubmissions.length}건)`);

      // Update lastSubmissionId for next page pagination
      lastSubmissionId = submissions[submissions.length - 1].submissionId;

      // Save cache incrementally after each page
      await persistCache(false);

      // Stop if limit reached
      if (!problemFilterActive && config.limit && allSubmissions.length >= config.limit) {
        allSubmissions.length = config.limit;
        log.info(`제한 도달 (${config.limit}건) — 수집 종료`);
        break;
      }

      // Check if there are more pages
      if (!morePages) {
        log.info('마지막 페이지 도달 — 수집 종료');
        reachedEnd = true;
        break;
      }

      await rateLimiter.waitPagination();
    }

    // Only mark complete when all pages have been fetched
    phase1Complete = reachedEnd;
    if (reachedEnd) {
      await persistCache(true);
    }
  }

  log.info(`총 ${allSubmissions.length}건의 제출 수집 완료`);

  // ------------------------------------------------------------------
  // Phase 2: Collect source code for each submission
  // ------------------------------------------------------------------
  const targets = problemFilterActive
    ? allSubmissions.filter(
        (submission) =>
          submission.problemId === 0 || matchesProblemFilter(config, submission.problemId),
      )
    : allSubmissions;

  if (problemFilterActive) {
    const unresolved = targets.filter((submission) => submission.problemId === 0).length;
    log.info(
      `문제 번호 필터 적용: ${targets.length}건 대상 ` +
        `[${formatProblemIds(config.problemIds ?? [])}]`,
    );
    if (unresolved > 0) {
      log.info(`대회 제출 ${unresolved}건은 소스 페이지에서 실제 문제 번호를 다시 확인합니다`);
    }
  }

  const collected: Submission[] = [];
  const total = targets.length;
  let current = 0;

  for (const submission of targets) {
    if (problemFilterActive && config.limit && collected.length >= config.limit) {
      log.info(`제한 도달 (${config.limit}건) — 수집 종료`);
      break;
    }

    current++;
    const { submissionId } = submission;

    // Skip already completed submissions (resume support)
    if (progress.isCompleted('submissions', submissionId)) {
      if (!problemFilterActive || matchesProblemFilter(config, submission.problemId)) {
        collected.push(submission);
      }
      continue;
    }

    // Log progress periodically (every submission, since each takes a while)
    log.info(`소스코드 수집 중 [${current}/${total}]`);

    const sourceUrl = `https://www.acmicpc.net/source/${submissionId}`;

    const { sourceCode, resolvedProblemId } = await withPage(context, sourceUrl, async (page) => {
      // Check if redirected to login page
      if (page.url().includes('/login')) {
        log.error(
          `로그인이 필요합니다. Chrome에서 BOJ에 로그인되어 있는지 확인하세요.`,
        );
        return { sourceCode: '', resolvedProblemId: 0 };
      }

      const [code, pid] = await Promise.all([
        parseSourceCode(page),
        parseSourceProblemId(page),
      ]);
      return { sourceCode: code, resolvedProblemId: pid };
    });

    if (sourceCode) {
      submission.sourceCode = sourceCode;
    }

    // Patch problemId for contest submissions (Phase 1 sets problemId=0)
    if (resolvedProblemId > 0 && submission.problemId === 0) {
      log.info(
        `제출 ${submissionId}: 대회 문제 ID 확인 → ${resolvedProblemId}`,
      );
      submission.problemId = resolvedProblemId;
      await persistCache(phase1Complete);
    }

    if (problemFilterActive && !matchesProblemFilter(config, submission.problemId)) {
      if (submission.problemId === 0) {
        log.warn(`제출 ${submissionId}: 실제 문제 번호를 확인하지 못해 필터 대상에서 제외`);
      } else {
        log.info(`제출 ${submissionId}: 문제 번호 필터와 일치하지 않아 저장 건너뜀 (#${submission.problemId})`);
      }
      await rateLimiter.wait();
      continue;
    }

    // Save submission files
    // Resolved → submissions/{problemId}/, unresolved contest → submissions/contest-{contestId}/
    const problemDir = submission.problemId > 0
      ? String(submission.problemId)
      : `contest-${submission.contestId ?? 'unknown'}`;

    if (submission.problemId === 0) {
      log.warn(
        `제출 ${submissionId}: 문제 ID를 확인할 수 없습니다 — ${problemDir}/ 에 저장`,
      );
    }

    const submissionDir = join(
      config.outputDir,
      'submissions',
      problemDir,
    );
    await ensureDir(submissionDir);

    // Save source code as a separate file with proper extension
    if (submission.sourceCode) {
      const ext = langToExt(submission.language);
      await writeSourceCode(
        join(submissionDir, `${submissionId}${ext}`),
        submission.sourceCode,
      );
    }

    // Save metadata JSON (without inline sourceCode)
    const { sourceCode: _, ...meta } = submission;
    await writeJson(join(submissionDir, `${submissionId}.json`), meta);

    // Mark completed and persist progress
    progress.markCompleted('submissions', submissionId);
    await progress.save();
    collected.push(submission);

    // Rate limit between source-code fetches
    await rateLimiter.wait();
  }

  const result = problemFilterActive ? collected : allSubmissions;
  log.info(`소스코드 수집 완료 (${result.length}건)`);
  return result;
}
