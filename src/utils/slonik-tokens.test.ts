import { describe, it, expect } from "vitest";
import { TSESTree } from "@typescript-eslint/utils";

/**
 * Tests for Slonik SQL token type detection and extraction.
 * These tests verify that Slonik-specific types are properly identified
 * without requiring a database connection.
 */

// Re-create the token detection logic for testing
const SLONIK_SQL_TOKEN_TYPES = new Set([
  "SqlToken",
  "SqlSqlToken",
  "QuerySqlToken",
  "FragmentSqlToken",
  "SqlFragmentToken",
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
  "PrimitiveValueExpression",
  "ValueExpression",
  "SqlTokenType",
]);

function isSlonikSqlTokenType(typeStr: string): boolean {
  if (SLONIK_SQL_TOKEN_TYPES.has(typeStr)) {
    return true;
  }

  for (const tokenType of SLONIK_SQL_TOKEN_TYPES) {
    if (typeStr.includes(tokenType)) {
      return true;
    }
  }

  return false;
}

describe("Slonik SQL Token Detection", () => {
  describe("isSlonikSqlTokenType", () => {
    it("should detect direct Slonik token types", () => {
      expect(isSlonikSqlTokenType("FragmentSqlToken")).toBe(true);
      expect(isSlonikSqlTokenType("SqlFragmentToken")).toBe(true);
      expect(isSlonikSqlTokenType("ListSqlToken")).toBe(true);
      expect(isSlonikSqlTokenType("UnnestSqlToken")).toBe(true);
      expect(isSlonikSqlTokenType("IdentifierSqlToken")).toBe(true);
      expect(isSlonikSqlTokenType("QuerySqlToken")).toBe(true);
      expect(isSlonikSqlTokenType("ArraySqlToken")).toBe(true);
    });

    it("should detect Slonik token types with generic parameters", () => {
      expect(isSlonikSqlTokenType("QuerySqlToken<{ id: number }>")).toBe(true);
      expect(isSlonikSqlTokenType("FragmentSqlToken<any>")).toBe(true);
    });

    it("should detect Slonik token types in union types", () => {
      expect(isSlonikSqlTokenType("FragmentSqlToken | null")).toBe(true);
      expect(isSlonikSqlTokenType("string | FragmentSqlToken")).toBe(true);
      expect(isSlonikSqlTokenType("number | ListSqlToken | null")).toBe(true);
    });

    it("should detect complex union types with Slonik tokens", () => {
      expect(
        isSlonikSqlTokenType("Date | null | FragmentSqlToken")
      ).toBe(true);
      expect(
        isSlonikSqlTokenType("QuerySqlToken<unknown> | FragmentSqlToken")
      ).toBe(true);
    });

    it("should not detect non-Slonik types", () => {
      expect(isSlonikSqlTokenType("string")).toBe(false);
      expect(isSlonikSqlTokenType("number")).toBe(false);
      expect(isSlonikSqlTokenType("boolean")).toBe(false);
      expect(isSlonikSqlTokenType("Date")).toBe(false);
      expect(isSlonikSqlTokenType("null")).toBe(false);
      expect(isSlonikSqlTokenType("string | number")).toBe(false);
      expect(isSlonikSqlTokenType("{ id: number }")).toBe(false);
    });

    it("should not false-positive on partial type names", () => {
      // These shouldn't match because they don't contain exact Slonik token names
      expect(isSlonikSqlTokenType("Fragment")).toBe(false);
      expect(isSlonikSqlTokenType("List")).toBe(false);
      expect(isSlonikSqlTokenType("Unnest")).toBe(false);
      expect(isSlonikSqlTokenType("Identifier")).toBe(false);
    });

    it("should match types containing Slonik token names (conservative approach)", () => {
      // The detection is conservative - it matches any type containing a Slonik token name
      // This prevents crashes when Slonik types are used in complex expressions
      // The trade-off is that it may skip validation for user types that happen to
      // contain these strings, which is very unlikely in practice
      expect(isSlonikSqlTokenType("MySqlToken")).toBe(true); // Contains "SqlToken"
      expect(isSlonikSqlTokenType("SqlTokenizer")).toBe(true); // Contains "SqlToken"
    });

    it("should handle edge cases", () => {
      expect(isSlonikSqlTokenType("")).toBe(false);
      expect(isSlonikSqlTokenType("SqlToken")).toBe(true); // Base type
      expect(isSlonikSqlTokenType("SqlSqlToken")).toBe(true);
    });
  });
});

// Re-create the sql.array extraction logic for testing
function getMemberExpressionObjectName(node: TSESTree.Expression): string | null {
  if (node.type === "Identifier") {
    return (node as TSESTree.Identifier).name;
  }
  
  if (node.type === "MemberExpression") {
    const memberExpr = node as TSESTree.MemberExpression;
    if (memberExpr.object.type === "ThisExpression" &&
        memberExpr.property.type === "Identifier") {
      return (memberExpr.property as TSESTree.Identifier).name;
    }
  }

  return null;
}

function extractSlonikArrayType(expression: TSESTree.Expression): string | null {
  if (expression.type !== "CallExpression") {
    return null;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return null;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" || 
      (memberExpr.property as TSESTree.Identifier).name !== "array") {
    return null;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  if (objectName !== "sql") {
    return null;
  }

  const typeArg = callExpr.arguments[1];
  if (!typeArg) {
    return null;
  }

  if (typeArg.type === "Literal") {
    const literal = typeArg as TSESTree.Literal;
    if (typeof literal.value === "string") {
      return `${literal.value}[]`;
    }
  }

  return null;
}

// Helper to create mock AST nodes for testing
function createMockCallExpression(
  objectName: string,
  propertyName: string,
  typeHint?: string
): TSESTree.CallExpression {
  const args: TSESTree.CallExpressionArgument[] = [
    { type: "ArrayExpression", elements: [], range: [0, 0], loc: {} as any } as unknown as TSESTree.ArrayExpression,
  ];

  if (typeHint !== undefined) {
    args.push({
      type: "Literal",
      value: typeHint,
      raw: `'${typeHint}'`,
      range: [0, 0],
      loc: {} as any,
    } as TSESTree.Literal);
  }

  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: propertyName,
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: args,
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.array() Type Extraction", () => {
  describe("extractSlonikArrayType", () => {
    it("should extract type from sql.array() with int4 type hint", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(extractSlonikArrayType(expr)).toBe("int4[]");
    });

    it("should extract type from sql.array() with text type hint", () => {
      const expr = createMockCallExpression("sql", "array", "text");
      expect(extractSlonikArrayType(expr)).toBe("text[]");
    });

    it("should extract type from sql.array() with uuid type hint", () => {
      const expr = createMockCallExpression("sql", "array", "uuid");
      expect(extractSlonikArrayType(expr)).toBe("uuid[]");
    });

    it("should return null for sql.array() without type hint", () => {
      const expr = createMockCallExpression("sql", "array");
      expect(extractSlonikArrayType(expr)).toBe(null);
    });

    it("should return null for other sql methods", () => {
      const expr = createMockCallExpression("sql", "fragment", "int4");
      expect(extractSlonikArrayType(expr)).toBe(null);
    });

    it("should return null for non-sql objects", () => {
      const expr = createMockCallExpression("other", "array", "int4");
      expect(extractSlonikArrayType(expr)).toBe(null);
    });

    it("should return null for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(extractSlonikArrayType(expr)).toBe(null);
    });

    it("should handle various PostgreSQL array types", () => {
      const types = ["int4", "int8", "text", "varchar", "bool", "timestamptz", "jsonb"];
      for (const type of types) {
        const expr = createMockCallExpression("sql", "array", type);
        expect(extractSlonikArrayType(expr)).toBe(`${type}[]`);
      }
    });
  });
});

// Re-create the sql.unnest extraction logic for testing
function extractSlonikUnnestTypes(expression: TSESTree.Expression): string[] | null {
  if (expression.type !== "CallExpression") {
    return null;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return null;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" || 
      (memberExpr.property as TSESTree.Identifier).name !== "unnest") {
    return null;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  if (objectName !== "sql") {
    return null;
  }

  const typeArg = callExpr.arguments[1];
  if (!typeArg) {
    return null;
  }

  if (typeArg.type === "ArrayExpression") {
    const arrayExpr = typeArg as TSESTree.ArrayExpression;
    const types: string[] = [];
    for (const element of arrayExpr.elements) {
      if (element && element.type === "Literal") {
        const literal = element as TSESTree.Literal;
        if (typeof literal.value === "string") {
          types.push(`${literal.value}[]`);
        } else {
          return null;
        }
      } else {
        return null;
      }
    }
    return types.length > 0 ? types : null;
  }

  return null;
}

// Helper to create mock sql.unnest() call expressions
function createMockUnnestCallExpression(
  objectName: string,
  typeHints?: string[]
): TSESTree.CallExpression {
  const args: TSESTree.CallExpressionArgument[] = [
    { type: "ArrayExpression", elements: [], range: [0, 0], loc: {} as any } as unknown as TSESTree.ArrayExpression,
  ];

  if (typeHints !== undefined) {
    const elements = typeHints.map((hint) => ({
      type: "Literal" as const,
      value: hint,
      raw: `'${hint}'`,
      range: [0, 0] as [number, number],
      loc: {} as any,
    })) as TSESTree.Literal[];

    args.push({
      type: "ArrayExpression",
      elements: elements,
      range: [0, 0],
      loc: {} as any,
    } as TSESTree.ArrayExpression);
  }

  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "unnest",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: args,
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.unnest() Type Extraction", () => {
  describe("extractSlonikUnnestTypes", () => {
    it("should extract types from sql.unnest() with single column", () => {
      const expr = createMockUnnestCallExpression("sql", ["int4"]);
      expect(extractSlonikUnnestTypes(expr)).toEqual(["int4[]"]);
    });

    it("should extract types from sql.unnest() with two columns", () => {
      const expr = createMockUnnestCallExpression("sql", ["int4", "text"]);
      expect(extractSlonikUnnestTypes(expr)).toEqual(["int4[]", "text[]"]);
    });

    it("should extract types from sql.unnest() with multiple columns", () => {
      const expr = createMockUnnestCallExpression("sql", ["int4", "text", "bool", "timestamptz"]);
      expect(extractSlonikUnnestTypes(expr)).toEqual(["int4[]", "text[]", "bool[]", "timestamptz[]"]);
    });

    it("should return null for sql.unnest() without type hints", () => {
      const expr = createMockUnnestCallExpression("sql");
      expect(extractSlonikUnnestTypes(expr)).toBe(null);
    });

    it("should return null for other sql methods", () => {
      // Create a sql.array call to test
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(extractSlonikUnnestTypes(expr)).toBe(null);
    });

    it("should return null for non-sql objects", () => {
      const expr = createMockUnnestCallExpression("other", ["int4", "text"]);
      expect(extractSlonikUnnestTypes(expr)).toBe(null);
    });

    it("should return null for empty type hints array", () => {
      const expr = createMockUnnestCallExpression("sql", []);
      expect(extractSlonikUnnestTypes(expr)).toBe(null);
    });

    it("should handle common Slonik unnest patterns", () => {
      // Pattern: sql.unnest(rows, ['int4', 'text', 'bool'])
      const expr = createMockUnnestCallExpression("sql", ["int4", "text", "bool"]);
      const types = extractSlonikUnnestTypes(expr);
      expect(types).toEqual(["int4[]", "text[]", "bool[]"]);
    });
  });
});

// Re-create the sql.fragment extraction logic for testing
interface SlonikFragmentResult {
  sqlText: string;
  expressions: TSESTree.Expression[];
}

function extractSlonikFragment(expression: TSESTree.Expression): SlonikFragmentResult | null {
  if (expression.type !== "TaggedTemplateExpression") {
    return null;
  }

  const taggedExpr = expression as TSESTree.TaggedTemplateExpression;
  const tag = taggedExpr.tag;

  if (tag.type !== "MemberExpression") {
    return null;
  }

  const memberExpr = tag as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" || 
      (memberExpr.property as TSESTree.Identifier).name !== "fragment") {
    return null;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  if (objectName !== "sql") {
    return null;
  }

  const quasi = taggedExpr.quasi;
  let sqlText = "";
  const nestedExpressions: TSESTree.Expression[] = [];

  for (const [i, templateElement] of quasi.quasis.entries()) {
    sqlText += (templateElement as TSESTree.TemplateElement).value.raw;

    if (!(templateElement as TSESTree.TemplateElement).tail && quasi.expressions[i]) {
      nestedExpressions.push(quasi.expressions[i] as TSESTree.Expression);
      sqlText += `\${__FRAGMENT_EXPR_${nestedExpressions.length - 1}__}`;
    }
  }

  return { sqlText, expressions: nestedExpressions };
}

// Helper to create mock sql.fragment tagged template expressions
function createMockFragmentExpression(
  objectName: string,
  quasis: string[],
  expressions?: TSESTree.Expression[]
): TSESTree.TaggedTemplateExpression {
  const quasiElements = quasis.map((raw, i) => ({
    type: "TemplateElement" as const,
    value: { raw, cooked: raw },
    tail: i === quasis.length - 1,
    range: [0, 0] as [number, number],
    loc: {} as any,
  }));

  return {
    type: "TaggedTemplateExpression",
    tag: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "fragment",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    quasi: {
      type: "TemplateLiteral",
      quasis: quasiElements,
      expressions: expressions || [],
      range: [0, 0],
      loc: {} as any,
    },
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.TaggedTemplateExpression;
}

describe("Slonik sql.fragment Extraction", () => {
  describe("extractSlonikFragment", () => {
    it("should extract static SQL from sql.fragment", () => {
      const expr = createMockFragmentExpression("sql", ["WHERE active = true"]);
      const result = extractSlonikFragment(expr);
      expect(result).not.toBeNull();
      expect(result!.sqlText).toBe("WHERE active = true");
      expect(result!.expressions).toHaveLength(0);
    });

    it("should extract SQL with single expression placeholder", () => {
      const mockExpr = {
        type: "Identifier",
        name: "id",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      const expr = createMockFragmentExpression("sql", ["WHERE id = ", ""], [mockExpr]);
      const result = extractSlonikFragment(expr);
      expect(result).not.toBeNull();
      expect(result!.sqlText).toBe("WHERE id = ${__FRAGMENT_EXPR_0__}");
      expect(result!.expressions).toHaveLength(1);
    });

    it("should extract SQL with multiple expression placeholders", () => {
      const mockExpr1 = {
        type: "Identifier",
        name: "id",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      const mockExpr2 = {
        type: "Identifier",
        name: "name",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      const expr = createMockFragmentExpression(
        "sql",
        ["WHERE id = ", " AND name = ", ""],
        [mockExpr1, mockExpr2]
      );
      const result = extractSlonikFragment(expr);
      expect(result).not.toBeNull();
      expect(result!.sqlText).toBe("WHERE id = ${__FRAGMENT_EXPR_0__} AND name = ${__FRAGMENT_EXPR_1__}");
      expect(result!.expressions).toHaveLength(2);
    });

    it("should return null for non-sql objects", () => {
      const expr = createMockFragmentExpression("other", ["WHERE active = true"]);
      expect(extractSlonikFragment(expr)).toBeNull();
    });

    it("should return null for other sql methods (not fragment)", () => {
      // Create a sql.array call to test
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(extractSlonikFragment(expr)).toBeNull();
    });

    it("should return null for non-tagged-template expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(extractSlonikFragment(expr)).toBeNull();
    });

    it("should handle complex SQL fragments", () => {
      const expr = createMockFragmentExpression("sql", [
        "LEFT JOIN users u ON u.id = orders.user_id WHERE u.active = true"
      ]);
      const result = extractSlonikFragment(expr);
      expect(result).not.toBeNull();
      expect(result!.sqlText).toBe("LEFT JOIN users u ON u.id = orders.user_id WHERE u.active = true");
    });

    it("should handle fragments with ORDER BY clauses", () => {
      const mockExpr = {
        type: "Identifier",
        name: "column",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      const expr = createMockFragmentExpression("sql", ["ORDER BY ", " DESC"], [mockExpr]);
      const result = extractSlonikFragment(expr);
      expect(result).not.toBeNull();
      expect(result!.sqlText).toBe("ORDER BY ${__FRAGMENT_EXPR_0__} DESC");
    });
  });
});

// Re-create the sql.identifier extraction logic for testing
function extractSlonikIdentifier(expression: TSESTree.Expression): string | null {
  if (expression.type !== "CallExpression") {
    return null;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return null;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "identifier") {
    return null;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  if (objectName !== "sql") {
    return null;
  }

  const partsArg = callExpr.arguments[0];
  if (!partsArg) {
    return null;
  }

  if (partsArg.type === "ArrayExpression") {
    const arrayExpr = partsArg as TSESTree.ArrayExpression;
    const parts: string[] = [];
    for (const element of arrayExpr.elements) {
      if (element && element.type === "Literal") {
        const literal = element as TSESTree.Literal;
        if (typeof literal.value === "string") {
          parts.push(literal.value);
        } else {
          return null;
        }
      } else {
        return null;
      }
    }
    
    if (parts.length === 0) {
      return null;
    }
    
    return parts.map(part => `"${part}"`).join(".");
  }

  return null;
}

// Helper to create mock sql.identifier() call expressions
function createMockIdentifierCallExpression(
  objectName: string,
  identifierParts?: string[]
): TSESTree.CallExpression {
  const args: TSESTree.CallExpressionArgument[] = [];

  if (identifierParts !== undefined) {
    args.push({
      type: "ArrayExpression",
      elements: identifierParts.map(part => ({
        type: "Literal",
        value: part,
        raw: `'${part}'`,
        range: [0, 0] as [number, number],
        loc: {} as any,
      } as TSESTree.Literal)),
      range: [0, 0],
      loc: {} as any,
    } as TSESTree.ArrayExpression);
  }

  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      } as TSESTree.Identifier,
      property: {
        type: "Identifier",
        name: "identifier",
        range: [0, 0],
        loc: {} as any,
      } as TSESTree.Identifier,
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    } as TSESTree.MemberExpression,
    arguments: args,
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as TSESTree.CallExpression;
}

describe("Slonik sql.identifier Extraction", () => {
  describe("extractSlonikIdentifier", () => {
    it("should extract single-part identifier", () => {
      const expr = createMockIdentifierCallExpression("sql", ["column"]);
      expect(extractSlonikIdentifier(expr)).toBe('"column"');
    });

    it("should extract two-part identifier (schema.table)", () => {
      const expr = createMockIdentifierCallExpression("sql", ["schema", "table"]);
      expect(extractSlonikIdentifier(expr)).toBe('"schema"."table"');
    });

    it("should extract three-part identifier (schema.table.column)", () => {
      const expr = createMockIdentifierCallExpression("sql", ["public", "users", "id"]);
      expect(extractSlonikIdentifier(expr)).toBe('"public"."users"."id"');
    });

    it("should return null for non-sql objects", () => {
      const expr = createMockIdentifierCallExpression("other", ["column"]);
      expect(extractSlonikIdentifier(expr)).toBeNull();
    });

    it("should return null for sql.identifier() without arguments", () => {
      const expr = createMockIdentifierCallExpression("sql");
      expect(extractSlonikIdentifier(expr)).toBeNull();
    });

    it("should return null for empty identifier array", () => {
      const expr = createMockIdentifierCallExpression("sql", []);
      expect(extractSlonikIdentifier(expr)).toBeNull();
    });

    it("should return null for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(extractSlonikIdentifier(expr)).toBeNull();
    });

    it("should return null for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(extractSlonikIdentifier(expr)).toBeNull();
    });
  });
});

// Re-create the sql.join detection logic for testing
function isSlonikJoinCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "join") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.join() call expressions
function createMockJoinCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "join",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.join Detection", () => {
  describe("isSlonikJoinCall", () => {
    it("should detect sql.join() calls", () => {
      const expr = createMockJoinCallExpression("sql");
      expect(isSlonikJoinCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockJoinCallExpression("other");
      expect(isSlonikJoinCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikJoinCall(expr)).toBe(false);
    });

    it("should return false for sql.identifier()", () => {
      const expr = createMockIdentifierCallExpression("sql", ["column"]);
      expect(isSlonikJoinCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikJoinCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "join",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikJoinCall(expr)).toBe(false);
    });
  });
});

// Re-create the sql.date detection logic for testing
function isSlonikDateCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "date") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.date() call expressions
function createMockDateCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "date",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "NewExpression",
        callee: {
          type: "Identifier",
          name: "Date",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.NewExpression,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.date Detection", () => {
  describe("isSlonikDateCall", () => {
    it("should detect sql.date() calls", () => {
      const expr = createMockDateCallExpression("sql");
      expect(isSlonikDateCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockDateCallExpression("other");
      expect(isSlonikDateCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikDateCall(expr)).toBe(false);
    });

    it("should return false for sql.identifier()", () => {
      const expr = createMockIdentifierCallExpression("sql", ["column"]);
      expect(isSlonikDateCall(expr)).toBe(false);
    });

    it("should return false for sql.join()", () => {
      const expr = createMockJoinCallExpression("sql");
      expect(isSlonikDateCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikDateCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "date",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikDateCall(expr)).toBe(false);
    });
  });
});

// Re-create the sql.timestamp detection logic for testing
function isSlonikTimestampCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "timestamp") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.timestamp() call expressions
function createMockTimestampCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "timestamp",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "NewExpression",
        callee: {
          type: "Identifier",
          name: "Date",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.NewExpression,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.timestamp Detection", () => {
  describe("isSlonikTimestampCall", () => {
    it("should detect sql.timestamp() calls", () => {
      const expr = createMockTimestampCallExpression("sql");
      expect(isSlonikTimestampCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockTimestampCallExpression("other");
      expect(isSlonikTimestampCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikTimestampCall(expr)).toBe(false);
    });

    it("should return false for sql.date()", () => {
      const expr = createMockDateCallExpression("sql");
      expect(isSlonikTimestampCall(expr)).toBe(false);
    });

    it("should return false for sql.join()", () => {
      const expr = createMockJoinCallExpression("sql");
      expect(isSlonikTimestampCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikTimestampCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "timestamp",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikTimestampCall(expr)).toBe(false);
    });
  });
});

// Re-create the sql.interval detection logic for testing
function isSlonikIntervalCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "interval") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.interval() call expressions
function createMockIntervalCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "interval",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "ObjectExpression",
        properties: [],
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.ObjectExpression,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.interval Detection", () => {
  describe("isSlonikIntervalCall", () => {
    it("should detect sql.interval() calls", () => {
      const expr = createMockIntervalCallExpression("sql");
      expect(isSlonikIntervalCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockIntervalCallExpression("other");
      expect(isSlonikIntervalCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikIntervalCall(expr)).toBe(false);
    });

    it("should return false for sql.date()", () => {
      const expr = createMockDateCallExpression("sql");
      expect(isSlonikIntervalCall(expr)).toBe(false);
    });

    it("should return false for sql.timestamp()", () => {
      const expr = createMockTimestampCallExpression("sql");
      expect(isSlonikIntervalCall(expr)).toBe(false);
    });

    it("should return false for sql.join()", () => {
      const expr = createMockJoinCallExpression("sql");
      expect(isSlonikIntervalCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikIntervalCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "interval",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikIntervalCall(expr)).toBe(false);
    });
  });
});

// Re-create the sql.json detection logic for testing
function isSlonikJsonCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "json") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Re-create the sql.jsonb detection logic for testing
function isSlonikJsonbCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "jsonb") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.json() call expressions
function createMockJsonCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "json",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "ObjectExpression",
        properties: [],
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.ObjectExpression,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

// Helper to create mock sql.jsonb() call expressions
function createMockJsonbCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "jsonb",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "ObjectExpression",
        properties: [],
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.ObjectExpression,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.json Detection", () => {
  describe("isSlonikJsonCall", () => {
    it("should detect sql.json() calls", () => {
      const expr = createMockJsonCallExpression("sql");
      expect(isSlonikJsonCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockJsonCallExpression("other");
      expect(isSlonikJsonCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikJsonCall(expr)).toBe(false);
    });

    it("should return false for sql.jsonb()", () => {
      const expr = createMockJsonbCallExpression("sql");
      expect(isSlonikJsonCall(expr)).toBe(false);
    });

    it("should return false for sql.date()", () => {
      const expr = createMockDateCallExpression("sql");
      expect(isSlonikJsonCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikJsonCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "json",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikJsonCall(expr)).toBe(false);
    });
  });
});

describe("Slonik sql.jsonb Detection", () => {
  describe("isSlonikJsonbCall", () => {
    it("should detect sql.jsonb() calls", () => {
      const expr = createMockJsonbCallExpression("sql");
      expect(isSlonikJsonbCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockJsonbCallExpression("other");
      expect(isSlonikJsonbCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikJsonbCall(expr)).toBe(false);
    });

    it("should return false for sql.json()", () => {
      const expr = createMockJsonCallExpression("sql");
      expect(isSlonikJsonbCall(expr)).toBe(false);
    });

    it("should return false for sql.date()", () => {
      const expr = createMockDateCallExpression("sql");
      expect(isSlonikJsonbCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikJsonbCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "jsonb",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikJsonbCall(expr)).toBe(false);
    });
  });
});

// Re-create the sql.literalValue detection logic for testing
function isSlonikLiteralValueCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "literalValue") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.literalValue() call expressions
function createMockLiteralValueCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "literalValue",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "Literal",
        value: "test",
        raw: "'test'",
        range: [0, 0],
        loc: {} as any,
      } as TSESTree.Literal,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.literalValue Detection", () => {
  describe("isSlonikLiteralValueCall", () => {
    it("should detect sql.literalValue() calls", () => {
      const expr = createMockLiteralValueCallExpression("sql");
      expect(isSlonikLiteralValueCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockLiteralValueCallExpression("other");
      expect(isSlonikLiteralValueCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikLiteralValueCall(expr)).toBe(false);
    });

    it("should return false for sql.json()", () => {
      const expr = createMockJsonCallExpression("sql");
      expect(isSlonikLiteralValueCall(expr)).toBe(false);
    });

    it("should return false for sql.jsonb()", () => {
      const expr = createMockJsonbCallExpression("sql");
      expect(isSlonikLiteralValueCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikLiteralValueCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "literalValue",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikLiteralValueCall(expr)).toBe(false);
    });
  });
});

// Re-create the sql.uuid detection logic for testing
function isSlonikUuidCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "uuid") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.uuid() call expressions
function createMockUuidCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "uuid",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "Literal",
        value: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        raw: "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'",
        range: [0, 0],
        loc: {} as any,
      } as TSESTree.Literal,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.uuid Detection", () => {
  describe("isSlonikUuidCall", () => {
    it("should detect sql.uuid() calls", () => {
      const expr = createMockUuidCallExpression("sql");
      expect(isSlonikUuidCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockUuidCallExpression("other");
      expect(isSlonikUuidCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikUuidCall(expr)).toBe(false);
    });

    it("should return false for sql.literalValue()", () => {
      const expr = createMockLiteralValueCallExpression("sql");
      expect(isSlonikUuidCall(expr)).toBe(false);
    });

    it("should return false for sql.json()", () => {
      const expr = createMockJsonCallExpression("sql");
      expect(isSlonikUuidCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikUuidCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "uuid",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikUuidCall(expr)).toBe(false);
    });
  });
});

// Re-create the sql.binary detection logic for testing
function isSlonikBinaryCall(expression: TSESTree.Expression): boolean {
  if (expression.type !== "CallExpression") {
    return false;
  }

  const callExpr = expression as TSESTree.CallExpression;
  const callee = callExpr.callee;

  if (callee.type !== "MemberExpression") {
    return false;
  }

  const memberExpr = callee as TSESTree.MemberExpression;

  if (memberExpr.property.type !== "Identifier" ||
      (memberExpr.property as TSESTree.Identifier).name !== "binary") {
    return false;
  }

  const objectName = getMemberExpressionObjectName(memberExpr.object);
  return objectName === "sql";
}

// Helper to create mock sql.binary() call expressions
function createMockBinaryCallExpression(objectName: string): TSESTree.CallExpression {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: {
        type: "Identifier",
        name: objectName,
        range: [0, 0],
        loc: {} as any,
      },
      property: {
        type: "Identifier",
        name: "binary",
        range: [0, 0],
        loc: {} as any,
      },
      computed: false,
      optional: false,
      range: [0, 0],
      loc: {} as any,
    },
    arguments: [
      {
        type: "Identifier",
        name: "buffer",
        range: [0, 0],
        loc: {} as any,
      } as TSESTree.Identifier,
    ],
    optional: false,
    range: [0, 0],
    loc: {} as any,
  } as unknown as TSESTree.CallExpression;
}

describe("Slonik sql.binary Detection", () => {
  describe("isSlonikBinaryCall", () => {
    it("should detect sql.binary() calls", () => {
      const expr = createMockBinaryCallExpression("sql");
      expect(isSlonikBinaryCall(expr)).toBe(true);
    });

    it("should return false for non-sql objects", () => {
      const expr = createMockBinaryCallExpression("other");
      expect(isSlonikBinaryCall(expr)).toBe(false);
    });

    it("should return false for other sql methods", () => {
      const expr = createMockCallExpression("sql", "array", "int4");
      expect(isSlonikBinaryCall(expr)).toBe(false);
    });

    it("should return false for sql.uuid()", () => {
      const expr = createMockUuidCallExpression("sql");
      expect(isSlonikBinaryCall(expr)).toBe(false);
    });

    it("should return false for sql.json()", () => {
      const expr = createMockJsonCallExpression("sql");
      expect(isSlonikBinaryCall(expr)).toBe(false);
    });

    it("should return false for non-call expressions", () => {
      const expr = {
        type: "Identifier",
        name: "foo",
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.Identifier;
      expect(isSlonikBinaryCall(expr)).toBe(false);
    });

    it("should return false for non-member-expression callees", () => {
      const expr = {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "binary",
          range: [0, 0],
          loc: {} as any,
        },
        arguments: [],
        optional: false,
        range: [0, 0],
        loc: {} as any,
      } as unknown as TSESTree.CallExpression;
      expect(isSlonikBinaryCall(expr)).toBe(false);
    });
  });
});
