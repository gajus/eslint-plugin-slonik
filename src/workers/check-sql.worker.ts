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

export interface CheckSQLWorkerParams {
  connection: RuleOptionConnection;
  target: ConnectionTarget;
  query: { text: string; sourcemaps: QuerySourceMapEntry[] };
  projectDir: string;
}

export type CheckSQLWorkerHandler = typeof handler;

const generator = createGenerator();
const connections = createConnectionManager();
const watchers = createWatchManager();

async function handler(params: CheckSQLWorkerParams) {
  if (isWatchMigrationsDirEnabled(params.connection)) {
    watchers.watchMigrationsDir({
      connection: params.connection,
      projectDir: params.projectDir,
      dropCacheKeyFn: generator.dropCacheKey,
      closeConnectionFn: connections.close,
    });
  }

  const result = await pipe(
    TE.Do,
    TE.chain(() => workerHandler(params)),
  )();

  if (params.connection.keepAlive === false) {
    connections.close({ connection: params.connection, projectDir: params.projectDir });
  }

  return J.stringify(result);
}

runAsWorker(handler);

export type WorkerError =
  | InvalidMigrationsPathError
  | InvalidMigrationError
  | InternalError
  | DatabaseInitializationError
  | GenerateError
  | ConnectionFailedError;
export type WorkerResult = GenerateResult;

/**
 * Check if an error is a connection-related error that should prevent future connection attempts.
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
  
  // Check for error code property (Node.js network errors)
  if ("code" in error && typeof error.code === "string") {
    if (connectionErrorCodes.includes(error.code)) return true;
  }
  
  // Check for postgres connection timeout
  if (error.message?.includes("connect_timeout")) return true;
  
  // Check for common connection error messages
  const message = error.message?.toLowerCase() ?? "";
  if (message.includes("connection refused")) return true;
  if (message.includes("connection timeout")) return true;
  if (message.includes("could not connect")) return true;
  
  return false;
}

function workerHandler(params: CheckSQLWorkerParams): TE.TaskEither<WorkerError, WorkerResult> {
  const strategy = getConnectionStrategyByRuleOptionConnection(params);

  const connectionTimeout = params.connection.connectionTimeout;

  const getConnectionPayload = (): E.Either<WorkerError, ConnectionPayload> => {
    try {
      return match(strategy)
        .with({ type: "databaseUrl" }, ({ databaseUrl }) =>
          E.right(connections.getOrCreate(databaseUrl, { connectionTimeout })),
        )
        .with({ type: "migrations" }, ({ migrationsDir, databaseName, connectionUrl }) => {
          const { databaseUrl } = getMigrationDatabaseMetadata({
            connectionUrl,
            databaseName,
          });
          const { sql, isFirst } = connections.getOrCreate(databaseUrl, { connectionTimeout });
          connections.getOrCreate(connectionUrl, {
            connectionTimeout,
            postgresOptions: {
              onnotice: () => {
                /* silence notices */
              },
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
              onnotice: () => {
                /* silence notices */
              },
            },
          });
          const migrationsPath = path.join(params.projectDir, migrationsDir);

          return pipe(
            TE.Do,
            TE.chainW(() => initDatabase(migrationSql, connectionOptions.database)),
            TE.chainW(() => runMigrations({ migrationsPath, sql: payload.sql })),
            TE.map(() => payload),
            TE.mapLeft((error) => {
              // If migration/init fails due to connection error, mark it
              if (isConnectionError(error)) {
                connections.markFailed(databaseUrl, error instanceof Error ? error : new Error(String(error)));
                connections.markFailed(connectionUrl, error instanceof Error ? error : new Error(String(error)));
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
        // If generate fails due to connection error, mark it so we don't retry
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
          query: params.query,
          cacheKey: databaseUrl,
          overrides: params.connection.overrides,
          fieldTransform: params.target.fieldTransform,
        },
        databaseUrl,
      );
    }),
    TE.chainW(TE.fromEither),
  );
}
