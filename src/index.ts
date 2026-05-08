#!/usr/bin/env node

/**
 * Oracle MCP Server — powered by sqlplus
 *
 * Connection string format:
 *   username/password@host:port/servicename
 *
 * Usage (Claude Desktop config):
 *   {
 *     "command": "npx",
 *     "args": ["-y", "oracle-sqlplus-mcp"],
 *     "env": {
 *       "ORACLE_CONNECTION": "scott/tiger@localhost:1521/ORCL"
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { promisify } from "util";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SqlPlusResult {
  success: boolean;
  output: string;
  error?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONNECTION_STRING = process.env.ORACLE_CONNECTION ?? "";
const SQLPLUS_PATH = process.env.SQLPLUS_PATH ?? "sqlplus";
const QUERY_TIMEOUT_MS = parseInt(process.env.QUERY_TIMEOUT_MS ?? "30000", 10);

if (!CONNECTION_STRING) {
  process.stderr.write(
    "[oracle-mcp] ERROR: ORACLE_CONNECTION env var is required.\n" +
    "  Format: username/password@host:port/servicename\n" +
    "  Example: scott/tiger@192.168.1.10:1521/ORCL\n"
  );
  process.exit(1);
}

// ─── sqlplus executor ────────────────────────────────────────────────────────

/**
 * Run an SQL statement via sqlplus and return cleaned output.
 * sqlplus is invoked with -S (silent) to suppress banners.
 */
async function runSqlPlus(sql: string): Promise<SqlPlusResult> {
  return new Promise((resolve) => {
    // Build the sqlplus script:
    //   SET PAGESIZE 200       — more rows per page
    //   SET LINESIZE 500       — wide lines (avoid wrapping)
    //   SET COLSEP ' | '      — column separator for readability
    //   SET FEEDBACK OFF       — suppress "N rows selected"
    //   SET HEADING ON         — keep column headers
    //   SET TRIMOUT ON         — trim trailing spaces
    //   SET WRAP OFF           — truncate instead of wrap
    const script = [
      "SET PAGESIZE 200",
      "SET LINESIZE 500",
      "SET COLSEP ' | '",
      "SET FEEDBACK OFF",
      "SET HEADING ON",
      "SET TRIMOUT ON",
      "SET WRAP OFF",
      "SET NULL '(null)'",
      "",
      sql.trim().endsWith(";") ? sql.trim() : sql.trim() + ";",
      "",
      "EXIT;",
    ].join("\n");

    const child = spawn(SQLPLUS_PATH, ["-S", CONNECTION_STRING], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    // Handle spawn errors (e.g. sqlplus not found)
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        resolve({
          success: false,
          output: "",
          error: `sqlplus not found at "${SQLPLUS_PATH}". Install Oracle Instant Client or set SQLPLUS_PATH env var.`,
        });
      } else {
        resolve({ success: false, output: "", error: err.message });
      }
    });

    // Timeout guard
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        success: false,
        output: "",
        error: `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s`,
      });
    }, QUERY_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);

      const out = stdout.trim();

      // Detect Oracle errors (ORA-XXXXX or SP2-XXXXX)
      const oraError = out.match(/(ORA-\d+|SP2-\d+)[^\n]*/);
      if (oraError) {
        resolve({ success: false, output: out, error: oraError[0] });
        return;
      }

      if (code !== 0 && stderr) {
        resolve({ success: false, output: out, error: stderr.trim() });
        return;
      }

      resolve({ success: true, output: out });
    });

    // Write the script to sqlplus stdin
    child.stdin.write(script);
    child.stdin.end();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wrap a raw Oracle SQL query (no trailing semicolon needed — runSqlPlus adds it) */
function formatQueryResult(result: SqlPlusResult, label: string): string {
  if (!result.success) {
    return `❌ Error in ${label}:\n${result.error ?? result.output}`;
  }
  if (!result.output) {
    return `✅ ${label} — No data returned.`;
  }
  return result.output;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "execute_query",
    description:
      "Execute a SQL SELECT query against the Oracle database and return the results. " +
      "Use standard Oracle SQL syntax. Do NOT include a trailing semicolon — it is added automatically.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SQL SELECT query to execute (without trailing semicolon)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "execute_ddl",
    description:
      "Execute a DDL or DML statement (CREATE, INSERT, UPDATE, DELETE, ALTER, DROP). " +
      "Use with caution — changes are committed immediately.",
    inputSchema: {
      type: "object",
      properties: {
        statement: {
          type: "string",
          description: "SQL DDL/DML statement (without trailing semicolon)",
        },
      },
      required: ["statement"],
    },
  },
  {
    name: "list_tables",
    description:
      "List all tables accessible to the current user, optionally filtered by schema/owner.",
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description:
            "Optional schema/owner name to filter tables (e.g. SCOTT). " +
            "Defaults to tables owned by the connected user.",
        },
        search: {
          type: "string",
          description: "Optional LIKE pattern to filter table names (e.g. EMP%)",
        },
      },
    },
  },
  {
    name: "describe_table",
    description: "Describe the columns, data types and constraints of a table.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Table name to describe (e.g. EMPLOYEES or SCOTT.EMPLOYEES)",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "list_schemas",
    description:
      "List all schemas (users/owners) in the database that have at least one table.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_table_sample",
    description: "Fetch a sample of rows from a table (default: 10 rows).",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Full table name (e.g. SCOTT.EMP or just EMP)",
        },
        limit: {
          type: "number",
          description: "Number of rows to fetch (default: 10, max: 100)",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "list_procedures",
    description: "List stored procedures and functions for a given schema.",
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Schema/owner name. Defaults to connected user.",
        },
      },
    },
  },
  {
    name: "test_connection",
    description: "Test the Oracle connection and return server version info.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    // ── execute_query ────────────────────────────────────────────────────────
    case "execute_query": {
      const query = args.query as string;
      if (!query?.trim()) return "❌ Query cannot be empty.";
      const result = await runSqlPlus(query);
      return formatQueryResult(result, "Query");
    }

    // ── execute_ddl ──────────────────────────────────────────────────────────
    case "execute_ddl": {
      const stmt = args.statement as string;
      if (!stmt?.trim()) return "❌ Statement cannot be empty.";
      // Append COMMIT for DML statements
      const needsCommit = /^\s*(INSERT|UPDATE|DELETE|MERGE)/i.test(stmt);
      const fullStmt = needsCommit ? `${stmt}\nCOMMIT` : stmt;
      const result = await runSqlPlus(fullStmt);
      return formatQueryResult(result, "Statement");
    }

    // ── list_tables ──────────────────────────────────────────────────────────
    case "list_tables": {
      const schema = (args.schema as string | undefined)?.toUpperCase();
      const search = (args.search as string | undefined)?.toUpperCase();

      let sql: string;
      if (schema) {
        sql = `SELECT TABLE_NAME, NUM_ROWS, LAST_ANALYZED FROM ALL_TABLES WHERE OWNER = '${schema}'`;
        if (search) sql += ` AND TABLE_NAME LIKE '${search}'`;
        sql += " ORDER BY TABLE_NAME";
      } else {
        sql = "SELECT TABLE_NAME, NUM_ROWS, LAST_ANALYZED FROM USER_TABLES";
        if (search) sql += ` WHERE TABLE_NAME LIKE '${search}'`;
        sql += " ORDER BY TABLE_NAME";
      }

      const result = await runSqlPlus(sql);
      return formatQueryResult(result, "List Tables");
    }

    // ── describe_table ───────────────────────────────────────────────────────
    case "describe_table": {
      const tableName = (args.table_name as string)?.toUpperCase();
      if (!tableName) return "❌ table_name is required.";

      // Use ALL_TAB_COLUMNS for detailed info
      let owner: string, tbl: string;
      if (tableName.includes(".")) {
        [owner, tbl] = tableName.split(".");
      } else {
        owner = "USER";
        tbl = tableName;
      }

      const ownerClause =
        owner === "USER" ? "OWNER = USER" : `OWNER = '${owner}'`;

      const sql = `
SELECT
  COLUMN_NAME,
  DATA_TYPE ||
    CASE
      WHEN DATA_TYPE IN ('VARCHAR2','NVARCHAR2','CHAR') THEN '(' || DATA_LENGTH || ')'
      WHEN DATA_TYPE = 'NUMBER' AND DATA_PRECISION IS NOT NULL THEN '(' || DATA_PRECISION || ',' || DATA_SCALE || ')'
      ELSE ''
    END AS DATA_TYPE,
  NULLABLE,
  DATA_DEFAULT
FROM ALL_TAB_COLUMNS
WHERE ${ownerClause}
  AND TABLE_NAME = '${tbl}'
ORDER BY COLUMN_ID`;

      const result = await runSqlPlus(sql);
      if (!result.success) return formatQueryResult(result, "Describe Table");

      // Also get primary keys
      const pkSql = `
SELECT cols.COLUMN_NAME
FROM ALL_CONSTRAINTS cons, ALL_CONS_COLUMNS cols
WHERE cons.CONSTRAINT_TYPE = 'P'
  AND cons.CONSTRAINT_NAME = cols.CONSTRAINT_NAME
  AND cons.${ownerClause}
  AND cons.TABLE_NAME = '${tbl}'
ORDER BY cols.POSITION`;

      const pkResult = await runSqlPlus(pkSql);

      let output = `=== ${tableName} ===\n\n${result.output}`;
      if (pkResult.success && pkResult.output) {
        output += `\n\n--- Primary Key(s) ---\n${pkResult.output}`;
      }
      return output;
    }

    // ── list_schemas ─────────────────────────────────────────────────────────
    case "list_schemas": {
      const sql = `
SELECT DISTINCT OWNER, COUNT(*) AS TABLE_COUNT
FROM ALL_TABLES
GROUP BY OWNER
ORDER BY OWNER`;
      const result = await runSqlPlus(sql);
      return formatQueryResult(result, "List Schemas");
    }

    // ── get_table_sample ─────────────────────────────────────────────────────
    case "get_table_sample": {
      const tableName = args.table_name as string;
      const limit = Math.min(Number(args.limit ?? 10), 100);
      if (!tableName) return "❌ table_name is required.";
      const sql = `SELECT * FROM ${tableName} WHERE ROWNUM <= ${limit}`;
      const result = await runSqlPlus(sql);
      return formatQueryResult(result, `Sample from ${tableName}`);
    }

    // ── list_procedures ──────────────────────────────────────────────────────
    case "list_procedures": {
      const schema = (args.schema as string | undefined)?.toUpperCase();
      const ownerClause = schema ? `OWNER = '${schema}'` : "OWNER = USER";
      const sql = `
SELECT OBJECT_NAME, OBJECT_TYPE, STATUS, LAST_DDL_TIME
FROM ALL_OBJECTS
WHERE ${ownerClause}
  AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE')
ORDER BY OBJECT_TYPE, OBJECT_NAME`;
      const result = await runSqlPlus(sql);
      return formatQueryResult(result, "List Procedures");
    }

    // ── test_connection ──────────────────────────────────────────────────────
    case "test_connection": {
      const sql = `
SELECT
  'Connected as: ' || USER AS INFO FROM DUAL
UNION ALL
SELECT 'DB Version: ' || BANNER FROM V$VERSION WHERE ROWNUM = 1
UNION ALL
SELECT 'Current Time: ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') FROM DUAL`;
      const result = await runSqlPlus(sql);
      return formatQueryResult(result, "Connection Test");
    }

    default:
      return `❌ Unknown tool: ${name}`;
  }
}

// ─── MCP Server setup ─────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "oracle-sqlplus-mcp",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const text = await handleTool(name, args as Record<string, unknown>);
    return { content: [{ type: "text", text }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ Tool error: ${msg}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(
    `[oracle-mcp] Starting Oracle MCP Server (sqlplus mode)\n` +
    `[oracle-mcp] Connection target: ${CONNECTION_STRING.replace(/:([^@]+)@/, ":***@")}\n` +
    `[oracle-mcp] sqlplus binary: ${SQLPLUS_PATH}\n`
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[oracle-mcp] Server ready ✓\n");
}

main().catch((err) => {
  process.stderr.write(`[oracle-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
