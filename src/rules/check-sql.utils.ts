import {
  DuplicateColumnsError,
  InvalidConfigError,
  InvalidMigrationError,
  InvalidMigrationsPathError,
  InvalidQueryError,
  PostgresError,
  QuerySourceMapEntry,
} from "@ts-safeql/shared";
import { TSESTree } from "@typescript-eslint/utils";
import { SourceCode } from "@typescript-eslint/utils/ts-eslint";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Sql } from "postgres";
import { match } from "ts-pattern";
import { z } from "zod";
import { E, TE, pipe } from "../utils/fp-ts";
import { mapConnectionOptionsToString, parseConnection } from "../utils/pg.utils";
import { WorkerError } from "../workers/check-sql.worker";
import { RuleContext } from "./check-sql.rule";
import { RuleOptionConnection, zConnectionMigration } from "./RuleOptions";

export const DEFAULT_CONNECTION_URL = "postgres://postgres:postgres@localhost:5432/postgres";

export function reportInvalidQueryError(params: {
  context: RuleContext;
  error: InvalidQueryError;
}) {
  const { context, error } = params;

  return context.report({
    messageId: "invalidQuery",
    node: error.node,
    data: { error: error.message },
  });
}

export function reportBaseError(params: {
  context: RuleContext;
  tag: TSESTree.TaggedTemplateExpression;
  error: WorkerError;
  hint?: string;
}) {
  const { context, tag, error } = params;

  return context.report({
    node: tag,
    messageId: "error",
    data: {
      error: [error.message, params.hint ? `Hint: ${params.hint}` : undefined]
        .filter(Boolean)
        .join("\n"),
    },
  });
}

export function reportInvalidConfig(params: {
  tag: TSESTree.TaggedTemplateExpression;
  context: RuleContext;
  error: InvalidConfigError;
}) {
  const { tag, context, error } = params;

  return context.report({
    node: tag,
    messageId: "invalidQuery",
    loc: context.sourceCode.getLocFromIndex(tag.quasi.range[0]),
    data: {
      error: error.message,
    },
  });
}

export function reportDuplicateColumns(params: {
  tag: TSESTree.TaggedTemplateExpression;
  context: RuleContext;
  error: DuplicateColumnsError;
}) {
  const { tag, context, error } = params;

  const location = getQueryErrorPosition({
    tag: tag,
    error: error,
    sourceCode: context.sourceCode,
  });

  return context.report({
    node: tag,
    messageId: "invalidQuery",
    loc: location.sourceLocation,
    data: {
      error: error.message,
    },
  });
}

export function reportPostgresError(params: {
  context: RuleContext;
  tag: TSESTree.TaggedTemplateExpression;
  error: PostgresError;
}) {
  const { context, tag, error } = params;

  const location = getQueryErrorPosition({
    tag: tag,
    error: error,
    sourceCode: context.sourceCode,
  });

  return context.report({
    node: tag,
    messageId: "invalidQuery",
    loc: location.sourceLocation,
    data: {
      error: error.message,
    },
  });
}


export function getDatabaseName(params: {
  databaseName: string | undefined;
  migrationsDir: string;
  projectDir: string;
}) {
  const { databaseName, projectDir, migrationsDir } = params;

  if (databaseName !== undefined) {
    return databaseName;
  }

  const projectDirName = projectDir.split("/").pop() ?? "";
  const projectUnderscoreName = projectDirName.replace(/[^A-z0-9]/g, "_").toLowerCase();
  const hash = crypto.createHash("sha1").update(migrationsDir).digest("hex").substring(0, 8);

  return `slonik_${projectUnderscoreName}_${hash}`;
}

export function shouldLintFile(params: RuleContext) {
  const fileName = params.getFilename();

  for (const extension of ["ts", "tsx", "mts", "mtsx"]) {
    if (fileName.endsWith(`.${extension}`)) {
      return true;
    }
  }

  return false;
}

function isMigrationConnection(
  connection: RuleOptionConnection,
): connection is RuleOptionConnection & z.infer<typeof zConnectionMigration> {
  return "migrationsDir" in connection;
}

export function isWatchMigrationsDirEnabled(
  connection: RuleOptionConnection,
): connection is RuleOptionConnection & z.infer<typeof zConnectionMigration> & { watchMode: true } {
  return isMigrationConnection(connection) && (connection.watchMode ?? true) === true;
}

export function getMigrationDatabaseMetadata(params: {
  connectionUrl: string;
  databaseName: string;
}) {
  const connectionOptions = {
    ...parseConnection(params.connectionUrl),
    database: params.databaseName,
  };
  const databaseUrl = mapConnectionOptionsToString(connectionOptions);

  return { databaseUrl, connectionOptions };
}

type ConnectionStrategy =
  | {
      type: "databaseUrl";
      databaseUrl: string;
    }
  | {
      type: "migrations";
      migrationsDir: string;
      connectionUrl: string;
      databaseName: string;
      watchMode: boolean;
    };

export function getConnectionStrategyByRuleOptionConnection(params: {
  connection: RuleOptionConnection;
  projectDir: string;
}): ConnectionStrategy {
  const { connection, projectDir } = params;

  if ("migrationsDir" in connection) {
    return {
      type: "migrations",
      connectionUrl: DEFAULT_CONNECTION_URL,
      databaseName: getDatabaseName({
        databaseName: connection.databaseName,
        migrationsDir: connection.migrationsDir,
        projectDir: projectDir,
      }),
      watchMode: isWatchMigrationsDirEnabled(connection),
      ...connection,
    };
  }

  if ("databaseUrl" in connection && connection.databaseUrl) {
    return { type: "databaseUrl", databaseUrl: connection.databaseUrl };
  }

  // This case should never be reached because invalid connections are filtered out
  // in check-sql.rule.ts before reaching this point. If we get here, it means
  // databaseUrl was undefined/null which should have been filtered.
  throw new Error(
    "[eslint-plugin-slonik] Invalid connection configuration: databaseUrl is required but was not provided.",
  );
}

export interface ConnectionPayload {
  sql: Sql<any>;
  databaseUrl: string;
  isFirst: boolean;
}

export function runMigrations(params: { migrationsPath: string; sql: Sql }) {
  const runSingleMigrationFileWithSql = (filePath: string) => {
    return runSingleMigrationFile(params.sql, filePath);
  };

  return pipe(
    TE.Do,
    TE.chain(() => getMigrationFiles(params.migrationsPath)),
    TE.chainW((files) => TE.sequenceSeqArray(files.map(runSingleMigrationFileWithSql))),
  );
}

function findDeepSqlFiles(migrationsPath: string) {
  const sqlFilePaths: string[] = [];

  function findDeepSqlFilesRecursively(dir: string) {
    const files = fs.readdirSync(dir);

    files.forEach((file) => {
      const filePath = path.join(dir, file);
      const isDirectory = fs.statSync(filePath).isDirectory();

      if (isDirectory) {
        findDeepSqlFilesRecursively(filePath);
      } else if (filePath.endsWith(".sql")) {
        sqlFilePaths.push(filePath);
      }
    });
  }

  findDeepSqlFilesRecursively(migrationsPath);

  return sqlFilePaths;
}

function getMigrationFiles(migrationsPath: string) {
  return pipe(
    E.tryCatch(() => findDeepSqlFiles(migrationsPath), E.toError),
    TE.fromEither,
    TE.mapLeft(InvalidMigrationsPathError.fromErrorC(migrationsPath)),
  );
}

function runSingleMigrationFile(sql: Sql, filePath: string) {
  return pipe(
    TE.tryCatch(() => fs.promises.readFile(filePath).then((x) => x.toString()), E.toError),
    TE.chain((content) => TE.tryCatch(() => sql.unsafe(content), E.toError)),
    TE.mapLeft(InvalidMigrationError.fromErrorC(filePath)),
  );
}

interface GetWordRangeInPositionParams {
  error: {
    position: number;
    sourcemaps: QuerySourceMapEntry[];
  };
  tag: TSESTree.TaggedTemplateExpression;
  sourceCode: Readonly<SourceCode>;
}

function getQueryErrorPosition(params: GetWordRangeInPositionParams) {
  const range: [number, number] = [params.error.position, params.error.position + 1];

  for (const entry of params.error.sourcemaps) {
    const generatedLength = Math.max(0, entry.generated.end - entry.generated.start);
    const originalLength = Math.max(0, entry.original.end - entry.original.start);
    const adjustment = originalLength - generatedLength;

    if (range[0] >= entry.generated.start && range[1] <= entry.generated.end) {
      range[0] = entry.original.start + entry.offset;
      range[1] = entry.original.start + entry.offset + 1;
      continue;
    }

    if (params.error.position >= entry.generated.start) {
      range[0] += adjustment;
    }

    if (params.error.position >= entry.generated.end) {
      range[1] += adjustment;
    }
  }

  const start = params.sourceCode.getLocFromIndex(params.tag.quasi.range[0] + range[0]);
  const startLineText = params.sourceCode.getLines()[start.line - 1];
  const remainingLineText = startLineText.substring(start.column);
  const remainingWordLength = (remainingLineText.match(/^[\w.{}'$"]+/)?.at(0)?.length ?? 1) - 1;

  const end = params.sourceCode.getLocFromIndex(params.tag.quasi.range[0] + range[1]);

  const sourceLocation: TSESTree.SourceLocation = {
    start: start,
    end: {
      line: end.line,
      column: end.column + remainingWordLength,
    },
  };

  return {
    range,
    sourceLocation: sourceLocation,
    remainingLineText: remainingLineText,
    remainingWordLength: remainingWordLength,
  };
}
