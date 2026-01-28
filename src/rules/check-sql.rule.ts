import { InvalidConfigError, doesMatchPattern } from "@ts-safeql/shared";
import {
  ESLintUtils,
  ParserServices,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import { JSONSchema4 } from "@typescript-eslint/utils/json-schema";
import { match } from "ts-pattern";
import { ESTreeUtils } from "../utils";
import { E, J, flow } from "../utils/fp-ts";
import { isInEditorEnv } from "../utils/is-in-editor";
import { memoize } from "../utils/memoize";
import { locateNearestPackageJsonDir } from "../utils/node.utils";
import { mapTemplateLiteralToQueryText } from "../utils/ts-pg.utils";
import { workers } from "../workers";
import type { BatchQueryItem, BatchResultItem } from "../workers/check-sql-batch.worker";
import { WorkerError } from "../workers/check-sql.worker";
import {
  ConnectionTarget,
  RuleOptionConnection,
  RuleOptions,
  TagTarget,
  WrapperTarget,
} from "./RuleOptions";
import { getConfigFromFileWithContext } from "./check-sql.config";
import {
  reportBaseError,
  reportDuplicateColumns,
  reportInvalidConfig,
  reportInvalidQueryError,
  reportPostgresError,
  shouldLintFile,
} from "./check-sql.utils";
import z from "zod";

const messages = {
  typeInferenceFailed: "Type inference failed {{error}}",
  error: "{{error}}",
  invalidQuery: "Invalid Query: {{error}}",
};
export type RuleMessage = keyof typeof messages;

export type RuleContext = Readonly<TSESLint.RuleContext<RuleMessage, RuleOptions>>;

let missingDatabaseUrlWarningLogged = false;

/**
 * Check if a connection is valid and should be processed.
 * Returns false if the connection is missing required database configuration.
 */
function isConnectionValid(connection: RuleOptionConnection): boolean {
  // Migration-based connections are always valid (they use a default connection URL)
  if ("migrationsDir" in connection) {
    return true;
  }

  // URL-based connections require a valid databaseUrl
  if ("databaseUrl" in connection && connection.databaseUrl) {
    return true;
  }

  return false;
}

/**
 * Pending query to be validated in batch.
 */
interface PendingQuery {
  id: number;
  tag: TSESTree.TaggedTemplateExpression;
  connection: RuleOptionConnection;
  target: ConnectionTarget;
  projectDir: string;
  baseNode: TSESTree.BaseNode;
  typeParameter: TSESTree.TSTypeParameterInstantiation | undefined;
  query: { text: string; sourcemaps: import("@ts-safeql/shared").QuerySourceMapEntry[] };
}

/**
 * Query that was skipped (null query result from mapTemplateLiteralToQueryText).
 */
interface SkippedQuery {
  id: number;
  skipped: true;
}

/**
 * Query that had an error during preparation (before worker).
 */
interface ErrorQuery {
  id: number;
  tag: TSESTree.TaggedTemplateExpression;
  connection: RuleOptionConnection;
  error: WorkerError | InvalidConfigError;
}

type PreparedQuery = PendingQuery | SkippedQuery | ErrorQuery;

function isPendingQuery(q: PreparedQuery): q is PendingQuery {
  return "query" in q && !("skipped" in q) && !("error" in q);
}

function isErrorQuery(q: PreparedQuery): q is ErrorQuery {
  return "error" in q;
}

function isTagMemberValid(
  expr: TSESTree.TaggedTemplateExpression,
): expr is TSESTree.TaggedTemplateExpression &
  (
    | {
        tag: TSESTree.Identifier;
      }
    | {
        tag: TSESTree.MemberExpression & {
          property: TSESTree.Identifier;
        };
      }
  ) {
  // For example sql``
  if (ESTreeUtils.isIdentifier(expr.tag)) {
    return true;
  }

  // For example Provider.sql``
  if (ESTreeUtils.isMemberExpression(expr.tag) && ESTreeUtils.isIdentifier(expr.tag.property)) {
    return true;
  }

  return false;
}

function hasParserServicesWithTypeInformation(
  parser: Partial<ParserServices> | undefined,
): parser is ParserServicesWithTypeInformation {
  return parser !== undefined && parser.program !== null;
}

function getValidParentUntilDepth(node: TSESTree.Node, depth: number) {
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    return node;
  }

  if (depth > 0 && node.parent) {
    return getValidParentUntilDepth(node.parent, depth - 1);
  }

  return null;
}

/**
 * Prepare a query for batch processing.
 * Returns a PendingQuery with the extracted SQL, or an ErrorQuery/SkippedQuery.
 */
function prepareQuery(params: {
  id: number;
  context: RuleContext;
  tag: TSESTree.TaggedTemplateExpression;
  connection: RuleOptionConnection;
  target: ConnectionTarget;
  projectDir: string;
  baseNode: TSESTree.BaseNode;
  typeParameter: TSESTree.TSTypeParameterInstantiation | undefined;
}): PreparedQuery {
  const { id, context, tag, connection, target, projectDir, baseNode, typeParameter } = params;

  // Get parser services
  if (!hasParserServicesWithTypeInformation(context.sourceCode.parserServices)) {
    return {
      id,
      tag,
      connection,
      error: new InvalidConfigError("Parser services are not available"),
    };
  }

  const parser = context.sourceCode.parserServices;

  // Type checker may not be available (e.g., when using OXLint JS plugins)
  // In that case, we pass null and use untyped placeholders
  const checker = parser.program?.getTypeChecker() ?? null;

  // Extract query text
  let queryResult;
  try {
    queryResult = mapTemplateLiteralToQueryText(
      tag.quasi,
      parser,
      checker,
      connection,
      context.sourceCode,
    );
  } catch (error) {
    console.error("[slonik/check-sql] DEBUG: Error in mapTemplateLiteralToQueryText:", error);
    console.error("[slonik/check-sql] DEBUG: Query template:", context.sourceCode.getText(tag));
    throw error;
  }

  if (E.isLeft(queryResult)) {
    return {
      id,
      tag,
      connection,
      error: queryResult.left as WorkerError,
    };
  }

  // If query is null, skip validation (e.g., dynamic sql.identifier)
  if (queryResult.right === null) {
    return { id, skipped: true };
  }

  return {
    id,
    tag,
    connection,
    target,
    projectDir,
    baseNode,
    typeParameter,
    query: queryResult.right,
  };
}

/**
 * Report an error for a query result.
 */
function reportQueryError(params: {
  context: RuleContext;
  tag: TSESTree.TaggedTemplateExpression;
  connection: RuleOptionConnection;
  error: WorkerError | InvalidConfigError | { _tag: string };
}): void {
  const { context, tag, error } = params;

  // Use type assertion for error matching since GenerateError from @ts-safeql/generate
  // contains additional error types like PostgresError, DuplicateColumnsError, InvalidQueryError
  const errorWithTag = error as { _tag: string; message?: string; node?: unknown };

  switch (errorWithTag._tag) {
    case "InvalidConfigError":
      reportInvalidConfig({ context, error: error as InvalidConfigError, tag });
      break;
    case "DuplicateColumnsError":
      reportDuplicateColumns({ context, error: error as Parameters<typeof reportDuplicateColumns>[0]["error"], tag });
      break;
    case "PostgresError":
      reportPostgresError({ context, error: error as Parameters<typeof reportPostgresError>[0]["error"], tag });
      break;
    case "InvalidQueryError":
      reportInvalidQueryError({ context, error: error as Parameters<typeof reportInvalidQueryError>[0]["error"] });
      break;
    case "InvalidMigrationError":
    case "InvalidMigrationsPathError":
    case "DatabaseInitializationError":
      reportBaseError({ context, error: error as WorkerError, tag });
      break;
    case "InternalError": {
      const isConfigError = errorWithTag.message?.includes("Invalid override column key") ?? false;
      if (isConfigError) {
        reportBaseError({ context, error: error as WorkerError, tag });
      } else {
        console.warn(
          `[eslint-plugin-slonik] Skipping query due to unsupported SQL syntax: ${errorWithTag.message}\n` +
            `If you believe this query should be supported, please open an issue at https://github.com/gajus/eslint-plugin-slonik/issues`,
        );
      }
      break;
    }
    case "ConnectionFailedError":
      // Connection has already failed - skip silently
      break;
    default:
      // Unknown error type
      reportBaseError({ context, error: error as WorkerError, tag });
  }
}

// Batch processing helper using the new batch worker
const generateBatchSyncE = flow(
  workers.generateBatchSync,
  E.chain(J.parse),
  E.map((parsed) => parsed as unknown as { results: BatchResultItem[] }),
);

let fatalError: WorkerError | undefined;

const createRule = ESLintUtils.RuleCreator(() => `https://github.com/gajus/eslint-plugin-slonik`)<
  RuleOptions,
  RuleMessage
>;

export default createRule({
  name: "check-sql",
  meta: {
    fixable: "code",
    docs: {
      description: "Validate SQL queries against the database schema",
    },
    messages: messages,
    type: "problem",
    schema: z.toJSONSchema(RuleOptions, { target: "draft-4" }) as JSONSchema4,
  },
  defaultOptions: [],
  create(context) {
    if (!shouldLintFile(context)) {
      return {};
    }

    const projectDir = memoize({
      key: context.filename,
      value: () => locateNearestPackageJsonDir(context.filename),
    });

    const config = memoize({
      key: JSON.stringify({ key: "config", options: context.options, projectDir }),
      value: () => getConfigFromFileWithContext({ context, projectDir }),
    });

    // Collect all queries during the lint pass
    const pendingQueries: PreparedQuery[] = [];
    let queryIdCounter = 0;

    /**
     * Collect a query for batch processing.
     */
    function collectQuery(params: {
      tag: TSESTree.TaggedTemplateExpression;
      connection: RuleOptionConnection;
      target: ConnectionTarget;
      baseNode: TSESTree.BaseNode;
      typeParameter: TSESTree.TSTypeParameterInstantiation | undefined;
    }) {
      // Check for fatal error from previous files
      if (fatalError !== undefined) {
        const hint = isInEditorEnv()
          ? "If you think this is a bug, please open an issue. If not, please try to fix the error and restart ESLint."
          : "If you think this is a bug, please open an issue.";
        reportBaseError({ context, error: fatalError, tag: params.tag, hint });
        return;
      }

      const prepared = prepareQuery({
        id: queryIdCounter++,
        context,
        tag: params.tag,
        connection: params.connection,
        target: params.target,
        projectDir,
        baseNode: params.baseNode,
        typeParameter: params.typeParameter,
      });

      pendingQueries.push(prepared);
    }

    /**
     * Check a tagged template expression and collect for batch processing.
     */
    function check(tag: TSESTree.TaggedTemplateExpression) {
      const connections = Array.isArray(config.connections)
        ? config.connections
        : [config.connections];

      for (const connection of connections) {
        if (!isConnectionValid(connection)) {
          if (!missingDatabaseUrlWarningLogged) {
            console.warn(
              `[eslint-plugin-slonik] databaseUrl is not configured. SQL validation is disabled. ` +
                `Set the DATABASE_URL environment variable or configure databaseUrl in your ESLint config.`,
            );
            missingDatabaseUrlWarningLogged = true;
          }
          continue;
        }

        for (const target of connection.targets) {
          checkConnection({ tag, connection, target });
        }
      }
    }

    /**
     * Check connection by target type.
     */
    function checkConnection(params: {
      connection: RuleOptionConnection;
      target: ConnectionTarget;
      tag: TSESTree.TaggedTemplateExpression;
    }) {
      if ("tag" in params.target) {
        return checkConnectionByTagExpression({ ...params, target: params.target });
      }

      if ("wrapper" in params.target) {
        return checkConnectionByWrapperExpression({ ...params, target: params.target });
      }

      return match(params.target).exhaustive();
    }

    /**
     * Check by tag expression pattern.
     */
    function checkConnectionByTagExpression(params: {
      connection: RuleOptionConnection;
      target: TagTarget;
      tag: TSESTree.TaggedTemplateExpression;
    }) {
      const { tag, connection, target } = params;
      const tagAsText = context.sourceCode.getText(tag.tag).replace(/^this\./, "");

      if (doesMatchPattern({ pattern: target.tag, text: tagAsText })) {
        collectQuery({
          tag,
          connection,
          target,
          baseNode: tag.tag,
          typeParameter: tag.typeArguments,
        });
      }
    }

    /**
     * Check by wrapper expression pattern.
     */
    function checkConnectionByWrapperExpression(params: {
      connection: RuleOptionConnection;
      target: WrapperTarget;
      tag: TSESTree.TaggedTemplateExpression;
    }) {
      const { tag, connection, target } = params;

      if (!isTagMemberValid(tag)) {
        return;
      }

      const wrapperNode = getValidParentUntilDepth(tag.parent, target.maxDepth ?? 0);

      if (wrapperNode === null) {
        return;
      }

      const calleeAsText = context.sourceCode.getText(wrapperNode.callee).replace(/^this\./, "");

      if (doesMatchPattern({ pattern: target.wrapper, text: calleeAsText })) {
        collectQuery({
          tag,
          connection,
          target,
          baseNode: wrapperNode.callee,
          typeParameter: wrapperNode.typeArguments,
        });
      }
    }

    /**
     * Process all collected queries in batch at the end of the file.
     */
    function processBatch() {
      if (pendingQueries.length === 0) {
        return;
      }

      // Separate queries by type
      const queriesToValidate: PendingQuery[] = [];
      const errorQueries: ErrorQuery[] = [];

      for (const query of pendingQueries) {
        if (isPendingQuery(query)) {
          queriesToValidate.push(query);
        } else if (isErrorQuery(query)) {
          errorQueries.push(query);
        }
        // Skip SkippedQuery - nothing to report
      }

      // Report errors for queries that failed during preparation
      for (const errorQuery of errorQueries) {
        reportQueryError({
          context,
          tag: errorQuery.tag,
          connection: errorQuery.connection,
          error: errorQuery.error,
        });
      }

      // If no queries to validate, we're done
      if (queriesToValidate.length === 0) {
        return;
      }

      // Build batch request
      const batchQueries: BatchQueryItem[] = queriesToValidate.map((q) => ({
        id: q.id,
        connection: q.connection,
        target: q.target,
        query: q.query,
        projectDir: q.projectDir,
      }));

      // Send batch to worker for parallel processing
      const batchResult = generateBatchSyncE({ queries: batchQueries });

      if (E.isLeft(batchResult)) {
        // Batch processing failed entirely - report error for first query
        const firstQuery = queriesToValidate[0];
        reportBaseError({
          context,
          error: {
            _tag: "InternalError",
            message: `Batch processing failed: ${String(batchResult.left)}`,
          } as WorkerError,
          tag: firstQuery.tag,
        });
        return;
      }

      // Map results back to queries and report errors
      const resultsById = new Map<number, BatchResultItem>();
      for (const result of batchResult.right.results) {
        resultsById.set(result.id, result);
      }

      for (const query of queriesToValidate) {
        const result = resultsById.get(query.id);

        if (!result) {
          // No result for this query - shouldn't happen
          continue;
        }

        if (E.isLeft(result.result)) {
          // Check for fatal errors
          const error = result.result.left;
          if (
            error._tag === "InvalidMigrationError" ||
            error._tag === "InvalidMigrationsPathError" ||
            error._tag === "DatabaseInitializationError"
          ) {
            if (query.connection.keepAlive === true) {
              fatalError = error;
            }
          }

          reportQueryError({
            context,
            tag: query.tag,
            connection: query.connection,
            error: error,
          });
        }
        // Success - nothing to report (type checking disabled)
      }
    }

    return {
      TaggedTemplateExpression(tag) {
        check(tag);
      },
      "Program:exit"() {
        processBatch();
      },
    };
  },
});
