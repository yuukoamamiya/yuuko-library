import { readFile } from 'node:fs/promises';
import type { Verification } from './transfer.ts';

export type UploadReport = {
  schemaVersion: 1;
  command: 'upload' | 'verify';
  planId: string;
  reviewHash: string;
  bucket: string;
  origin: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'verified' | 'failed';
  expected: number;
  verified: Verification[];
  failures: { id: string; message: string }[];
};
export type UploadReportContract = {
  planId: string;
  reviewHash: string;
  bookIds: string[];
};

export function validateUploadReport(value: unknown, expected: UploadReportContract): UploadReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('上传报告格式无效');
  }
  const report = value as Partial<UploadReport>;
  if (report.schemaVersion !== 1 || !['upload', 'verify'].includes(report.command ?? '')
    || report.status !== 'verified' || report.planId !== expected.planId || report.reviewHash !== expected.reviewHash
    || !Array.isArray(report.verified) || !Array.isArray(report.failures) || report.failures.length !== 0
    || report.expected !== expected.bookIds.length || report.verified.length !== expected.bookIds.length) {
    throw new Error('上传报告未全部校验通过，或与审核计划不匹配');
  }

  const expectedIds = new Set(expected.bookIds);
  const actualIds = new Set<string>();
  for (const record of report.verified) {
    if (!record || typeof record.id !== 'string' || actualIds.has(record.id)) {
      throw new Error('上传报告书籍 ID 集合无效');
    }
    actualIds.add(record.id);
  }
  if (actualIds.size !== expectedIds.size || [...expectedIds].some(id => !actualIds.has(id))) {
    throw new Error('上传报告书籍 ID 集合与审核计划不匹配');
  }
  return report as UploadReport;
}

export async function readUploadReport(file: string, expected: UploadReportContract): Promise<UploadReport> {
  return validateUploadReport(JSON.parse(await readFile(file, 'utf8')), expected);
}
