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
import { E, J, flow, pipe } from "../utils/fp-ts";
import { isInEditorEnv } from "../utils/is-in-editor";
import { memoize } from "../utils/memoize";
import { locateNearestPackageJsonDir } from "../utils/node.utils";
import { mapTemplateLiteralToQueryText } from "../utils/ts-pg.utils";
import { workers } from "../workers";
import { WorkerError, WorkerResult } from "../workers/check-sql.worker";
import {
  Config,
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

function check(params: {
  context: RuleContext;
  config: Config;
  tag: TSESTree.TaggedTemplateExpression;
  projectDir: string;
}) {
  const connections = Array.isArray(params.config.connections)
    ? params.config.connections
    : [params.config.connections];

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
      checkConnection({ ...params, connection, target });
    }
  }
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

function checkConnection(params: {
  context: RuleContext;
  connection: RuleOptionConnection;
  target: ConnectionTarget;
  tag: TSESTree.TaggedTemplateExpression;
  projectDir: string;
}) {
  if ("tag" in params.target) {
    return checkConnectionByTagExpression({ ...params, target: params.target });
  }

  if ("wrapper" in params.target) {
    return checkConnectionByWrapperExpression({ ...params, target: params.target });
  }

  return match(params.target).exhaustive();
}

const generateSyncE = flow(
  workers.generateSync,
  E.chain(J.parse),
  E.chainW((parsed) => parsed as unknown as E.Either<WorkerError, WorkerResult>),
  E.mapLeft((error) => error as unknown as WorkerError),
);

let fatalError: WorkerError | undefined;

function reportCheck(params: {
  context: RuleContext;
  tag: TSESTree.TaggedTemplateExpression;
  connection: RuleOptionConnection;
  target: ConnectionTarget;
  projectDir: string;
  typeParameter: TSESTree.TSTypeParameterInstantiation | undefined;
  baseNode: TSESTree.BaseNode;
}) {
  const { context, tag, connection, target, projectDir } = params;

  if (fatalError !== undefined) {
    const hint = isInEditorEnv()
      ? "If you think this is a bug, please open an issue. If not, please try to fix the error and restart ESLint."
      : "If you think this is a bug, please open an issue.";

    return reportBaseError({ context, error: fatalError, tag, hint });
  }

  return pipe(
    E.Do,
    E.bind("parser", () => {
      return hasParserServicesWithTypeInformation(context.sourceCode.parserServices)
        ? E.right(context.sourceCode.parserServices)
        : E.left(new InvalidConfigError("Parser services are not available"));
    }),
    E.bind("checker", ({ parser }) => {
      return !parser.program
        ? E.left(new InvalidConfigError("Type checker is not available"))
        : E.right(parser.program.getTypeChecker());
    }),
    E.bindW("query", ({ parser, checker }) => {
      try {
        return mapTemplateLiteralToQueryText(
          tag.quasi,
          parser,
          checker,
          params.connection,
          params.context.sourceCode,
        );
      } catch (error) {
        console.error('[slonik/check-sql] DEBUG: Error in mapTemplateLiteralToQueryText:', error);
        console.error('[slonik/check-sql] DEBUG: Query template:', context.sourceCode.getText(tag));
        throw error;
      }
    }),
    E.bindW("result", ({ query }) => {
      // If query is null, it means we should skip validation (e.g., dynamic sql.identifier)
      if (query === null) {
        return E.right(null);
      }
      return generateSyncE({ query, connection, target, projectDir });
    }),
    E.fold(
      (error) => {
        return match(error)
          .with({ _tag: "InvalidConfigError" }, (error) => {
            return reportInvalidConfig({ context, error, tag });
          })
          .with({ _tag: "DuplicateColumnsError" }, (error) => {
            return reportDuplicateColumns({ context, error, tag });
          })
          .with({ _tag: "PostgresError" }, (error) => {
            return reportPostgresError({ context, error, tag });
          })
          .with({ _tag: "InvalidQueryError" }, (error) => {
            return reportInvalidQueryError({ context, error });
          })
          .with(
            { _tag: "InvalidMigrationError" },
            { _tag: "InvalidMigrationsPathError" },
            { _tag: "DatabaseInitializationError" },
            (error) => {
              if (params.connection.keepAlive === true) {
                fatalError = error;
              }

              return reportBaseError({ context, error, tag });
            },
          )
          .with({ _tag: "InternalError" }, (error) => {
            // Check if this is a configuration error (should be reported)
            // vs a query parsing error (should be suppressed)
            const isConfigError = error.message.includes("Invalid override column key");

            if (isConfigError) {
              return reportBaseError({ context, error, tag });
            }

            // Suppress internal errors from the generator query parsing - these are typically
            // caused by unsupported SQL syntax that we cannot fix.
            // The query will be skipped without reporting an error.
            console.warn(
              `[eslint-plugin-slonik] Skipping query due to unsupported SQL syntax: ${error.message}\n` +
                `If you believe this query should be supported, please open an issue at https://github.com/gajus/eslint-plugin-slonik/issues`,
            );
            return;
          })
          .with({ _tag: "ConnectionFailedError" }, () => {
            // Connection has already failed - skip silently since we've already warned
            // and marked the connection as failed to prevent future attempts
            return;
          })
          .exhaustive();
      },
      () => {
        // Type annotation checking is disabled - we only validate SQL syntax
      },
    ),
  );
}

function hasParserServicesWithTypeInformation(
  parser: Partial<ParserServices> | undefined,
): parser is ParserServicesWithTypeInformation {
  return parser !== undefined && parser.program !== null;
}

function checkConnectionByTagExpression(params: {
  context: RuleContext;
  connection: RuleOptionConnection;
  target: TagTarget;
  tag: TSESTree.TaggedTemplateExpression;
  projectDir: string;
}) {
  const { context, tag, projectDir, connection, target } = params;

  const tagAsText = context.sourceCode.getText(tag.tag).replace(/^this\./, "");

  if (doesMatchPattern({ pattern: target.tag, text: tagAsText })) {
    return reportCheck({
      context,
      tag,
      connection,
      target,
      projectDir,
      baseNode: tag.tag,
      typeParameter: tag.typeArguments,
    });
  }
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

function checkConnectionByWrapperExpression(params: {
  context: RuleContext;
  connection: RuleOptionConnection;
  target: WrapperTarget;
  tag: TSESTree.TaggedTemplateExpression;
  projectDir: string;
}) {
  const { context, tag, projectDir, connection, target } = params;

  if (!isTagMemberValid(tag)) {
    return;
  }

  const wrapperNode = getValidParentUntilDepth(tag.parent, target.maxDepth ?? 0);

  if (wrapperNode === null) {
    return;
  }

  const calleeAsText = context.sourceCode.getText(wrapperNode.callee).replace(/^this\./, "");

  if (doesMatchPattern({ pattern: target.wrapper, text: calleeAsText })) {
    return reportCheck({
      context,
      tag,
      connection,
      target,
      projectDir,
      baseNode: wrapperNode.callee,
      typeParameter: wrapperNode.typeArguments,
    });
  }
}

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

    return {
      TaggedTemplateExpression(tag) {
        check({ context, tag, config, projectDir });
      },
    };
  },
});
