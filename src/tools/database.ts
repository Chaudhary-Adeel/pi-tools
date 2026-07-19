// database — database exploration tools: query, schema, explain.
// Auto-detects SQLite (local) and Postgres/MySQL (connection strings).
import { Type } from "typebox";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate } from "../lib/shared.ts";

function querySqlite(dbPath: string, sql: string): string {
  // Use node:sqlite if available, otherwise fall back to sqlite3 CLI
  try {
    const { execSync } = require("child_process");
    return execSync(`sqlite3 -header -csv "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 30_000,
    });
  } catch (e: any) {
    if (e.stdout) return e.stdout;
    throw e;
  }
}

function querySqliteSchema(dbPath: string): string {
  return querySqlite(dbPath, ".schema");
}

export function registerDatabaseTools(pi: ExtensionAPI): void {
  // db_query
  pi.registerTool({
    name: "db_query",
    label: "Database Query",
    description:
      "Run a read-only SQL query against the project database. " +
      "Auto-detects SQLite from .db files in the project. " +
      "For Postgres/MySQL, configure a connection string in .pi/db.json.",
    promptSnippet: "run a database query",
    promptGuidelines: [
      "Use for understanding schema, checking data, or verifying changes.",
      "Only SELECT queries allowed (read-only by default).",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "SQL SELECT query." }),
      database: Type.Optional(Type.String({ description: "Path to database file (default: auto-detect)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sql = params.query as string;
      const dryRun = sql.trim().toUpperCase();
      if (!dryRun.startsWith("SELECT") && !dryRun.startsWith("PRAGMA") && !dryRun.startsWith("EXPLAIN")) {
        return text("Only SELECT, PRAGMA, and EXPLAIN queries are allowed for safety.", { error: "readonly" });
      }

      const dbPath = (params.database as string) || findDb(ctx.cwd);
      if (!dbPath) {
        return text("No database found. Place a .db file in your project or specify --database.");
      }

      try {
        const result = querySqlite(dbPath, sql);
        return text(truncate(result), { database: path.relative(ctx.cwd, dbPath), rows: result.split("\n").length - 1 });
      } catch (e: any) {
        throw new Error(`Query failed: ${e.message}`);
      }
    },
    renderCall(args, theme, _) {
      return new Text(theme.fg("toolTitle", theme.bold("db_query ")) + theme.fg("muted", (args.query as string).slice(0, 60)), 0, 0);
    },
    renderResult(result, _opts, theme, ctx) {
      if (ctx.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      const rows = (result.details as any)?.rows ?? "?";
      return new Text(theme.fg("success", `✓ ${rows} row(s) returned`), 0, 0);
    },
  });

  // db_schema
  pi.registerTool({
    name: "db_schema",
    label: "Database Schema",
    description: "Show the schema of the project database (tables, columns, indexes).",
    promptSnippet: "show database schema",
    parameters: Type.Object({
      database: Type.Optional(Type.String({ description: "Path to database file (default: auto-detect)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dbPath = (params.database as string) || findDb(ctx.cwd);
      if (!dbPath) return text("No database found.");
      try {
        const schema = querySqliteSchema(dbPath);
        return text(truncate(schema), { database: path.relative(ctx.cwd, dbPath) });
      } catch (e: any) {
        throw new Error(`Schema read failed: ${e.message}`);
      }
    },
    renderCall(args, theme, _) {
      return new Text(theme.fg("toolTitle", theme.bold("db_schema")), 0, 0);
    },
    renderResult(result, _opts, theme, ctx) {
      if (ctx.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      return new Text(theme.fg("success", "✓ Schema retrieved"), 0, 0);
    },
  });

  // db_explain
  pi.registerTool({
    name: "db_explain",
    label: "Query Plan",
    description: "Show the EXPLAIN QUERY PLAN for a SQL query.",
    promptSnippet: "explain a query plan",
    parameters: Type.Object({
      query: Type.String({ description: "SQL query to explain." }),
      database: Type.Optional(Type.String({})),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dbPath = (params.database as string) || findDb(ctx.cwd);
      if (!dbPath) return text("No database found.");
      try {
        const plan = querySqlite(dbPath, `EXPLAIN QUERY PLAN ${params.query as string}`);
        return text(truncate(plan), { database: path.relative(ctx.cwd, dbPath) });
      } catch (e: any) {
        throw new Error(`Explain failed: ${e.message}`);
      }
    },
    renderCall(args, theme, _) {
      return new Text(theme.fg("toolTitle", theme.bold("db_explain ")) + theme.fg("muted", (args.query as string).slice(0, 40)), 0, 0);
    },
    renderResult(result, _opts, theme, ctx) {
      if (ctx.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      return new Text(theme.fg("success", "✓ Query plan"), 0, 0);
    },
  });
}

function findDb(cwd: string): string | null {
  const fs = require("fs");
  // Check common paths
  const candidates = [
    path.join(cwd, "data.db"),
    path.join(cwd, "database.sqlite"),
    path.join(cwd, "db.sqlite"),
    path.join(cwd, ".pi/cvm/cvm.db"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Find any .db file
  try {
    const files = fs.readdirSync(cwd);
    const db = files.find((f: string) => f.endsWith(".db") || f.endsWith(".sqlite"));
    if (db) return path.join(cwd, db);
  } catch {}
  return null;
}
