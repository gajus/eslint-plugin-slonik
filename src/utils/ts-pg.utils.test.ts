import { describe, it, expect } from "vitest";
import { TSESTree, ParserServices } from "@typescript-eslint/utils";
import { mapTemplateLiteralToQueryText } from "./ts-pg.utils";
import { RuleOptionConnection } from "../rules/RuleOptions";
import { E } from "./fp-ts";

/**
 * Tests for mapTemplateLiteralToQueryText fallback behavior.
 * When the TypeScript type checker is not available (e.g., OXLint JS plugins),
 * the function should use untyped placeholders instead of failing.
 */

// Mock source code object
function createMockSourceCode(text: string) {
  return {
    text,
  } as any;
}

// Mock parser services without type checker
function createMockParserServices(): ParserServices {
  return {
    esTreeNodeToTSNodeMap: new WeakMap(),
    tsNodeToESTreeNodeMap: new WeakMap(),
    program: null,
  } as any;
}

// Mock connection options
function createMockConnection(): RuleOptionConnection {
  return {
    databaseUrl: "postgresql://localhost/test",
    targets: [{ tag: "sql" }],
  };
}

// Helper to create a mock template literal
function createMockTemplateLiteral(
  quasis: string[],
  expressions: TSESTree.Expression[] = []
): TSESTree.TemplateLiteral {
  const range: [number, number] = [0, 100];

  return {
    type: "TemplateLiteral",
    quasis: quasis.map((raw, i) => ({
      type: "TemplateElement",
      value: { raw, cooked: raw },
      tail: i === quasis.length - 1,
      range: [i * 10, i * 10 + raw.length] as [number, number],
      loc: {} as any,
    })),
    expressions: expressions.map((expr, i) => ({
      ...expr,
      range: [quasis.slice(0, i + 1).join("").length + 2, quasis.slice(0, i + 1).join("").length + 5] as [number, number],
    })),
    range,
    loc: {} as any,
  } as TSESTree.TemplateLiteral;
}

// Helper to create a mock identifier expression
function createMockIdentifier(name: string): TSESTree.Identifier {
  return {
    type: "Identifier",
    name,
    range: [0, name.length] as [number, number],
    loc: {} as any,
  } as TSESTree.Identifier;
}

// Helper to create a mock sql.array() call
function createMockSqlArrayCall(typeHint: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: "sql",
        range: [0, 3] as [number, number],
        loc: {} as any,
      } as TSESTree.Identifier,
      property: {
        type: "Identifier",
        name: "array",
        range: [4, 9] as [number, number],
        loc: {} as any,
      } as TSESTree.Identifier,
      computed: false,
      optional: false,
      range: [0, 9] as [number, number],
      loc: {} as any,
    } as TSESTree.MemberExpression,
    arguments: [
      {
        type: "ArrayExpression",
        elements: [],
        range: [10, 12] as [number, number],
        loc: {} as any,
      } as TSESTree.ArrayExpression,
      {
        type: "Literal",
        value: typeHint,
        raw: `'${typeHint}'`,
        range: [14, 14 + typeHint.length + 2] as [number, number],
        loc: {} as any,
      } as TSESTree.Literal,
    ],
    optional: false,
    range: [0, 20] as [number, number],
    loc: {} as any,
  } as TSESTree.CallExpression;
}

// Helper to create a mock sql.date() call
function createMockSqlDateCall(): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: "sql",
        range: [0, 3] as [number, number],
        loc: {} as any,
      } as TSESTree.Identifier,
      property: {
        type: "Identifier",
        name: "date",
        range: [4, 8] as [number, number],
        loc: {} as any,
      } as TSESTree.Identifier,
      computed: false,
      optional: false,
      range: [0, 8] as [number, number],
      loc: {} as any,
    } as TSESTree.MemberExpression,
    arguments: [
      {
        type: "NewExpression",
        callee: {
          type: "Identifier",
          name: "Date",
          range: [9, 13] as [number, number],
          loc: {} as any,
        } as TSESTree.Identifier,
        arguments: [],
        range: [9, 15] as [number, number],
        loc: {} as any,
      } as TSESTree.NewExpression,
    ],
    optional: false,
    range: [0, 16] as [number, number],
    loc: {} as any,
  } as TSESTree.CallExpression;
}

// Helper to create a mock sql.identifier() call
function createMockSqlIdentifierCall(parts: string[]): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: "sql",
        range: [0, 3] as [number, number],
        loc: {} as any,
      } as TSESTree.Identifier,
      property: {
        type: "Identifier",
        name: "identifier",
        range: [4, 14] as [number, number],
        loc: {} as any,
      } as TSESTree.Identifier,
      computed: false,
      optional: false,
      range: [0, 14] as [number, number],
      loc: {} as any,
    } as TSESTree.MemberExpression,
    arguments: [
      {
        type: "ArrayExpression",
        elements: parts.map((part) => ({
          type: "Literal",
          value: part,
          raw: `'${part}'`,
          range: [0, part.length + 2] as [number, number],
          loc: {} as any,
        } as TSESTree.Literal)),
        range: [15, 30] as [number, number],
        loc: {} as any,
      } as TSESTree.ArrayExpression,
    ],
    optional: false,
    range: [0, 31] as [number, number],
    loc: {} as any,
  } as TSESTree.CallExpression;
}

describe("mapTemplateLiteralToQueryText", () => {
  describe("fallback behavior without type checker", () => {
    it("should handle static SQL without expressions", () => {
      const quasi = createMockTemplateLiteral(["SELECT * FROM users"]);
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`SELECT * FROM users`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right?.text).toBe("SELECT * FROM users");
      }
    });

    it("should use untyped placeholder for variable expressions when checker is null", () => {
      const quasi = createMockTemplateLiteral(
        ["SELECT * FROM users WHERE id = ", ""],
        [createMockIdentifier("userId")]
      );
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`SELECT * FROM users WHERE id = ${userId}`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        // Should use untyped placeholder $1 instead of $1::int
        expect(result.right?.text).toBe("SELECT * FROM users WHERE id = $1");
      }
    });

    it("should use untyped placeholders for multiple expressions", () => {
      const quasi = createMockTemplateLiteral(
        ["SELECT * FROM users WHERE id = ", " AND name = ", ""],
        [createMockIdentifier("userId"), createMockIdentifier("userName")]
      );
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`SELECT * FROM users WHERE id = ${userId} AND name = ${userName}`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right?.text).toBe("SELECT * FROM users WHERE id = $1 AND name = $2");
      }
    });

    it("should still use typed placeholder for sql.array() with explicit type hint", () => {
      const quasi = createMockTemplateLiteral(
        ["SELECT * FROM users WHERE id = ANY(", ")"],
        [createMockSqlArrayCall("int4")]
      );
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`SELECT * FROM users WHERE id = ANY(${sql.array(ids, 'int4')})`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        // sql.array() provides explicit type hint, so it should be typed
        expect(result.right?.text).toBe("SELECT * FROM users WHERE id = ANY($1::int4[])");
      }
    });

    it("should still use typed placeholder for sql.date()", () => {
      const quasi = createMockTemplateLiteral(
        ["SELECT * FROM events WHERE date = ", ""],
        [createMockSqlDateCall()]
      );
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`SELECT * FROM events WHERE date = ${sql.date(new Date())}`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        // sql.date() has known return type
        expect(result.right?.text).toBe("SELECT * FROM events WHERE date = $1::date");
      }
    });

    it("should embed sql.identifier() directly without type checker", () => {
      const quasi = createMockTemplateLiteral(
        ["SELECT * FROM ", ""],
        [createMockSqlIdentifierCall(["users"])]
      );
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`SELECT * FROM ${sql.identifier(['users'])}`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        // sql.identifier() is embedded directly as quoted identifier
        expect(result.right?.text).toBe('SELECT * FROM "users"');
      }
    });

    it("should handle mixed AST-detected and unknown expressions", () => {
      const quasi = createMockTemplateLiteral(
        ["SELECT * FROM ", " WHERE id = ", ""],
        [createMockSqlIdentifierCall(["users"]), createMockIdentifier("userId")]
      );
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`SELECT * FROM ${sql.identifier(['users'])} WHERE id = ${userId}`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        // sql.identifier() embedded, userId uses untyped placeholder
        expect(result.right?.text).toBe('SELECT * FROM "users" WHERE id = $1');
      }
    });

    it("should skip queries with @check-sql-disable comment", () => {
      const quasi = createMockTemplateLiteral(["/* @check-sql-disable */ SELECT * FROM dynamic_table"]);
      const parser = createMockParserServices();
      const connection = createMockConnection();
      const sourceCode = createMockSourceCode("sql`/* @check-sql-disable */ SELECT * FROM dynamic_table`");

      const result = mapTemplateLiteralToQueryText(quasi, parser, null, connection, sourceCode);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });
  });
});
