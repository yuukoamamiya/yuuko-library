import type { Verification } from './transfer.ts';
export type UploadReport = { schemaVersion: number; command: string; planId: string; reviewHash: string; bucket: string; origin: string; startedAt: string; finishedAt: string | null; status: string; expected: number; verified: Verification[]; failures: { id: string; message: string }[] };
