# eslint-plugin-slonik

Provides compile-time SQL query validation by checking your raw SQL strings against your actual database schema, catching errors before runtime.

This is a fork of [@ts-safeql/eslint-plugin](https://github.com/ts-safeql/safeql) with native support for Slonik's SQL tag builders (`sql.array`, `sql.fragment`, `sql.identifier`, `sql.unnest`, etc.).

## Features

- 🔍 **SQL Validation** — Validates SQL queries against your PostgreSQL database schema at lint time
- 🏷️ **Slonik SQL Tags** — Native support for all Slonik SQL tag builders
- 🎯 **Type Inference** — Extracts type hints from `sql.array()`, `sql.unnest()`, and `sql.identifier()`
- 📝 **Fragment Support** — Properly handles `sql.fragment` for dynamic query composition
- ✨ **Graceful Degradation** — Skips validation for runtime-dependent constructs like `sql.join()`

## Installation

```bash
npm install eslint-plugin-slonik --save-dev
# or
pnpm add eslint-plugin-slonik --save-dev
# or
yarn add eslint-plugin-slonik --dev
```

### Peer Dependencies

```bash
npm install libpg-query --save-dev
```

## Configuration

### ESLint Flat Config (eslint.config.js)

```js
import { slonik } from "eslint-plugin-slonik";

export default [
  // ... other configs
  slonik.configs.connections({
    databaseUrl: process.env.DATABASE_URL,
    overrides: {
      types: {
        // Map PostgreSQL types to Slonik token types
        date: 'DateSqlToken',
        timestamp: 'TimestampSqlToken',
        interval: 'IntervalSqlToken',
        json: 'JsonSqlToken',
        jsonb: 'JsonBinarySqlToken',
        uuid: 'UuidSqlToken',
        'int4[]': 'ArraySqlToken<"int4">',
        'text[]': 'ArraySqlToken<"text">',
        'uuid[]': 'ArraySqlToken<"uuid">',
        'numeric[]': 'ArraySqlToken<"numeric">',
        'real[]': 'VectorSqlToken',
      },
    },
    targets: [
      {
        // Match Slonik's typed query methods
        tag: 'sql.+(type\\(*\\)|typeAlias\\(*\\)|unsafe)',
      },
    ],
  }),
];
```

## Slonik SQL Tag Support

| SQL Tag | Support | Behavior |
|---------|---------|----------|
| `sql.array([1,2], 'int4')` | ✅ Full | Extracts type → `$1::int4[]` |
| `` sql.array([1,2], sql.fragment`int[]`) `` | ✅ Graceful | Falls back to `$1` |
| `sql.unnest([[...]], ['int4','text'])` | ✅ Full | Extracts types → `unnest($1::int4[], $2::text[])` |
| `sql.identifier(['schema','table'])` | ✅ Full | Embeds → `"schema"."table"` |
| `` sql.fragment`...` `` | ✅ Full | Embeds SQL content directly |
| `sql.date(date)` | ✅ Full | Extracts type → `$1::date` |
| `sql.timestamp(date)` | ✅ Full | Extracts type → `$1::timestamptz` |
| `sql.interval({...})` | ✅ Full | Extracts type → `$1::interval` |
| `sql.json(value)` | ✅ Full | Extracts type → `$1::json` |
| `sql.jsonb(value)` | ✅ Full | Extracts type → `$1::jsonb` |
| `sql.literalValue(value)` | ✅ Full | Embeds as literal → `''` |
| `sql.uuid(str)` | ✅ Full | Extracts type → `$1::uuid` |
| `sql.binary(buffer)` | ✅ Full | Extracts type → `$1::bytea` |
| `sql.join([...], glue)` | ✅ Skip | Skipped (runtime content) |

### How It Works

**Full Support** means the plugin extracts type information and generates accurate PostgreSQL placeholders for validation:

```ts
// sql.array with type hint
sql.type(z.object({ ids: z.array(z.number()) }))`
  SELECT * FROM users WHERE id = ANY(${sql.array(userIds, 'int4')})
`;
// → Validates: SELECT * FROM users WHERE id = ANY($1::int4[])

// sql.identifier for dynamic table/column names
sql.type(z.object({ id: z.number() }))`
  SELECT id FROM ${sql.identifier(['public', 'users'])}
`;
// → Validates: SELECT id FROM "public"."users"

// sql.fragment for query composition
const whereClause = sql.fragment`WHERE active = true`;
sql.type(z.object({ id: z.number() }))`
  SELECT id FROM users ${whereClause}
`;
// → Validates: SELECT id FROM users WHERE active = true

// sql.date for date values
sql.type(z.object({ id: z.number() }))`
  SELECT id FROM events WHERE event_date = ${sql.date(myDate)}
`;
// → Validates: SELECT id FROM events WHERE event_date = $1::date

// sql.timestamp for timestamp values
sql.type(z.object({ id: z.number() }))`
  SELECT id FROM events WHERE created_at = ${sql.timestamp(myTimestamp)}
`;
// → Validates: SELECT id FROM events WHERE created_at = $1::timestamptz

// sql.interval for interval values
sql.type(z.object({ id: z.number() }))`
  SELECT id FROM events WHERE created_at > NOW() - ${sql.interval({ days: 7 })}
`;
// → Validates: SELECT id FROM events WHERE created_at > NOW() - $1::interval

// sql.json and sql.jsonb for JSON values
sql.type(z.object({ id: z.number() }))`
  INSERT INTO settings (config) VALUES (${sql.jsonb({ theme: 'dark' })})
`;
// → Validates: INSERT INTO settings (config) VALUES ($1::jsonb)

// sql.literalValue for literal SQL values
sql.type(z.object({ result: z.string() }))`
  SELECT ${sql.literalValue('hello')} AS result
`;
// → Validates: SELECT '' AS result

// sql.uuid for UUID values
sql.type(z.object({ id: z.number() }))`
  SELECT id FROM users WHERE external_id = ${sql.uuid(externalId)}
`;
// → Validates: SELECT id FROM users WHERE external_id = $1::uuid

// sql.binary for binary data
sql.type(z.object({ id: z.number() }))`
  UPDATE files SET content = ${sql.binary(buffer)} WHERE id = ${id}
`;
// → Validates: UPDATE files SET content = $1::bytea WHERE id = $2
```

**Graceful Skip** means the plugin recognizes Slonik tokens and skips validation for those expressions, preventing false positives:

```ts
// sql.join - content determined at runtime
sql.unsafe`
  SELECT * FROM users WHERE ${sql.join([
    sql.fragment`name = ${name}`,
    sql.fragment`age > ${age}`,
  ], sql.fragment` AND `)}
`;
// → Plugin skips validation for the join expression
```

## Type Override Reference

When using Slonik, you'll want to map PostgreSQL types to Slonik's token types:

```ts
overrides: {
  types: {
    // Date/Time types
    date: 'DateSqlToken',
    timestamp: 'TimestampSqlToken',
    timestamptz: "TimestampSqlToken",
    interval: 'IntervalSqlToken',

    // JSON types
    json: 'JsonSqlToken',
    jsonb: 'JsonBinarySqlToken',

    // UUID
    uuid: "UuidSqlToken",

    // Array types (use ArraySqlToken<"element_type">)
    "int4[]": 'ArraySqlToken<"int4">',
    "int8[]": 'ArraySqlToken<"int8">',
    "text[]": 'ArraySqlToken<"text">',
    "uuid[]": 'ArraySqlToken<"uuid">',
    "numeric[]": 'ArraySqlToken<"numeric">',
    "bool[]": 'ArraySqlToken<"bool">',

    // Vector types (for pgvector)
    "real[]": "VectorSqlToken",
    vector: "VectorSqlToken",
  },
}
```

## Target Pattern Reference

The `tag` option uses regex to match Slonik's query methods:

```ts
targets: [
  {
    // Matches: sql.type(...)``, sql.typeAlias(...)``, sql.unsafe``
    tag: "sql.+(type\\(*\\)|typeAlias\\(*\\)|unsafe)",
  },
]
```

## Example Project Setup

### 1. Install dependencies

```bash
pnpm add slonik zod
pnpm add -D eslint-plugin-slonik libpg-query
```

### 2. Create your SQL tag with type aliases

```ts
// src/slonik.ts
import { createSqlTag } from "slonik";
import { z } from "zod";

export const sql = createSqlTag({
  typeAliases: {
    id: z.object({ id: z.number() }),
    void: z.object({}).strict(),
  },
});
```

### 3. Configure ESLint

```js
// eslint.config.js
import { slonik } from "eslint-plugin-slonik";
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  slonik.configs.connections({
    databaseUrl: process.env.DATABASE_URL,
    overrides: {
      types: {
        date: 'DateSqlToken',
        timestamp: 'TimestampSqlToken',
        json: 'JsonSqlToken',
        jsonb: 'JsonBinarySqlToken',
        uuid: 'UuidSqlToken',
        'int4[]': 'ArraySqlToken<"int4">',
        'text[]': 'ArraySqlToken<"text">',
      },
    },
    targets: [
      {
        tag: 'sql.+(type\\(*\\)|typeAlias\\(*\\)|unsafe)',
      },
    ],
  })
);
```

### 4. Write validated queries

```ts
import { pool, sql } from "./slonik";

// ✅ Valid - query matches schema
const users = await pool.many(
  sql.type(z.object({ id: z.number(), name: z.string() }))`
    SELECT id, name FROM users WHERE active = true
  `
);

// ✅ Valid - using sql.array with type hint
const usersByIds = await pool.many(
  sql.type(z.object({ id: z.number(), name: z.string() }))`
    SELECT id, name FROM users WHERE id = ANY(${sql.array(ids, 'int4')})
  `
);

// ✅ Valid - using sql.fragment for composition
const orderBy = sql.fragment`ORDER BY created_at DESC`;
const recentUsers = await pool.many(
  sql.type(z.object({ id: z.number(), name: z.string() }))`
    SELECT id, name FROM users ${orderBy}
  `
);

// ❌ Error - column 'naem' does not exist
const typo = await pool.many(
  sql.type(z.object({ id: z.number(), name: z.string() }))`
    SELECT id, naem FROM users
  `
);
```

## Disabling Validation for Specific Queries

You can disable `check-sql` validation for individual queries by adding a `@check-sql-disable` comment inside the SQL template literal:

### Block Comment Style

```ts
sql`/* @check-sql-disable */ SELECT * FROM ${sql.identifier([dynamicTable])}`
```

### Line Comment Style

```ts
sql`
  -- @check-sql-disable
  SELECT * FROM ${sql.identifier([dynamicTable])}
`
```

### When to Use

This is useful when you have:

1. **Dynamic SQL that cannot be validated statically** — Complex dynamic queries where even Slonik tokens aren't enough
2. **Queries with edge cases** — SQL syntax that the plugin doesn't support yet
3. **Intentional invalid SQL for testing** — When you need to test error handling
4. **Temporary workarounds** — While waiting for a plugin fix or improvement

```ts
// Example: Complex dynamic query that can't be validated
function buildDynamicReport(columns: string[], table: string) {
  return sql`
    /* @check-sql-disable */
    SELECT ${sql.join(columns.map(c => sql.identifier([c])), sql.fragment`, `)}
    FROM ${sql.identifier([table])}
  `;
}
```

> [!NOTE]
> The comment must be placed inside the template literal, not outside of it. ESLint's standard `eslint-disable` comments work on the JavaScript/TypeScript level, while `@check-sql-disable` works on the SQL level.

## Differences from @ts-safeql/eslint-plugin

This plugin is specifically designed for Slonik and includes:

1. **Native Slonik token recognition** — Recognizes all Slonik SQL token types (`ArraySqlToken`, `FragmentSqlToken`, etc.)
2. **Type hint extraction** — Extracts PostgreSQL types from `sql.array()` and `sql.unnest()` calls
3. **Fragment embedding** — Properly embeds `sql.fragment` content into the query for validation
4. **Identifier support** — Converts `sql.identifier()` to quoted identifiers
5. **Graceful degradation** — Skips validation for runtime-dependent constructs instead of erroring

## How It Works

ESLint rules must be synchronous, but SQL validation requires async operations like database connections. This plugin solves this using [`synckit`](https://github.com/un-ts/synckit), which enables synchronous calls to async worker threads.

The architecture:

1. **Worker Thread** — Runs all async operations (database connections, migrations, type generation) in a separate thread
2. **Synchronous Bridge** — Uses `synckit` to block the main thread until the worker completes, making async operations appear synchronous to ESLint
3. **Connection Pooling** — Reuses database connections across lint runs for performance

Under the hood, `synckit` uses Node.js Worker Threads with `Atomics.wait()` to block the main thread until the worker signals completion via `Atomics.notify()`.

## Development

### Prerequisites

- Node.js 24+
- pnpm 10+
- PostgreSQL 17

### Setup

```bash
# Install dependencies
pnpm install

# Start PostgreSQL (e.g., using Docker)
docker run -d --name postgres -p 5432:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  postgres:18
```

### Running Tests

```bash
# Run tests with DATABASE_URL
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm run test:vitest
```

### Linting

```bash
pnpm run lint:eslint    # ESLint
pnpm run lint:tsc       # TypeScript type checking
pnpm run lint:cspell    # Spell checking
pnpm run lint:knip      # Unused code detection
```

### Building

```bash
pnpm run build
```
