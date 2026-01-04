# MSSQL Kernel Provider - Design Document

## Overview

This document describes the MSSQL Kernel Provider approach for secure SQL execution in Polyglot Notebooks. Instead of passing credentials to the .NET kernel, SQL execution is delegated to the MSSQL extension which handles all authentication internally.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Polyglot Notebooks                          │
│  ┌─────────────────┐    ┌─────────────────────────────────────┐ │
│  │  SQL Notebook   │    │     Proxy Kernel (TypeScript)       │ │
│  │  ┌───────────┐  │    │  - Intercepts SQL cell execution    │ │
│  │  │ SQL Cell  │──┼────│  - Routes to MSSQL extension        │ │
│  │  └───────────┘  │    │  - Formats results for display      │ │
│  └─────────────────┘    └──────────────┬──────────────────────┘ │
└────────────────────────────────────────┼────────────────────────┘
                                         │ VS Code Commands
                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MSSQL Extension                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Connection Sharing Service                      ││
│  │  - getAvailableKernels() → List saved connections           ││
│  │  - connect() → Establish connection, return URI             ││
│  │  - executeSimpleQuery() → Run SQL, return results           ││
│  │  - [Future] executeQuery() → Full query with streaming      ││
│  │  - [Future] getCompletions() → Intellisense support         ││
│  └──────────────────────────┬──────────────────────────────────┘│
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐│
│  │              SQL Tools Service (STS)                         ││
│  │  - Manages database connections                              ││
│  │  - Executes queries                                          ││
│  │  - Provides intellisense                                     ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Security Benefits

1. **No Credential Exposure**: Passwords and tokens never leave the MSSQL extension
2. **MSAL Token Caching**: Azure AD tokens are cached and refreshed by MSSQL
3. **Permission Model**: Extensions must be approved to use connections
4. **Audit Trail**: All connection usage is logged by MSSQL

## Current Implementation (POC)

### MSSQL Extension APIs

| API | Status | Description |
|-----|--------|-------------|
| `getAvailableKernels(extensionId)` | ✅ Implemented | Returns list of saved connections as kernel metadata |
| `connect(extensionId, connectionId)` | ✅ Existing | Establishes connection, returns connectionUri |
| `executeSimpleQuery(connectionUri, query)` | ✅ Existing | Executes query, returns all results |
| `disconnect(connectionUri)` | ✅ Existing | Closes connection |

### Polyglot Extension Components

| Component | Status | Description |
|-----------|--------|-------------|
| `MssqlConnectionService.getAvailableKernels()` | ✅ Implemented | Calls MSSQL API |
| `MssqlConnectionService.executeQueryOnKernel()` | ✅ Implemented | Connect + execute |
| `sqlConnectionTracker.setProxyConnection()` | ✅ Implemented | Track proxy connections |
| `connectSqlProxy` command | ✅ Implemented | UI for proxy connection |
| `executeProxyCell()` | ✅ Implemented | Cell execution via proxy |

## Limitations (POC vs ADS Parity)

### Current Limitations

| Feature | POC Status | ADS Behavior | Path to Parity |
|---------|------------|--------------|----------------|
| Single result set | ⚠️ First only | Multiple supported | Use `query/execute` API |
| Large results | ⚠️ All in memory | Streaming/paging | Add subset fetching |
| Query cancellation | ❌ Not supported | Supported | Add `cancelQuery` API |
| Progress messages | ❌ Not captured | PRINT shown | Add message handler |
| Intellisense | ❌ Not available | Full support | Add `getCompletions` API |
| Query timeout | ⚠️ 30s default | Configurable | Add timeout parameter |
| Multiple batches | ❌ Not supported | GO separator | Parse and execute batches |

### What Works

- ✅ All SQL statement types (SELECT, INSERT, UPDATE, DELETE, DDL)
- ✅ Transactions (BEGIN/COMMIT/ROLLBACK)
- ✅ Stored procedure calls
- ✅ Azure AD authentication (handled by MSSQL)
- ✅ SQL Server authentication
- ✅ Connection pooling (via STS)

## Future Enhancements

### Phase 1: Full Query Execution API

Add to MSSQL `IConnectionSharingService`:

```typescript
interface IQueryExecutionOptions {
    timeout?: number;           // Query timeout in seconds
    maxRows?: number;           // Maximum rows to return
    includeMessages?: boolean;  // Include PRINT/RAISERROR messages
}

interface IQueryExecutionResult {
    batchSummaries: IBatchSummary[];
    messages: IMessage[];
    hasMoreResults: boolean;
}

// New APIs
executeQuery(connectionUri: string, query: string, options?: IQueryExecutionOptions): Promise<IQueryExecutionResult>;
getQuerySubset(connectionUri: string, batchIndex: number, resultSetIndex: number, startRow: number, rowCount: number): Promise<IResultSubset>;
cancelQuery(connectionUri: string): Promise<void>;
```

### Phase 2: Intellisense Support

```typescript
interface ICompletionItem {
    label: string;
    kind: CompletionItemKind;
    detail?: string;
    insertText?: string;
}

// New API
getCompletions(connectionUri: string, query: string, position: number): Promise<ICompletionItem[]>;
```

### Phase 3: Enhanced Features

- Execution plans (estimated and actual)
- Query history
- Result set export
- Parameter binding

## Files Changed

### MSSQL Extension (`vscode-mssql`)

- `typings/vscode-mssql.d.ts` - Added `IConnectionKernelInfo` interface and `getAvailableKernels` signature
- `src/connectionSharing/connectionSharingService.ts` - Implemented `getAvailableKernels()` method
- `test/unit/connectionSharingService.test.ts` - Added unit tests

### Polyglot Notebooks (`interactive`)

- `src/polyglot-notebooks-vscode-common/src/mssqlConnectionService.ts` - Added `getAvailableKernels()` and `executeQueryOnKernel()`
- `src/polyglot-notebooks-vscode-common/src/sqlConnectionTracker.ts` - Added proxy connection tracking
- `src/polyglot-notebooks-vscode-common/src/commands.ts` - Added `connectSqlProxy` and `executeSqlViaProxy` commands
- `src/polyglot-notebooks-vscode-common/src/notebookControllers.ts` - Added `executeProxyCell()` for proxy execution
- `src/polyglot-notebooks-vscode/package.json` - Registered new commands

## Testing

### Manual Testing

1. Install both VSIX packages
2. Open a SQL notebook
3. Run "Connect SQL (Proxy Mode - Secure)" command
4. Select a saved connection
5. Execute SQL cells - results display as HTML tables

### Unit Tests

- `connectionSharingService.test.ts` - Tests for `getAvailableKernels()`

## Branch Information

| Repository | Branch | Description |
|------------|--------|-------------|
| vscode-mssql | `feature/mssql-kernel-provider` | MSSQL API additions |
| interactive | `feature/mssql-kernel-provider` | Polyglot proxy kernel |

## Next Steps

1. [ ] Test POC end-to-end
2. [ ] Discuss with Polyglot team
3. [ ] Plan Phase 1 implementation
4. [ ] Add comprehensive tests
5. [ ] Update documentation

## Future: SlickGrid-Based Table Renderer

For ADS-like table experience with sorting, filtering, and export, implement a VS Code notebook renderer:

### Architecture

1. **Custom MIME type**: `application/vnd.polyglot.sql-results+json`
2. **Notebook renderer contribution** in `package.json`:
   ```json
   "notebookRenderer": [{
     "id": "polyglot-sql-results",
     "entrypoint": "./out/sql-renderer.js",
     "mimeTypes": ["application/vnd.polyglot.sql-results+json"]
   }]
   ```
3. **SlickGrid bundle** - Use `slickgrid` npm package (MIT licensed, same as ADS uses)
4. **Output format**:
   ```json
   {
     "columns": [{"name": "col1", "type": "string"}, ...],
     "rows": [[{"displayValue": "val", "isNull": false}, ...], ...],
     "rowCount": 100
   }
   ```

### Features to Implement

- Column sorting (click header)
- Column resize (drag border)
- Row selection
- Copy to clipboard
- Export to CSV/JSON
- VS Code theme integration via CSS variables
- Virtualization for large result sets

### Reference Implementation

- ADS table component: `azuredatastudio/src/sql/base/browser/ui/table/`
- SlickGrid: MIT licensed, `github.com/mleibman/SlickGrid`
- Microsoft fork: `github.com/Microsoft/SlickGrid.ADS`
