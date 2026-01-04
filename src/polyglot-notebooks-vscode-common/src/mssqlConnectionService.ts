// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import { Logger } from './polyglot-notebooks/logger';

const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

/**
 * Interface matching the mssql extension's IConnectionInfo
 */
export interface IMssqlConnectionInfo {
    server: string;
    database: string;
    user: string;
    password: string;
    authenticationType: string;
    connectionString?: string;
    profileName?: string;
    connectionId?: string;
    [key: string]: any;
}

/**
 * Information about a connection that can be used as a notebook kernel.
 * This interface exposes only metadata - no credentials or secrets.
 */
export interface IConnectionKernelInfo {
    id: string;
    name: string;
    server: string;
    database: string;
    authenticationType: string;
    userName?: string;
}

/**
 * Interface for connection sharing service (allows using mssql's internal auth)
 */
export interface IConnectionSharingService {
    connect(extensionId: string, connectionId: string, database?: string): Promise<string | undefined>;
    getConnectionString(extensionId: string, connectionId: string): Promise<string | undefined>;
    disconnect(connectionUri: string): void;
    isConnected(connectionUri: string): boolean;
    executeSimpleQuery(connectionUri: string, queryString: string): Promise<any>;
    getAvailableKernels(extensionId: string): Promise<IConnectionKernelInfo[]>;
}

/**
 * Interface matching the mssql extension's exported API
 */
export interface IMssqlExtensionApi {
    promptForConnection(ignoreFocusOut?: boolean): Promise<IMssqlConnectionInfo | undefined>;
    connect(connectionInfo: IMssqlConnectionInfo, saveConnection?: boolean): Promise<string>;
    getConnectionString(
        connectionUriOrDetails: string | any,
        includePassword?: boolean,
        includeApplicationName?: boolean
    ): Promise<string>;
    connectionSharing: IConnectionSharingService;
}

/**
 * Service for integrating with the VS Code mssql extension
 */
export class MssqlConnectionService {
    private static _instance: MssqlConnectionService | undefined;

    // Session cache for authenticated connection strings to avoid re-authentication
    private connectionStringCache: Map<string, string> = new Map();

    public static get instance(): MssqlConnectionService {
        if (!MssqlConnectionService._instance) {
            MssqlConnectionService._instance = new MssqlConnectionService();
        }
        return MssqlConnectionService._instance;
    }

    /**
     * Get a cached connection string by connection name
     */
    public getCachedConnectionString(connectionName: string): string | undefined {
        const cached = this.connectionStringCache.get(connectionName);
        console.log(`[Polyglot SQL] getCachedConnectionString("${connectionName}"): ${cached ? 'FOUND (cached)' : 'NOT FOUND'}`);
        if (cached) {
            // Log masked connection string for debugging
            const masked = cached
                .replace(/Password=[^;]*/gi, 'Password=***')
                .replace(/AccessToken=[^;]*/gi, 'AccessToken=***');
            console.log(`[Polyglot SQL] Cached connection string: ${masked}`);
        }
        return cached;
    }

    /**
     * Cache a connection string for the session
     */
    public cacheConnectionString(connectionName: string, connectionString: string): void {
        console.log(`[Polyglot SQL] Caching connection string for "${connectionName}"`);
        // Log masked connection string for debugging
        const masked = connectionString
            .replace(/Password=[^;]*/gi, 'Password=***')
            .replace(/AccessToken=[^;]*/gi, 'AccessToken=***');
        console.log(`[Polyglot SQL] Connection string to cache: ${masked}`);
        console.log(`[Polyglot SQL] Contains AccessToken: ${connectionString.toLowerCase().includes('accesstoken')}`);

        this.connectionStringCache.set(connectionName, connectionString);
        Logger.default.info(`Cached connection string for "${connectionName}"`);
    }

    /**
     * Check if the mssql extension is installed
     */
    public isMssqlExtensionInstalled(): boolean {
        return vscode.extensions.getExtension(MSSQL_EXTENSION_ID) !== undefined;
    }

    /**
     * Get the mssql extension API
     */
    public async getMssqlExtensionApi(): Promise<IMssqlExtensionApi | undefined> {
        const mssqlExtension = vscode.extensions.getExtension(MSSQL_EXTENSION_ID);
        if (!mssqlExtension) {
            Logger.default.warn('MSSQL extension is not installed');
            return undefined;
        }

        if (!mssqlExtension.isActive) {
            await mssqlExtension.activate();
        }

        return mssqlExtension.exports as IMssqlExtensionApi;
    }

    /**
     * Get available SQL kernels from the MSSQL extension.
     * These are saved connections that can be used as execution targets.
     * No credentials are exposed - only metadata.
     * @returns Array of kernel info objects, or empty array if MSSQL extension is not available
     */
    public async getAvailableKernels(): Promise<IConnectionKernelInfo[]> {
        try {
            // Ensure MSSQL extension is activated
            const api = await this.getMssqlExtensionApi();
            if (!api) {
                console.log('[Polyglot SQL] MSSQL extension not available');
                return [];
            }

            const extensionId = 'ms-dotnetinteractive.polyglot-notebooks';
            
            // Call via vscode.commands since the API object may not have the new method
            const kernels = await vscode.commands.executeCommand<IConnectionKernelInfo[]>(
                'mssql.connectionSharing.getAvailableKernels',
                extensionId
            );
            
            if (!kernels) {
                console.log('[Polyglot SQL] getAvailableKernels returned no kernels');
                return [];
            }
            
            console.log(`[Polyglot SQL] Got ${kernels.length} available kernels from MSSQL`);
            return kernels;
        } catch (error: any) {
            console.log('[Polyglot SQL] Error getting available kernels:', error?.message || error);
            return [];
        }
    }

    /**
     * Connect to a kernel and execute a query using MSSQL's internal connection.
     * No credentials are exposed - MSSQL handles all authentication.
     * @param connectionId The connection ID to use
     * @param query The SQL query to execute
     * @returns The query result, or undefined if failed
     */
    public async executeQueryOnKernel(connectionId: string, query: string): Promise<any> {
        try {
            // Ensure MSSQL extension is activated
            const api = await this.getMssqlExtensionApi();
            if (!api) {
                throw new Error('MSSQL extension not available');
            }

            const extensionId = 'ms-dotnetinteractive.polyglot-notebooks';
            
            // Connect to get a connectionUri via command
            const connectionUri = await vscode.commands.executeCommand<string>(
                'mssql.connectionSharing.connect',
                extensionId,
                connectionId
            );
            
            if (!connectionUri) {
                throw new Error('Failed to connect to database');
            }
            
            console.log(`[Polyglot SQL] Connected, uri: ${connectionUri}`);

            // Execute the query via command
            const result = await vscode.commands.executeCommand<any>(
                'mssql.connectionSharing.executeSimpleQuery',
                connectionUri,
                query
            );
            
            return result;
        } catch (error: any) {
            console.log('[Polyglot SQL] Error executing query on kernel:', error?.message || error);
            throw error;
        }
    }

    /**
     * Result from prompting for a connection
     */
    public static sanitizeKernelName(name: string): string {
        // Replace invalid characters with underscores and ensure it starts with a letter
        let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!/^[a-zA-Z]/.test(sanitized)) {
            sanitized = 'sql_' + sanitized;
        }
        return sanitized;
    }

    /**
     * Prompt the user to select a connection from the mssql extension's connection manager
     * @returns The connection string if successful, undefined if cancelled or failed
     */
    public async promptForConnectionString(): Promise<string | undefined> {
        const result = await this.promptForConnection();
        return result?.connectionString;
    }

    /**
     * Prompt the user to select a connection from the mssql extension's connection manager.
     * Connection must be saved in mssql settings (must have an id).
     * @returns The connection info including name, connection string, and connectionId, or undefined if cancelled
     */
    public async promptForConnection(): Promise<{ name: string; connectionString: string; connectionId: string } | undefined> {
        const api = await this.getMssqlExtensionApi();
        if (!api) {
            vscode.window.showErrorMessage(
                'The MSSQL extension is required for this feature. Please install it from the VS Code marketplace.'
            );
            return undefined;
        }

        try {
            // Prompt user to select or create a connection
            Logger.default.info('Prompting for MSSQL connection...');
            const connectionInfo = await api.promptForConnection(true);
            if (!connectionInfo) {
                Logger.default.info('User cancelled connection selection');
                return undefined;
            }

            // Get the connection ID directly from the response (now exposed via IConnectionInfo.id)
            const connectionId = (connectionInfo as any).id as string;
            
            if (!connectionId) {
                Logger.default.error('No connection ID returned from promptForConnection');
                vscode.window.showErrorMessage('Connection must be saved to use with Polyglot Notebooks.');
                return undefined;
            }

            // Log connection info
            console.log(`[Polyglot SQL] Connection selected: id=${connectionId}, profileName=${connectionInfo.profileName}, server=${connectionInfo.server}`);

            // Use connectByConnectionId which handles everything (name derivation, token retrieval)
            return await this.connectByConnectionId(connectionId);
        } catch (error) {
            Logger.default.error(`Error getting connection from mssql extension: ${error}`);
            vscode.window.showErrorMessage(`Failed to get connection: ${error}`);
            return undefined;
        }
    }

    /**
     * Get a list of saved connections from the mssql extension settings
     */
    public getSavedConnections(): { profileName: string; server: string; database: string }[] {
        const config = vscode.workspace.getConfiguration('mssql');
        const connections = config.get<any[]>('connections') || [];

        return connections.map((conn: { profileName?: string; server: string; database?: string }) => ({
            profileName: conn.profileName || `${conn.server}/${conn.database || 'default'}`,
            server: conn.server,
            database: conn.database || ''
        }));
    }

    /**
     * Connect using a connection ID directly via the connectionSharing API.
     * This is the preferred method when we have the connectionId from notebook metadata.
     * 
     * Uses connectionSharing API which handles MSAL token caching and silent refresh.
     * 
     * @param connectionId The mssql connection ID (GUID)
     * @returns The connection info if successful, undefined otherwise
     */
    public async connectByConnectionId(connectionId: string): Promise<{ name: string; connectionString: string; connectionId: string } | undefined> {
        const api = await this.getMssqlExtensionApi();
        if (!api) {
            return undefined;
        }

        console.log(`[Polyglot SQL] Connecting by connectionId: ${connectionId}`);
        
        // Look up the connection details from mssql settings
        const config = vscode.workspace.getConfiguration('mssql');
        const connections = config.get<any[]>('connections') || [];
        const conn = connections.find((c: any) => c.id === connectionId);
        
        if (!conn) {
            console.log(`[Polyglot SQL] Connection ${connectionId} not found in mssql settings`);
            return undefined;
        }
        
        // Derive display name from mssql connection: profileName or "database (server)"
        const name = conn.profileName || `${conn.database} (${conn.server})`;
        console.log(`[Polyglot SQL] Found connection: ${name}, authType: ${conn.authenticationType}`);
        
        const extensionId = 'ms-dotnettools.dotnet-interactive-vscode';

        try {
            // Get the connection string
            console.log(`[Polyglot SQL] Calling connectionSharing.getConnectionString()...`);
            let connectionString = await api.connectionSharing.getConnectionString(extensionId, connectionId);
            
            if (!connectionString) {
                console.log('[Polyglot SQL] connectionSharing.getConnectionString() returned no string');
                return undefined;
            }

            // For Azure MFA connections, get the access token from MSSQL's cached auth
            if (conn.authenticationType === 'AzureMFA') {
                console.log(`[Polyglot SQL] Calling connectionSharing.getAccessToken()...`);
                // Use type assertion since getAccessToken is a new API we added to MSSQL extension
                const connectionSharingAny = api.connectionSharing as any;
                const accessToken = connectionSharingAny.getAccessToken ? await connectionSharingAny.getAccessToken(extensionId, connectionId) : undefined;
                
                if (accessToken) {
                    console.log('[Polyglot SQL] Got access token from MSSQL extension');
                    // Remove Authentication=ActiveDirectoryInteractive and add AccessToken
                    connectionString = connectionString.replace(/Authentication\s*=\s*ActiveDirectoryInteractive\s*;?/gi, '');
                    connectionString = connectionString.trim().replace(/;$/, '');
                    connectionString = `${connectionString};AccessToken=${accessToken}`;
                } else {
                    console.log('[Polyglot SQL] No access token returned - MSSQL will handle auth');
                }
            }
            
            const maskedConnStr = connectionString
                .replace(/Password=[^;]*/gi, 'Password=***')
                .replace(/AccessToken=[^;]*/gi, 'AccessToken=***');
            console.log('[Polyglot SQL] Got connection string:', maskedConnStr);
            console.log('[Polyglot SQL] Contains AccessToken:', connectionString.toLowerCase().includes('accesstoken'));

            return { name: name!, connectionString, connectionId };
        } catch (error: any) {
            console.log('[Polyglot SQL] Error using connectionSharing API:', error?.message || error);
            return undefined;
        }
    }

    /**
     * Show a quick pick to select from saved connections or create a new one
     * @returns The connection string if successful, undefined if cancelled
     */
    public async showConnectionQuickPick(): Promise<string | undefined> {
        const api = await this.getMssqlExtensionApi();
        if (!api) {
            vscode.window.showErrorMessage(
                'The MSSQL extension is required for SQL connections. Please install it from the VS Code marketplace.'
            );
            return undefined;
        }

        // Use the mssql extension's built-in connection picker
        return this.promptForConnectionString();
    }
}

/**
 * Get the singleton instance of the mssql connection service
 */
export function getMssqlConnectionService(): MssqlConnectionService {
    return MssqlConnectionService.instance;
}
