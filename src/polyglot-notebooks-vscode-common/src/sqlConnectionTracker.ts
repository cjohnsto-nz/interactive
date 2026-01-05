// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

// Track SQL connections per cell-level kernel (sql-* kernels only)
// Notebook-level SQL connections have been removed - all SQL kernels are now explicit cell-level kernels.

// Track connection URIs by connection ID (GUID) - shared across all notebooks
const connectionUrisByConnectionId = new Map<string, string>();

// Track which kernel name is associated with which connection ID
// Key: kernelName (e.g., "sql-AllianceProd"), Value: connectionId (GUID)
const kernelToConnectionId = new Map<string, string>();

// Track pending connection promises to prevent race conditions
// Key: kernelName, Value: Promise that resolves to connectionUri
const pendingConnections = new Map<string, Promise<string | undefined>>();

/**
 * Get the cached connection URI for a cell-level SQL kernel (sql-* kernel).
 * @param kernelName The kernel name (e.g., "sql-MyConnection")
 * @returns The cached connection URI, or undefined if not cached
 */
export function getProxyConnectionUriForKernel(kernelName: string): string | undefined {
    const connectionId = kernelToConnectionId.get(kernelName);
    if (connectionId) {
        return connectionUrisByConnectionId.get(connectionId);
    }
    return undefined;
}

/**
 * Cache the connection for a cell-level SQL kernel.
 * @param kernelName The kernel name (e.g., "sql-MyConnection")
 * @param connectionId The MSSQL connection ID (GUID from mssql settings)
 * @param connectionUri The MSSQL connection URI (returned from mssql.connectionSharing.connect)
 */
export function setKernelConnection(kernelName: string, connectionId: string, connectionUri: string): void {
    kernelToConnectionId.set(kernelName, connectionId);
    connectionUrisByConnectionId.set(connectionId, connectionUri);
}

/**
 * Get the connection ID for a kernel name.
 * @param kernelName The kernel name (e.g., "sql-MyConnection")
 * @returns The connection ID (GUID), or undefined if not found
 */
export function getConnectionIdForKernel(kernelName: string): string | undefined {
    return kernelToConnectionId.get(kernelName);
}

/**
 * Clear the cached connection for a kernel.
 * @param kernelName The kernel name to clear
 */
export function clearKernelConnection(kernelName: string): void {
    const connectionId = kernelToConnectionId.get(kernelName);
    if (connectionId) {
        kernelToConnectionId.delete(kernelName);
        // Don't delete from connectionUrisByConnectionId - other kernels might use the same connection
    }
    pendingConnections.delete(kernelName);
}

/**
 * Get a pending connection promise for a kernel, if one exists.
 * @param kernelName The kernel name
 * @returns The pending promise, or undefined if no connection is in progress
 */
export function getPendingConnection(kernelName: string): Promise<string | undefined> | undefined {
    return pendingConnections.get(kernelName);
}

/**
 * Set a pending connection promise for a kernel.
 * @param kernelName The kernel name
 * @param promise The promise that will resolve to the connectionUri
 */
export function setPendingConnection(kernelName: string, promise: Promise<string | undefined>): void {
    pendingConnections.set(kernelName, promise);
}

/**
 * Clear a pending connection promise for a kernel.
 * @param kernelName The kernel name
 */
export function clearPendingConnection(kernelName: string): void {
    pendingConnections.delete(kernelName);
}
