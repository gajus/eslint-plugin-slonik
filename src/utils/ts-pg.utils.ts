import {
  defaultTypeMapping,
  doesMatchPattern,
  InvalidQueryError,
  normalizeIndent,
  QuerySourceMapEntry,
} from "@ts-safeql/shared";
import { TSESTreeToTSNode } from "@typescript-eslint/typescript-estree";
import { ParserServices, TSESLint, TSESTree } from "@typescript-eslint/utils";
import ts, { TypeChecker } from "typescript";
import { RuleOptionConnection } from "../rules/RuleOptions";
import { E, pipe } from "./fp-ts";
import { TSUtils } from "./ts.utils";
import { isLastQueryContextOneOf } from "./query-context";

/**
 * Slonik SQL token types that represent SQL fragments/builders.
 * These types cannot be converted to PostgreSQL placeholder types
 * because they represent dynamic SQL construction at runtime.
 *
 * When we encounter these types, we skip type checking for that expression
 * and the query containing it.
 */
const SLONIK_SQL_TOKEN_TYPES = new Set([
  // Core SQL tokens from Slonik
  "SqlToken",
  "SqlSqlToken",
  "QuerySqlToken",
  "FragmentSqlToken",
  "SqlFragmentToken",
  "SqlFragment",        // Return type of sql.fragment
  "ListSqlToken",
  "UnnestSqlToken",
  "IdentifierSqlToken",
  "ArraySqlToken",
  "JsonSqlToken",
  "JsonBinarySqlToken",
  "BinarySqlToken",
  "DateSqlToken",
  "TimestampSqlToken",
  "IntervalSqlToken",
  "UuidSqlToken",       // Return type of sql.uuid

  // Generic/union types
  "PrimitiveValueExpression",
  "ValueExpression",
  "SqlTokenType",
]);

/**
 * Check if a TypeScript type string represents a Slonik SQL token.
 * This handles both direct matches and generic type parameters.
 */
function isSlonikSqlTokenType(typeStr: string): boolean {
  // Direct match
  if (SLONIK_SQL_TOKEN_TYPES.has(typeStr)) {
    return true;
  }

  // Check if any Slonik token type appears in the type string
  // This handles cases like "QuerySqlToken<...>" or "FragmentSqlToken | null"
  for (const tokenType of SLONIK_SQL_TOKEN_TYPES) {
    if (typeStr.includes(tokenType)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if an expression is a Slonik sql.array() call and extract the PostgreSQL type.
 * 
 * Slonik sql.array() syntax:
 *   sql.array([1, 2, 3], 'int4')
 *   sql.array(values, 'text')
 * 
 * The second argument is the PostgreSQL type name.
 * Returns the array type (e.g., 'int4[]') or null if not a sql.array() call.
 */
function extractSlonikArrayType(expression: TSESTree.Expression): string | null {
  // Check if it's a call expression
  if (expression.type !== "CallExpression") {
    return null;
  }

  const callee = expression.callee;

  // Check if callee is sql.array (MemberExpression)
  if (callee.type !== "MemberExpression") {
    return null;
  }

  // Check if property is 'array'
  if (callee.property.type !== "Identifier" || callee.property.name !== "array") {
    return null;
  }

  // Check if object is 'sql' (could be Identifier or another MemberExpression for this.sql, etc.)
  const objectName = getMemberExpressionObjectName(callee.object);
  if (objectName !== "sql") {
    return null;
  }

  // Get the second argument (type hint)
  const typeArg = expression.arguments[1];
  if (!typeArg) {
    return null;
  }

  // Extract the type string from the literal
  if (typeArg.type === "Literal" && typeof typeArg.value === "string") {
    // Return as array type
    return `${typeArg.value}[]`;
  }

  return null;
}

/**
 * Get the name of the object in a member expression.
 * Handles both simple identifiers (sql) and this expressions (this.sql).
 */
function getMemberExpressionObjectName(node: TSESTree.Expression): string | null {
  if (node.type === "Identifier") {
    return node.name;
  }
  
  // Handle this.sql pattern
  if (node.type === "MemberExpression" && 
      node.object.type === "ThisExpression" &&
      node.property.type === "Identifier") {
    return node.property.name;
  }

  return null;
}

/**
 * Check if an expression is a Slonik sql.identifier() call.
 * Returns true if this is a sql.identifier() call (regardless of whether arguments are static or dynamic).
 */
function isSlonikIdentifierCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "identifier") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Check if an expression is a Slonik sql.identifier() call and extract the identifier parts.
 * 
 * Slonik sql.identifier() syntax:
 *   sql.identifier(['column'])              → "column"
 *   sql.identifier(['schema', 'table'])     → "schema"."table"
 *   sql.identifier(['schema', 'table', 'column']) → "schema"."table"."column"
 * 
 * Returns the quoted identifier string or null if not a sql.identifier() call or has dynamic arguments.
 */
function extractSlonikIdentifier(expression: TSESTree.Expression): string | null {
  // Check if it's a call expression
  if (expression.type !== "CallExpression") {
    return null;
  }

  const callee = expression.callee;

  // Check if callee is sql.identifier (MemberExpression)
  if (callee.type !== "MemberExpression") {
    return null;
  }

  // Check if property is 'identifier'
  if (callee.property.type !== "Identifier" || callee.property.name !== "identifier") {
    return null;
  }

  // Check if object is 'sql'
  const objectName = getMemberExpressionObjectName(callee.object);
  if (objectName !== "sql") {
    return null;
  }

  // Get the first argument (identifier parts array)
  const partsArg = expression.arguments[0];
  if (!partsArg) {
    return null;
  }

  // Extract the identifier parts from the array
  if (partsArg.type === "ArrayExpression") {
    const parts: string[] = [];
    for (const element of partsArg.elements) {
      if (element && element.type === "Literal" && typeof element.value === "string") {
        parts.push(element.value);
      } else {
        // If any element is not a string literal, we can't extract the identifier
        return null;
      }
    }
    
    if (parts.length === 0) {
      return null;
    }
    
    // Return as quoted identifier: "part1"."part2"."part3"
    return parts.map(part => `"${part}"`).join(".");
  }

  return null;
}

/**
 * Check if an expression is a Slonik sql.join() call.
 * These should be skipped as they join multiple fragments at runtime.
 * 
 * Slonik sql.join() syntax:
 *   sql.join([sql.fragment`a = 1`, sql.fragment`b = 2`], sql.fragment` AND `)
 * 
 * Returns true if this is a sql.join() call.
 */
function isSlonikJoinCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "join") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Check if an expression is a Slonik sql.date() call.
 * 
 * Slonik sql.date() syntax:
 *   sql.date(new Date())
 *   sql.date(myDateVariable)
 * 
 * Returns true if this is a sql.date() call.
 */
function isSlonikDateCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "date") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Check if an expression is a Slonik sql.timestamp() call.
 * 
 * Slonik sql.timestamp() syntax:
 *   sql.timestamp(new Date())
 *   sql.timestamp(myDateVariable)
 * 
 * Returns true if this is a sql.timestamp() call.
 */
function isSlonikTimestampCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "timestamp") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Check if an expression is a Slonik sql.interval() call.
 * 
 * Slonik sql.interval() syntax:
 *   sql.interval({ days: 1, hours: 2 })
 *   sql.interval(myIntervalObject)
 * 
 * Returns true if this is a sql.interval() call.
 */
function isSlonikIntervalCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "interval") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Check if an expression is a Slonik sql.json() call.
 * 
 * Slonik sql.json() syntax:
 *   sql.json({ key: 'value' })
 *   sql.json(myObject)
 * 
 * Returns true if this is a sql.json() call.
 */
function isSlonikJsonCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "json") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Check if an expression is a Slonik sql.jsonb() call.
 * 
 * Slonik sql.jsonb() syntax:
 *   sql.jsonb({ key: 'value' })
 *   sql.jsonb(myObject)
 * 
 * Returns true if this is a sql.jsonb() call.
 */
function isSlonikJsonbCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "jsonb") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Check if an expression is a Slonik sql.literalValue() call.
 * 
 * Slonik sql.literalValue() syntax:
 *   sql.literalValue('some text')
 *   sql.literalValue(123)
 * 
 * Returns true if this is a sql.literalValue() call.
 */
function isSlonikLiteralValueCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callee = expression.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  if (callee.property.type !== "Identifier" || callee.property.name !== "literalValue") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(callee.object);
  return objectName === "sql";
}

/**
 * Result of extracting a Slonik sql.fragment expression.
 * Contains the SQL text and any nested expressions that need type checking.
 */
interface SlonikFragmentResult {
  /** The SQL text with placeholders for expressions */
  sqlText: string;
  /** Nested expressions that need to be processed for type checking */
  expressions: TSESTree.Expression[];
}

/**
 * Check if an expression is a Slonik sql.fragment`...` tagged template and extract its content.
 * 
 * Slonik sql.fragment syntax:
 *   sql.fragment`WHERE active = true`
 *   sql.fragment`WHERE id = ${id}`
 * 
 * Returns the SQL text with placeholder markers for any nested expressions,
 * or null if not a sql.fragment expression.
 */
function extractSlonikFragment(expression: TSESTree.Expression): SlonikFragmentResult | null {
  // Check if it's a tagged template expression
  if (expression.type !== "TaggedTemplateExpression") {
    return null;
  }

  const tag = expression.tag;

  // Check if tag is sql.fragment (MemberExpression)
  if (tag.type !== "MemberExpression") {
    return null;
  }

  // Check if property is 'fragment'
  if (tag.property.type !== "Identifier" || tag.property.name !== "fragment") {
    return null;
  }

  // Check if object is 'sql'
  const objectName = getMemberExpressionObjectName(tag.object);
  if (objectName !== "sql") {
    return null;
  }

  // Extract the SQL text from the template literal
  const quasi = expression.quasi;
  let sqlText = "";
  const nestedExpressions: TSESTree.Expression[] = [];

  for (const [i, templateElement] of quasi.quasis.entries()) {
    sqlText += templateElement.value.raw;

    if (!templateElement.tail && quasi.expressions[i]) {
      // Mark where expressions go - we'll use a special placeholder
      // that will be replaced during processing
      nestedExpressions.push(quasi.expressions[i] as TSESTree.Expression);
      sqlText += `\${__FRAGMENT_EXPR_${nestedExpressions.length - 1}__}`;
    }
  }

  return { sqlText, expressions: nestedExpressions };
}

/**
 * Check if an expression is a Slonik sql.unnest() call and extract the PostgreSQL types.
 * 
 * Slonik sql.unnest() syntax:
 *   sql.unnest([[1, 'foo'], [2, 'bar']], ['int4', 'text'])
 * 
 * The second argument is an array of PostgreSQL type names, one per column.
 * Returns the array types (e.g., ['int4[]', 'text[]']) or null if not a sql.unnest() call.
 */
function extractSlonikUnnestTypes(expression: TSESTree.Expression): string[] | null {
  // Check if it's a call expression
  if (expression.type !== "CallExpression") {
    return null;
  }

  const callee = expression.callee;

  // Check if callee is sql.unnest (MemberExpression)
  if (callee.type !== "MemberExpression") {
    return null;
  }

  // Check if property is 'unnest'
  if (callee.property.type !== "Identifier" || callee.property.name !== "unnest") {
    return null;
  }

  // Check if object is 'sql'
  const objectName = getMemberExpressionObjectName(callee.object);
  if (objectName !== "sql") {
    return null;
  }

  // Get the second argument (type hints array)
  const typeArg = expression.arguments[1];
  if (!typeArg) {
    return null;
  }

  // Extract the type strings from the array
  if (typeArg.type === "ArrayExpression") {
    const types: string[] = [];
    for (const element of typeArg.elements) {
      if (element && element.type === "Literal" && typeof element.value === "string") {
        types.push(`${element.value}[]`);
      } else {
        // If any element is not a string literal, we can't extract types
        return null;
      }
    }
    return types.length > 0 ? types : null;
  }

  return null;
}

export function mapTemplateLiteralToQueryText(
  quasi: TSESTree.TemplateLiteral,
  parser: ParserServices,
  checker: ts.TypeChecker,
  options: RuleOptionConnection,
  sourceCode: Readonly<TSESLint.SourceCode>,
) {
  let $idx = 0;
  let $queryText = "";
  const sourcemaps: QuerySourceMapEntry[] = [];

  for (const [quasiIdx, $quasi] of quasi.quasis.entries()) {
    $queryText += $quasi.value.raw;

    if ($quasi.tail) {
      break;
    }

    const position = $queryText.length;
    const expression = quasi.expressions[quasiIdx];

    // Guard against undefined expression (should not happen with well-formed template literals)
    if (!expression) {
      console.error('[slonik/check-sql] DEBUG: expression is undefined at index', quasiIdx, {
        quasiCount: quasi.quasis.length,
        expressionCount: quasi.expressions.length,
        queryTextSoFar: $queryText,
      });
      continue;
    }

    // Check for Slonik sql.array() calls first - these have explicit type hints
    const slonikArrayType = extractSlonikArrayType(expression);
    if (slonikArrayType !== null) {
      const placeholder = `$${++$idx}::${slonikArrayType}`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.identifier() calls - embed the quoted identifier directly
    const slonikIdentifier = extractSlonikIdentifier(expression);
    if (slonikIdentifier !== null) {
      $queryText += slonikIdentifier;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + slonikIdentifier.length,
          text: slonikIdentifier,
        },
        offset: 0,
      });

      continue;
    }

    // If it's a sql.identifier() call but we couldn't extract static identifier parts,
    // it means it has dynamic arguments - skip validation for the entire query
    if (isSlonikIdentifierCall(expression)) {
      return E.right(null);
    }

    // Check for Slonik sql.join() calls - skip validation as content is determined at runtime
    if (isSlonikJoinCall(expression)) {
      return E.right(null);
    }

    // Check for Slonik sql.date() calls - these format a Date to a PostgreSQL date literal
    if (isSlonikDateCall(expression)) {
      const placeholder = `$${++$idx}::date`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.timestamp() calls - these format a Date to a PostgreSQL timestamptz literal
    if (isSlonikTimestampCall(expression)) {
      const placeholder = `$${++$idx}::timestamptz`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.interval() calls - these format an interval object to a PostgreSQL interval literal
    if (isSlonikIntervalCall(expression)) {
      const placeholder = `$${++$idx}::interval`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.json() calls - these serialize an object to a PostgreSQL json value
    if (isSlonikJsonCall(expression)) {
      const placeholder = `$${++$idx}::json`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.jsonb() calls - these serialize an object to a PostgreSQL jsonb value
    if (isSlonikJsonbCall(expression)) {
      const placeholder = `$${++$idx}::jsonb`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.literalValue() calls - these insert a value as a SQL literal
    if (isSlonikLiteralValueCall(expression)) {
      const placeholder = `$${++$idx}`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.unnest() calls - these have explicit column type hints
    const slonikUnnestTypes = extractSlonikUnnestTypes(expression);
    if (slonikUnnestTypes !== null) {
      // Generate UNNEST with typed array placeholders for each column
      // e.g., unnest($1::int4[], $2::text[])
      const placeholders = slonikUnnestTypes.map((type) => `$${++$idx}::${type}`);
      const placeholder = `unnest(${placeholders.join(", ")})`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    // Check for Slonik sql.fragment`...` expressions - embed the SQL directly
    const slonikFragment = extractSlonikFragment(expression);
    if (slonikFragment !== null) {
      // Process nested expressions within the fragment
      let fragmentSql = slonikFragment.sqlText;
      
      for (let i = 0; i < slonikFragment.expressions.length; i++) {
        const nestedExpr = slonikFragment.expressions[i];
        const nestedPgType = pipe(
          mapExpressionToTsTypeString({ expression: nestedExpr, parser, checker }),
          (params) => getPgTypeFromTsType({ ...params, checker, options }),
        );

        let nestedPlaceholder: string;
        if (E.isLeft(nestedPgType) || nestedPgType.right === null) {
          // If we can't determine the type, use a simple placeholder
          nestedPlaceholder = `$${++$idx}`;
        } else if (nestedPgType.right.kind === "literal") {
          nestedPlaceholder = nestedPgType.right.value;
        } else {
          nestedPlaceholder = `$${++$idx}::${nestedPgType.right.cast}`;
        }

        fragmentSql = fragmentSql.replace(`\${__FRAGMENT_EXPR_${i}__}`, nestedPlaceholder);
      }

      $queryText += fragmentSql;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0],
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + fragmentSql.length,
          text: fragmentSql,
        },
        offset: 0,
      });

      continue;
    }

    // Check if the expression is a Slonik SQL token type (nested query/fragment)
    // These represent dynamic SQL that cannot be analyzed statically, so skip validation
    const tsNode = parser.esTreeNodeToTSNodeMap.get(expression);
    if (tsNode) {
      const expressionType = checker.getTypeAtLocation(tsNode);
      const expressionTypeStr = checker.typeToString(expressionType);
      if (isSlonikSqlTokenType(expressionTypeStr)) {
        return E.right(null);
      }
    }

    const pgType = pipe(mapExpressionToTsTypeString({ expression, parser, checker }), (params) =>
      getPgTypeFromTsType({ ...params, checker, options }),
    );

    if (E.isLeft(pgType)) {
      return E.left(InvalidQueryError.of(pgType.left, expression));
    }

    const pgTypeValue = pgType.right;

    if (pgTypeValue === null) {
      const placeholder = `$${++$idx}`;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0] + 1,
        },
        generated: {
          text: placeholder,
          start: position,
          end: position + placeholder.length,
        },
        offset: 0,
      });

      continue;
    }

    if (pgTypeValue.kind === "literal") {
      const placeholder = pgTypeValue.value;
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2,
          end: expression.range[1] - quasi.range[0] + 1,
          text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
        },
        generated: {
          start: position,
          end: position + placeholder.length,
          text: placeholder,
        },
        offset: 0,
      });

      continue;
    }

    const escapePgValue = (text: string) => text.replace(/'/g, "''");

    if (
      pgTypeValue.kind === "one-of" &&
      $queryText.trimEnd().endsWith("=") &&
      isLastQueryContextOneOf($queryText, ["SELECT", "ON", "WHERE", "WHEN", "HAVING", "RETURNING"])
    ) {
      const textFromEquals = $queryText.slice($queryText.lastIndexOf("="));
      const placeholder = `IN (${pgTypeValue.types.map((t) => `'${escapePgValue(t)}'`).join(", ")})`;
      const expressionText = sourceCode.text.slice(
        expression.range[0] - 2,
        expression.range[1] + 1,
      );

      $queryText = $queryText.replace(/(=)\s*$/, "");
      $queryText += placeholder;

      sourcemaps.push({
        original: {
          start: expression.range[0] - quasi.range[0] - 2 - textFromEquals.length,
          end: expression.range[1] - quasi.range[0] + 2 - textFromEquals.length,
          text: `${textFromEquals}${expressionText}`,
        },
        generated: {
          start: position - textFromEquals.length + 1,
          end: position + placeholder.length - textFromEquals.length,
          text: placeholder,
        },
        offset: textFromEquals.length,
      });

      continue;
    }

    const placeholder = `$${++$idx}::${pgTypeValue.cast}`;
    $queryText += placeholder;

    sourcemaps.push({
      original: {
        start: expression.range[0] - quasi.range[0] - 2,
        end: expression.range[1] - quasi.range[0],
        text: sourceCode.text.slice(expression.range[0] - 2, expression.range[1] + 1),
      },
      generated: {
        start: position,
        end: position + placeholder.length,
        text: placeholder,
      },
      offset: 0,
    });
  }

  return E.right({ text: $queryText, sourcemaps });
}

function mapExpressionToTsTypeString(params: {
  expression: TSESTree.Expression;
  parser: ParserServices;
  checker: ts.TypeChecker;
}) {
  const tsNode = params.parser.esTreeNodeToTSNodeMap.get(params.expression);
  const tsType = params.checker.getTypeAtLocation(tsNode);
  return {
    node: tsNode,
    type: tsType,
  };
}

const tsTypeToPgTypeMap: Record<string, string> = {
  number: "int",
  string: "text",
  boolean: "boolean",
  bigint: "bigint",
  any: "text",
  unknown: "text",
};

const tsFlagToPgTypeMap: Record<number, string> = {
  [ts.TypeFlags.String]: "text",
  [ts.TypeFlags.Number]: "int",
  [ts.TypeFlags.Boolean]: "boolean",
  [ts.TypeFlags.BigInt]: "bigint",
  [ts.TypeFlags.NumberLiteral]: "int",
  [ts.TypeFlags.StringLiteral]: "text",
  [ts.TypeFlags.BooleanLiteral]: "boolean",
  [ts.TypeFlags.BigIntLiteral]: "bigint",
};

function getPgTypeFromTsTypeUnion(params: {
  types: ts.Type[];
  checker: ts.TypeChecker;
  options: RuleOptionConnection;
}): E.Either<string, PgTypeStrategy | null> {
  const { types, checker, options } = params;
  const nonNullTypes = types.filter((t) => (t.flags & ts.TypeFlags.Null) === 0);

  if (nonNullTypes.length === 0) {
    return E.right(null);
  }

  // Check if any member of the union is a Slonik SQL token type
  // If so, we can't validate the union and should skip it
  const hasSlonikToken = nonNullTypes.some((t) => {
    const typeStr = checker.typeToString(t);
    return isSlonikSqlTokenType(typeStr);
  });

  if (hasSlonikToken) {
    return E.right(null);
  }

  const isStringLiterals = nonNullTypes.every((t) => t.flags & ts.TypeFlags.StringLiteral);

  if (isStringLiterals) {
    return E.right({
      kind: "one-of",
      types: nonNullTypes.map((t) => (t as ts.StringLiteralType).value),
      cast: "text",
    });
  }

  const results = nonNullTypes.map((t) => checkType({ checker, type: t, options }));
  const strategies: PgTypeStrategy[] = [];

  for (const result of results) {
    if (E.isLeft(result)) {
      return result;
    }
    if (result.right !== null) {
      strategies.push(result.right);
    }
  }

  if (strategies.length === 0) {
    const typesStr = nonNullTypes.map((t) => checker.typeToString(t)).join(", ");
    return E.left(`No PostgreSQL type could be inferred for the union members: ${typesStr}`);
  }

  const firstStrategy = strategies[0];
  const mixedTypes: string[] = [firstStrategy.cast];

  for (let i = 1; i < strategies.length; i++) {
    const strategy = strategies[i];
    if (strategy.cast !== firstStrategy.cast) {
      mixedTypes.push(strategy.cast);
    }
  }

  if (mixedTypes.length > 1) {
    return E.left(
      `Union types must result in the same PostgreSQL type (found ${mixedTypes.join(", ")})`,
    );
  }

  return E.right(firstStrategy);
}

type PgTypeStrategy =
  | { kind: "cast"; cast: string }
  | { kind: "literal"; value: string; cast: string }
  | { kind: "one-of"; types: string[]; cast: string };

function getPgTypeFromTsType(params: {
  checker: TypeChecker;
  node: TSESTreeToTSNode<TSESTree.Expression>;
  type: ts.Type;
  options: RuleOptionConnection;
}): E.Either<string, PgTypeStrategy | null> {
  const { checker, node, type, options } = params;

  // First check if the overall type is a Slonik token
  const typeStr = checker.typeToString(type);
  if (isSlonikSqlTokenType(typeStr)) {
    return E.right(null);
  }

  if (node.kind === ts.SyntaxKind.ConditionalExpression) {
    const trueType = checker.getTypeAtLocation(node.whenTrue);
    const falseType = checker.getTypeAtLocation(node.whenFalse);

    // Check if either branch is a Slonik token type
    const trueTypeStr = checker.typeToString(trueType);
    const falseTypeStr = checker.typeToString(falseType);

    if (isSlonikSqlTokenType(trueTypeStr) || isSlonikSqlTokenType(falseTypeStr)) {
      // If either branch is a Slonik token, skip validation for the entire expression
      return E.right(null);
    }

    const whenTrue = checkType({
      checker,
      type: trueType,
      options,
    });

    const whenFalse = checkType({
      checker,
      type: falseType,
      options,
    });

    if (E.isLeft(whenTrue)) {
      return whenTrue;
    }
    if (E.isLeft(whenFalse)) {
      return whenFalse;
    }

    const trueStrategy = whenTrue.right;
    const falseStrategy = whenFalse.right;

    if (trueStrategy === null && falseStrategy === null) {
      return E.right(null);
    }

    if (
      trueStrategy !== null &&
      falseStrategy !== null &&
      trueStrategy.cast !== falseStrategy.cast
    ) {
      return E.left(
        `Conditional expression must have the same type (true = ${trueStrategy.cast}, false = ${falseStrategy.cast})`,
      );
    }

    const strategy = trueStrategy ?? falseStrategy;
    if (strategy === null) {
      return E.right(null);
    }

    return E.right({ kind: "cast", cast: strategy.cast });
  }

  return checkType({ checker, type, options });
}

function checkType(params: {
  checker: TypeChecker;
  type: ts.Type;
  options: RuleOptionConnection;
}): E.Either<string, PgTypeStrategy | null> {
  const { checker, type, options } = params;

  if (type.flags & ts.TypeFlags.Null) {
    return E.right(null);
  }

  const typeStr = checker.typeToString(type);

  // Skip Slonik SQL token types - these represent dynamic SQL fragments
  // that cannot be validated at lint time
  if (isSlonikSqlTokenType(typeStr)) {
    return E.right(null);
  }

  const singularType = typeStr.replace(/\[\]$/, "");
  const isArray = typeStr !== singularType;
  const singularPgType = tsTypeToPgTypeMap[singularType];

  if (singularPgType) {
    return E.right({ kind: "cast", cast: isArray ? `${singularPgType}[]` : singularPgType });
  }

  // Handle overrides
  const typesWithOverrides = { ...defaultTypeMapping, ...options.overrides?.types };
  const override = Object.entries(typesWithOverrides).find(([, tsType]) =>
    doesMatchPattern({
      pattern: typeof tsType === "string" ? tsType : tsType.parameter,
      text: singularType,
    }),
  );

  if (override) {
    const [pgType] = override;
    return E.right({ kind: "cast", cast: isArray ? `${pgType}[]` : pgType });
  }

  const enumType = TSUtils.getEnumKind(type);

  if (enumType) {
    switch (enumType.kind) {
      case "Const":
      case "Numeric":
        return E.right({ kind: "cast", cast: "int" });
      case "String":
        return E.right({ kind: "one-of", types: enumType.values, cast: "text" });
      case "Heterogeneous":
        return E.left("Heterogeneous enums are not supported");
    }
  }

  if (checker.isArrayType(type)) {
    const elementType = (type as ts.TypeReference).typeArguments?.[0];

    if (elementType) {
      return pipe(
        checkType({ checker, type: elementType, options }),
        E.map((pgType): PgTypeStrategy | null =>
          pgType === null ? null : { kind: "cast", cast: `${pgType.cast}[]` },
        ),
      );
    }
  }

  if (type.isStringLiteral()) {
    return E.right({ kind: "literal", value: `'${type.value}'`, cast: "text" });
  }

  if (type.isNumberLiteral()) {
    return E.right({ kind: "literal", value: `${type.value}`, cast: "int" });
  }

  // Handle union types
  if (type.isUnion()) {
    return pipe(
      getPgTypeFromTsTypeUnion({ types: type.types, checker, options }),
      E.chain((pgType) =>
        pgType === null ? E.left("Unsupported union type (only null)") : E.right(pgType),
      ),
    );
  }

  if (type.flags in tsFlagToPgTypeMap) {
    const pgType = tsFlagToPgTypeMap[type.flags];
    return E.right({ kind: "cast", cast: isArray ? `${pgType}[]` : pgType });
  }

  // Fallback for unsupported types
  return E.left(normalizeIndent`
    The type "${typeStr}" has no corresponding PostgreSQL type.
    Please add it manually using the "overrides.types" option:

    \`\`\`ts
    {
      "connections": {
        ...,
        "overrides": {
          "types": {
            "PG TYPE (e.g. 'date')": "${typeStr}"
          }
        }
      }
    }
    \`\`\`

    Read docs - https://github.com/gajus/eslint-plugin-slonik#type-override-reference
  `);
}
