import {
  createGenerator,
  GenerateError,
  GenerateParams,
  GenerateResult,
} from "@ts-safeql/generate";
import {
  DatabaseInitializationError,
  InternalError,
  InvalidMigrationError,
  InvalidMigrationsPathError,
  QuerySourceMapEntry,
} from "@ts-safeql/shared";
import path from "path";
import { runAsWorker } from "synckit";
import { match } from "ts-pattern";
import {
  ConnectionPayload,
  getConnectionStrategyByRuleOptionConnection,
  getMigrationDatabaseMetadata,
  isWatchMigrationsDirEnabled,
  runMigrations,
} from "../rules/check-sql.utils";
import { ConnectionTarget, RuleOptionConnection } from "../rules/RuleOptions";
import { ConnectionFailedError, createConnectionManager } from "../utils/connection-manager";
import { E, J, pipe, TE } from "../utils/fp-ts";
import { initDatabase } from "../utils/pg.utils";
import { createWatchManager } from "../utils/watch-manager";

export interface BatchQueryItem {
  id: number;
  connection: RuleOptionConnection;
  target: ConnectionTarget;
  query: { text: string; sourcemaps: QuerySourceMapEntry[] };
  projectDir: string;
}

export interface BatchWorkerParams {
  queries: BatchQueryItem[];
}

export type WorkerError =
  | InvalidMigrationsPathError
  | InvalidMigrationError
  | InternalError
  | DatabaseInitializationError
  | GenerateError
  | ConnectionFailedError;

export type WorkerResult = GenerateResult;

export interface BatchResultItem {
  id: number;
  result: E.Either<WorkerError, WorkerResult | null>;
}

export interface BatchWorkerResult {
  results: BatchResultItem[];
}

const generator = createGenerator();
const connections = createConnectionManager();
const watchers = createWatchManager();

/**
 * Check if an error is a connection-related error.
 */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const connectionErrorCodes = [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ECONNRESET",
  ];

  if ("code" in error && typeof error.code === "string") {
    if (connectionErrorCodes.includes(error.code)) return true;
  }

  if (error.message?.includes("connect_timeout")) return true;

  const message = error.message?.toLowerCase() ?? "";
  if (message.includes("connection refused")) return true;
  if (message.includes("connection timeout")) return true;
  if (message.includes("could not connect")) return true;

  return false;
}

/**
 * Process a single query and return the result.
 */
async function processQuery(item: BatchQueryItem): Promise<BatchResultItem> {
  const { id, connection, target, query, projectDir } = item;

  try {
    // Set up migration watcher if needed
    if (isWatchMigrationsDirEnabled(connection)) {
      watchers.watchMigrationsDir({
        connection,
        projectDir,
        dropCacheKeyFn: generator.dropCacheKey,
        closeConnectionFn: connections.close,
      });
    }

    const result = await pipe(
      TE.Do,
      TE.chain(() => workerHandler({ connection, target, query, projectDir })),
    )();

    if (connection.keepAlive === false) {
      connections.close({ connection, projectDir });
    }

    return { id, result };
  } catch (error) {
    return {
      id,
      result: E.left(InternalError.to(error)),
    };
  }
}

function workerHandler(params: {
  connection: RuleOptionConnection;
  target: ConnectionTarget;
  query: { text: string; sourcemaps: QuerySourceMapEntry[] };
  projectDir: string;
}): TE.TaskEither<WorkerError, WorkerResult> {
  const { connection, target, query, projectDir } = params;
  const strategy = getConnectionStrategyByRuleOptionConnection({ connection, projectDir });
  const connectionTimeout = connection.connectionTimeout;

  const getConnectionPayload = (): E.Either<WorkerError, ConnectionPayload> => {
    try {
      return match(strategy)
        .with({ type: "databaseUrl" }, ({ databaseUrl }) =>
          E.right(connections.getOrCreate(databaseUrl, { connectionTimeout })),
        )
        .with({ type: "migrations" }, ({ databaseName, connectionUrl }) => {
          const { databaseUrl } = getMigrationDatabaseMetadata({
            connectionUrl,
            databaseName,
          });
          const { sql, isFirst } = connections.getOrCreate(databaseUrl, { connectionTimeout });
          connections.getOrCreate(connectionUrl, {
            connectionTimeout,
            postgresOptions: {
              onnotice: () => {},
            },
          });
          return E.right({ sql, isFirst, databaseUrl });
        })
        .exhaustive();
    } catch (error) {
      if (error instanceof ConnectionFailedError) {
        return E.left(error);
      }
      return E.left(InternalError.to(error));
    }
  };

  const connectionPayload = match(strategy)
    .with({ type: "databaseUrl" }, () => TE.fromEither(getConnectionPayload()))
    .with({ type: "migrations" }, ({ migrationsDir, connectionUrl, databaseName }) => {
      return pipe(
        TE.fromEither(getConnectionPayload()),
        TE.chainW((payload) => {
          if (!payload.isFirst) {
            return TE.right(payload);
          }

          const { connectionOptions, databaseUrl } = getMigrationDatabaseMetadata({
            connectionUrl,
            databaseName,
          });
          const { sql: migrationSql } = connections.getOrCreate(connectionUrl, {
            connectionTimeout,
            postgresOptions: {
              onnotice: () => {},
            },
          });
          const migrationsPath = path.join(projectDir, migrationsDir);

          return pipe(
            TE.Do,
            TE.chainW(() => initDatabase(migrationSql, connectionOptions.database)),
            TE.chainW(() => runMigrations({ migrationsPath, sql: payload.sql })),
            TE.map(() => payload),
            TE.mapLeft((error) => {
              if (isConnectionError(error)) {
                connections.markFailed(
                  databaseUrl,
                  error instanceof Error ? error : new Error(String(error)),
                );
                connections.markFailed(
                  connectionUrl,
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
              return error;
            }),
          );
        }),
      );
    })
    .exhaustive();

  const generateTask = (generateParams: GenerateParams, databaseUrl: string) => {
    return pipe(
      TE.tryCatch(() => generator.generate(generateParams), E.toError),
      TE.mapLeft((error) => {
        if (isConnectionError(error)) {
          console.warn(
            `[eslint-plugin-slonik] Database connection failed: ${error.message}\n` +
              `Skipping SQL validation for this connection. Fix the connection issue and restart your editor.`,
          );
          connections.markFailed(databaseUrl, error);
          return new ConnectionFailedError(databaseUrl, error);
        }
        return InternalError.to(error);
      }),
    );
  };

  return pipe(
    connectionPayload,
    TE.chainW(({ sql, databaseUrl }) => {
      return generateTask(
        {
          sql,
          query,
          cacheKey: databaseUrl,
          overrides: connection.overrides,
          fieldTransform: target.fieldTransform,
        },
        databaseUrl,
      );
    }),
    TE.chainW(TE.fromEither),
  );
}

/**
 * Batch handler that processes multiple queries in parallel.
 * Returns JSON-stringified result wrapped in Either, matching the original worker's pattern.
 */
async function handler(params: BatchWorkerParams) {
  const { queries } = params;

  if (queries.length === 0) {
    return J.stringify({ results: [] as BatchResultItem[] });
  }

  // Group queries by connection to ensure proper initialization order
  // First query for each connection will trigger migration setup
  const connectionGroups = new Map<string, BatchQueryItem[]>();

  for (const query of queries) {
    const key = JSON.stringify({
      connection: query.connection,
      projectDir: query.projectDir,
    });
    const group = connectionGroups.get(key) ?? [];
    group.push(query);
    connectionGroups.set(key, group);
  }

  // Process each connection group
  // Within a group, the first query sets up migrations, then remaining queries run in parallel
  const allResults: BatchResultItem[] = [];

  for (const group of connectionGroups.values()) {
    if (group.length === 0) continue;

    // Process first query to ensure connection/migration setup
    const firstResult = await processQuery(group[0]);
    allResults.push(firstResult);

    // Process remaining queries in parallel
    if (group.length > 1) {
      const remainingResults = await Promise.all(group.slice(1).map(processQuery));
      allResults.push(...remainingResults);
    }
  }

  // Sort results by id to maintain order
  allResults.sort((a, b) => a.id - b.id);

  return J.stringify({ results: allResults });
}

export type BatchWorkerHandler = typeof handler;

runAsWorker(handler);
