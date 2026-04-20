import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/cli/config.js';

describe('resolveConfig', () => {
  it('문제 번호를 반복/쉼표 입력으로 받아 dedupe 한다', () => {
    const config = resolveConfig({
      user: 'amsminn',
      cdpPort: 9222,
      output: './output',
      delay: 4,
      only: 'reviewed',
      problem: ['1000', '2000,3000', '1000'],
      resume: false,
      limit: undefined,
    });

    expect(config.problemIds).toEqual([1000, 2000, 3000]);
  });

  it('잘못된 문제 번호는 거부한다', () => {
    expect(() =>
      resolveConfig({
        user: 'amsminn',
        cdpPort: 9222,
        output: './output',
        delay: 4,
        problem: ['1000', 'abc'],
        resume: false,
        limit: undefined,
      }),
    ).toThrow('잘못된 문제 번호입니다');
  });

  it('비어 있는 문제 번호 목록은 거부한다', () => {
    expect(() =>
      resolveConfig({
        user: 'amsminn',
        cdpPort: 9222,
        output: './output',
        delay: 4,
        problem: [',,,'],
        resume: false,
        limit: undefined,
      }),
    ).toThrow('문제 번호를 하나 이상 지정하세요');
  });

  it('profile 백업에는 문제 번호 필터를 붙일 수 없다', () => {
    expect(() =>
      resolveConfig({
        user: 'amsminn',
        cdpPort: 9222,
        output: './output',
        delay: 4,
        only: 'profile',
        problem: ['1000'],
        resume: false,
        limit: undefined,
      }),
    ).toThrow('--problem 옵션은 profile 백업과 함께 사용할 수 없습니다');
  });
});
