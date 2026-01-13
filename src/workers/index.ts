import path from "path";
import { AnyFn, createSyncFn } from "synckit";
import { CheckSQLWorkerHandler } from "./check-sql.worker";
import { fileURLToPath } from "node:url";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
// In development, this file runs from src/workers/ and workers are in dist/workers/
// In production (bundled), this runs from dist/ and workers are in dist/workers/
const isSourceDir = currentDir.includes(path.sep + "src" + path.sep);

function getWorkerPath(name: string): string {
  if (isSourceDir) {
    // Development: from src/workers -> dist/workers
    return path.join(currentDir, "../../dist/workers", `${name}.worker.mjs`);
  }
  // Production: from dist -> dist/workers
  return path.join(currentDir, "workers", `${name}.worker.mjs`);
}

function defineWorker<T extends AnyFn<R>, R = unknown>(params: { name: string; timeout: number }) {
  return createSyncFn<T>(getWorkerPath(params.name), {
    tsRunner: "tsx",
    timeout: params.timeout,
  });
}

export const workers = {
  generateSync: defineWorker<CheckSQLWorkerHandler>({ name: "check-sql", timeout: 1000 * 60 * 1 }),
};
