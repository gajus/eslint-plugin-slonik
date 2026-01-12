import postgres, { Sql } from "postgres";
import { match } from "ts-pattern";
import { RuleOptionConnection } from "../rules/RuleOptions";
import {
  ConnectionPayload,
  getConnectionStrategyByRuleOptionConnection,
} from "../rules/check-sql.utils";
import { O, pipe } from "./fp-ts";
import { mapConnectionOptionsToString, parseConnection } from "./pg.utils";

export function createConnectionManager() {
   
  const connectionMap: Map<string, Sql<any>> = new Map();

  return {
     
    getOrCreate: (databaseUrl: string, options?: postgres.Options<any>) =>
      getOrCreateConnection(databaseUrl, connectionMap, options),
    close: (params: CloseConnectionParams) => closeConnection(params, connectionMap),
  };
}

function getOrCreateConnection(
  databaseUrl: string,
   
  connectionMap: Map<string, Sql<any>>,
   
  options?: postgres.Options<any>,
): ConnectionPayload {
  return pipe(
    O.fromNullable(connectionMap.get(databaseUrl)),
    O.foldW(
      () => {
        const sql = postgres(databaseUrl, options);
        connectionMap.set(databaseUrl, sql);
        return { sql, databaseUrl, isFirst: true };
      },
      (sql) => ({ sql, databaseUrl, isFirst: false }),
    ),
  );
}

export interface CloseConnectionParams {
  connection: RuleOptionConnection;
  projectDir: string;
}

 
function closeConnection(params: CloseConnectionParams, connectionMap: Map<string, Sql<any>>) {
  const { connection, projectDir } = params;
  const strategy = getConnectionStrategyByRuleOptionConnection({ connection, projectDir });

  match(strategy)
    .with({ type: "databaseUrl" }, ({ databaseUrl }) => {
      const sql = connectionMap.get(databaseUrl);
      if (sql) {
        sql.end();
        connectionMap.delete(databaseUrl);
      }
    })
    .with({ type: "migrations" }, ({ connectionUrl, databaseName }) => {
      const connectionOptions = { ...parseConnection(connectionUrl), database: databaseName };
      const databaseUrl = mapConnectionOptionsToString(connectionOptions);
      const sql = connectionMap.get(databaseUrl);
      const migrationSql = connectionMap.get(connectionUrl);
      if (sql) {
        sql.end();
        connectionMap.delete(databaseUrl);
      }
      if (migrationSql) {
        migrationSql.end();
        connectionMap.delete(connectionUrl);
      }
    })
    .exhaustive();
}
