# MSSQL Kernel Provider - Design Document

## Overview

This document describes the MSSQL Kernel Provider approach for secure SQL execution in Polyglot Notebooks. Instead of passing credentials to the .NET kernel, SQL execution is delegated to the MSSQL extension which handles all authentication internally.

**Key Design Decisions:**
- All SQL kernels use the `mssql-` prefix (e.g., `mssql-MyConnection`)
- SQL connections are **cell-level only** - no notebook-level SQL kernel
- The base `sql` kernel is not supported; users must create named `mssql-*` kernels
- `mssql-*` kernels are filtered from the "Recent kernels" list (no `connectionId` available for re-registration)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Polyglot Notebooks                          │
│  ┌─────────────────┐    ┌─────────────────────────────────────┐ │
│  │  Notebook       │    │     MssqlProxyKernel (.NET)         │ │
│  │  ┌───────────┐  │    │  - Registered via #!connect         │ │
│  │  │ mssql-*   │──┼────│  - Handles language service requests│ │
│  │  │ SQL Cell  │  │    │  - Returns empty results (proxy)    │ │
│  │  └───────────┘  │    └──────────────┬──────────────────────┘ │
│  └─────────────────┘                   │                        │
│                                        │                        │
│  ┌─────────────────────────────────────▼──────────────────────┐ │
│  │           notebookControllers.ts (TypeScript)              │ │
│  │  - executeProxyCell() intercepts mssql-* cell execution    │ │
│  │  - Routes to MSSQL extension for actual execution          │ │
│  │  - Formats results as HTML tables                          │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────────┘
                              │ VS Code Commands
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MSSQL Extension                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Connection Sharing Service                      ││
│  │  - getAvailableKernels() → List saved connections           ││
│  │  - connect() → Establish connection, return URI             ││
│  │  - executeSimpleQuery() → Run SQL, return results           ││
│  │  - getCompletions() → Intellisense support                  ││
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

## Current Implementation

### Kernel Naming Convention

All MSSQL proxy kernels use the `mssql-` prefix:
- `mssql-MyConnection`
- `mssql-ProductionDB`
- `mssql-AllianceUAT`

Helper functions are provided on both .NET and TypeScript sides:

**.NET (`ConnectMssqlProxyDirective.cs`):**
```csharp
public const string KernelNamePrefix = "mssql-";
public static bool IsMssqlProxyKernel(string kernelName) => 
    kernelName?.StartsWith(KernelNamePrefix) == true;
```

**TypeScript (`metadataUtilities.ts`):**
```typescript
export const MSSQL_PROXY_KERNEL_PREFIX = 'mssql-';
export function isMssqlProxyKernel(kernelName: string | undefined): boolean {
    return kernelName !== undefined && kernelName.startsWith(MSSQL_PROXY_KERNEL_PREFIX);
}
```

### MSSQL Extension APIs

| API | Status | Description |
|-----|--------|-------------|
| `getAvailableKernels(extensionId)` | ✅ Implemented | Returns list of saved connections as kernel metadata |
| `connect(extensionId, connectionId)` | ✅ Implemented | Establishes connection, returns connectionUri |
| `executeSimpleQuery(connectionUri, query)` | ✅ Implemented | Executes query, returns all results |
| `getCompletions(connectionUri, text, line, column)` | ✅ Implemented | Returns IntelliSense completions |
| `disconnect(connectionUri)` | ✅ Implemented | Closes connection |

### Polyglot Extension Components

| Component | Status | Description |
|-----------|--------|-------------|
| `MssqlProxyKernel` (.NET) | ✅ Implemented | Proxy kernel for language services |
| `ConnectMssqlProxyDirective` (.NET) | ✅ Implemented | `#!connect mssql-proxy` directive |
| `sqlConnectionTracker.ts` | ✅ Implemented | Track connection URIs per kernel |
| `languageProvider.ts` | ✅ Implemented | Route completions to MSSQL extension |
| `executeProxyCell()` | ✅ Implemented | Cell execution via MSSQL extension |
| `isMssqlProxyKernel()` | ✅ Implemented | Helper to identify mssql-* kernels |

## Limitations (Current vs ADS Parity)

### Current Limitations

| Feature | Current Status | ADS Behavior | Path to Parity |
|---------|----------------|--------------|----------------|
| Single result set | ⚠️ First only | Multiple supported | Use `query/execute` API |
| Large results | ⚠️ All in memory | Streaming/paging | Add subset fetching |
| Query cancellation | ❌ Not supported | Supported | Add `cancelQuery` API |
| Progress messages | ❌ Not captured | PRINT shown | Add message handler |
| Intellisense | ✅ Implemented | Full support | Done |
| Query timeout | ⚠️ 30s default | Configurable | Add timeout parameter |
| Multiple batches | ❌ Not supported | GO separator | Parse and execute batches |

### What Works

- ✅ All SQL statement types (SELECT, INSERT, UPDATE, DELETE, DDL)
- ✅ Transactions (BEGIN/COMMIT/ROLLBACK)
- ✅ Stored procedure calls
- ✅ Azure AD authentication (handled by MSSQL)
- ✅ SQL Server authentication
- ✅ Connection pooling (via STS)
- ✅ IntelliSense completions (schema-aware)
- ✅ Per-cell kernel selection
- ✅ Connection ID persistence in notebook metadata
- ✅ Auto-reconnect on cell execution

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
- `src/connectionSharing/connectionSharingService.ts` - Implemented `getAvailableKernels()` and `getCompletions()` methods
- `test/unit/connectionSharingService.test.ts` - Added unit tests

### Polyglot Notebooks (`interactive`) - .NET

- `src/Microsoft.DotNet.Interactive/MssqlProxyKernel.cs` - Proxy kernel for language services
- `src/Microsoft.DotNet.Interactive/ConnectMssqlProxyDirective.cs` - `#!connect mssql-proxy` directive with `KernelNamePrefix` constant and `IsMssqlProxyKernel()` helper
- `src/Microsoft.DotNet.Interactive.Tests/MssqlProxyKernelTests.cs` - Unit tests
- `src/Microsoft.DotNet.Interactive.Documents.Tests/KernelInfoConnectionIdTests.cs` - Tests for connectionId serialization

### Polyglot Notebooks (`interactive`) - TypeScript

- `src/polyglot-notebooks-vscode-common/src/metadataUtilities.ts` - Added `MSSQL_PROXY_KERNEL_PREFIX` constant and `isMssqlProxyKernel()` helper
- `src/polyglot-notebooks-vscode-common/src/sqlConnectionTracker.ts` - Track connection URIs per mssql-* kernel
- `src/polyglot-notebooks-vscode-common/src/languageProvider.ts` - Route completions to MSSQL extension for mssql-* kernels
- `src/polyglot-notebooks-vscode-common/src/commands.ts` - MSSQL Extension connection UI, filter mssql-* from recent kernels
- `src/polyglot-notebooks-vscode-common/src/notebookControllers.ts` - `executeProxyCell()` for mssql-* kernel execution

## Testing

### Manual Testing

1. Install both VSIX packages (Polyglot Notebooks + MSSQL)
2. Open a Polyglot Notebook (.dib or .ipynb)
3. Click the cell kernel selector → "Connect to new cell kernel"
4. Select "MSSQL Extension" from the Data kernels section
5. Choose a saved connection from the MSSQL extension
6. Execute SQL cells - results display as HTML tables
7. Verify IntelliSense shows schema-aware completions (tables, columns)

### Unit Tests

- `MssqlProxyKernelTests.cs` - Tests for proxy kernel registration and language service handlers
- `KernelInfoConnectionIdTests.cs` - Tests for connectionId serialization in DIB/IPYNB formats
- `connectionSharingService.test.ts` - Tests for `getAvailableKernels()` and `getCompletions()`

## Branch Information

| Repository | Branch | Description |
|------------|--------|-------------|
| vscode-mssql | `feature/mssql-kernel-provider` | MSSQL API additions |
| interactive | `feature/mssql-kernel-provider` | Polyglot proxy kernel |

## Completed

- [x] Cell-level SQL kernel selection with `mssql-*` prefix
- [x] IntelliSense completions via MSSQL extension
- [x] Connection ID persistence in notebook metadata
- [x] Auto-reconnect on cell execution
- [x] Filter `mssql-*` from recent kernels list
- [x] Remove base `sql` kernel handling
- [x] Helper functions for kernel identification

## Next Steps

1. [ ] Add query cancellation support
2. [ ] Add multiple result set support
3. [ ] Add progress/message handling
4. [ ] Implement SlickGrid-based table renderer

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
