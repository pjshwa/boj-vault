import type { BackupConfig } from '../types/index.js';

export interface CliOptions {
  user: string;
  cdpPort: number;
  output: string;
  delay: number;
  only?: string;
  problem?: string[];
  resume: boolean;
  limit?: string;
}

function parseProblemIds(values?: string[]): number[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const tokens = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (tokens.length === 0) {
    throw new Error('문제 번호를 하나 이상 지정하세요');
  }

  const invalid = tokens.filter((value) => !/^\d+$/.test(value) || Number(value) <= 0);
  if (invalid.length > 0) {
    throw new Error(`잘못된 문제 번호입니다: ${invalid.join(', ')}`);
  }

  return [...new Set(tokens.map((value) => Number(value)))];
}

export function resolveConfig(opts: CliOptions): BackupConfig {
  const problemIds = parseProblemIds(opts.problem);
  if (problemIds && opts.only === 'profile') {
    throw new Error('--problem 옵션은 profile 백업과 함께 사용할 수 없습니다');
  }

  return {
    user: opts.user,
    cdpPort: opts.cdpPort ?? 9222,
    outputDir: opts.output ?? './output',
    delay: opts.delay ?? 4,
    only: opts.only,
    problemIds,
    resume: opts.resume ?? false,
    limit: opts.limit ? Number(opts.limit) : undefined,
  };
}
