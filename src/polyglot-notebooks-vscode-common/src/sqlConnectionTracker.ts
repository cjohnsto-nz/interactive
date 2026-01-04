// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

// Track SQL connections per notebook (connected state)
const notebookSqlConnections = new Map<string, { connectionName: string, kernelName: string }>();

// Track saved connection info per notebook (not yet connected)
interface SavedConnectionInfo {
    connectionName: string;
    connectionId?: string;
}
const notebookSavedConnections = new Map<string, SavedConnectionInfo>();

export function setConnection(notebookUri: string, connectionName: string, kernelName: string): void {
    notebookSqlConnections.set(notebookUri, { connectionName, kernelName });
    // Clear saved connection since we're now connected
    notebookSavedConnections.delete(notebookUri);
}

export function setSavedConnection(notebookUri: string, connectionName: string, connectionId?: string): void {
    notebookSavedConnections.set(notebookUri, { connectionName, connectionId });
}

export function getSavedConnection(notebookUri: string): string | undefined {
    return notebookSavedConnections.get(notebookUri)?.connectionName;
}

export function getSavedConnectionId(notebookUri: string): string | undefined {
    return notebookSavedConnections.get(notebookUri)?.connectionId;
}

export function getConnection(notebookUri: string): { connectionName: string, kernelName: string } | undefined {
    return notebookSqlConnections.get(notebookUri);
}

export function getConnectedSqlKernelName(notebookUri: string): string | undefined {
    const connection = notebookSqlConnections.get(notebookUri);
    return connection ? `sql-${connection.kernelName}` : undefined;
}

export function clearConnection(notebookUri: string): void {
    notebookSqlConnections.delete(notebookUri);
}
