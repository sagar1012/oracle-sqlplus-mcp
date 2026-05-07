# oracle-sqlplus-mcp

An MCP (Model Context Protocol) server for Oracle Database using **sqlplus** as the connection backend. No Oracle Instant Client Node.js bindings required — just a working `sqlplus` binary.

---

## Prerequisites

- **sqlplus** must be installed and available in `PATH` (comes with Oracle Instant Client or full Oracle client)
- Node.js 18+

---

## Installation

```bash
npm install -g oracle-sqlplus-mcp
# or run directly with npx (no install needed):
npx oracle-sqlplus-mcp
```

---

## Connection String Format

```
username/password@host:port/servicename
```

**Examples:**
```
scott/tiger@localhost:1521/ORCL
myuser/mypass@192.168.1.10:1521/XEPDB1
admin/secret@db.example.com:1521/PROD
```

---

## Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["-y", "oracle-sqlplus-mcp"],
      "env": {
        "ORACLE_CONNECTION": "username/password@host:port/servicename"
      }
    }
  }
}
```

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ORACLE_CONNECTION` | *(required)* | Full connection string |
| `SQLPLUS_PATH` | `sqlplus` | Path to sqlplus binary if not in PATH |
| `QUERY_TIMEOUT_MS` | `30000` | Query timeout in milliseconds |

### Custom sqlplus path example

```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["-y", "oracle-sqlplus-mcp"],
      "env": {
        "ORACLE_CONNECTION": "scott/tiger@192.168.1.10:1521/ORCL",
        "SQLPLUS_PATH": "C:\\oracle\\instantclient_21_9\\sqlplus.exe",
        "QUERY_TIMEOUT_MS": "60000"
      }
    }
  }
}
```

---

## Available Tools

| Tool | Description |
|---|---|
| `test_connection` | Test connectivity and return Oracle version |
| `list_schemas` | List all schemas with table counts |
| `list_tables` | List tables, optionally filtered by schema or name pattern |
| `describe_table` | Show columns, data types, nullable, primary keys |
| `get_table_sample` | Fetch sample rows from a table |
| `execute_query` | Run any SELECT query |
| `execute_ddl` | Run DDL/DML (INSERT, UPDATE, DELETE, CREATE, etc.) |
| `list_procedures` | List stored procedures, functions, packages |

---

## Example Prompts

- *"Test the Oracle connection"*
- *"List all schemas in the database"*
- *"Show me tables in the SCOTT schema"*
- *"Describe the EMPLOYEES table"*
- *"Get 5 sample rows from HR.EMPLOYEES"*
- *"Run this query: SELECT * FROM departments WHERE department_id < 50"*
- *"List all stored procedures in the HR schema"*

---

## Troubleshooting

### `sqlplus: command not found`
Set `SQLPLUS_PATH` to the full path of your sqlplus binary.

### `ORA-12541: TNS:no listener`
Check host, port, and that Oracle listener is running.

### `ORA-01017: invalid username/password`
Verify credentials. Connection string format: `user/pass@host:port/service`.

### `SP2-0306: Invalid option`
Ensure sqlplus version supports `-S` silent mode (all modern versions do).
