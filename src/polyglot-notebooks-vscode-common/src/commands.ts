// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import * as path from 'path';
import { acquireDotnetInteractive } from './acquisition';
import { InstallInteractiveArgs, InteractiveLaunchOptions } from './interfaces';
import { ClientMapper } from './clientMapper';
import * as vscodeUtilities from './vscodeUtilities';
import { getEol, toNotebookDocument } from './vscodeUtilities';
import { DotNetPathManager } from './extension';
import { computeToolInstallArguments, executeSafe, executeSafeAndLog, extensionToDocumentType, getVersionNumber } from './utilities';

import * as notebookControllers from './notebookControllers';
import * as metadataUtilities from './metadataUtilities';
import { ReportChannel } from './interfaces/vscode-like';
import { NotebookParserServer } from './notebookParserServer';
import { PromiseCompletionSource } from './polyglot-notebooks/promiseCompletionSource';

import * as constants from './constants';
import { getMssqlConnectionService } from './mssqlConnectionService';
import { Logger } from './polyglot-notebooks/logger';
import * as sqlConnectionTracker from './sqlConnectionTracker';
import * as vscodeNotebookManagement from './vscodeNotebookManagement';
import * as commandsAndEvents from './polyglot-notebooks/commandsAndEvents';

let sqlConnectionStatusBar: vscode.StatusBarItem | undefined;

export function updateSqlConnectionStatusBar() {
    const notebook = getCurrentNotebookDocument();
    if (!notebook) {
        if (sqlConnectionStatusBar) {
            sqlConnectionStatusBar.hide();
        }
        vscode.commands.executeCommand('setContext', 'polyglotNotebook.isSqlNotebook', false);
        vscode.commands.executeCommand('setContext', 'polyglotNotebook.hasConnectionDefined', false);
        return;
    }

    // Check if this is a SQL notebook (legacy ADS or Polyglot with SQL default)
    const isSqlNotebook = metadataUtilities.isSqlNotebook(notebook);
    vscode.commands.executeCommand('setContext', 'polyglotNotebook.isSqlNotebook', isSqlNotebook);

    // Check if notebook has a connection defined in metadata
    const sqlMetadata = metadataUtilities.getSqlConnectionMetadataFromNotebookDocument(notebook);
    const hasConnectionDefined = !!sqlMetadata?.connectionId;
    vscode.commands.executeCommand('setContext', 'polyglotNotebook.hasConnectionDefined', hasConnectionDefined);

    if (!sqlConnectionStatusBar) {
        sqlConnectionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    }

    if (hasConnectionDefined) {
        // Has connection defined - show connection name, click to change
        const connectionName = sqlMetadata?.connectionName || 'MSSQL Connection';
        sqlConnectionStatusBar.text = `$(database) ${connectionName}`;
        sqlConnectionStatusBar.tooltip = `MSSQL Proxy: ${connectionName}\nClick to change connection`;
        sqlConnectionStatusBar.backgroundColor = undefined;
        sqlConnectionStatusBar.command = 'polyglot-notebook.changeSqlConnection';
        sqlConnectionStatusBar.show();
    } else if (isSqlNotebook) {
        // SQL notebook but no connection - show "Connect to MSSQL"
        sqlConnectionStatusBar.text = `$(database) Connect to MSSQL`;
        sqlConnectionStatusBar.tooltip = 'Click to connect to MSSQL database';
        sqlConnectionStatusBar.backgroundColor = undefined;
        sqlConnectionStatusBar.command = 'polyglot-notebook.connectSqlProxy';
        sqlConnectionStatusBar.show();
    } else {
        // Not a SQL notebook - hide status bar
        sqlConnectionStatusBar.hide();
    }
}

export async function registerAcquisitionCommands(context: vscode.ExtensionContext, diagnosticChannel: ReportChannel): Promise<void> {
    const dotnetConfig = vscode.workspace.getConfiguration(constants.DotnetConfigurationSectionName);
    const requiredDotNetInteractiveVersion = dotnetConfig.get<string>('requiredInteractiveToolVersion');
    const interactiveToolSource = dotnetConfig.get<string>('interactiveToolSource');

    if (!requiredDotNetInteractiveVersion) {
        const errorTitle = 'Polyglot Notebooks extension will not work.';
        const errorDetails = `Incorrect value for option "${constants.DotnetConfigurationSectionName}.requiredInteractiveToolVersion" in settings.json.  Please remove this value and restart VS Code.`;
        await vscode.window.showErrorMessage(errorTitle, { modal: true, detail: errorDetails });
        throw new Error(errorDetails);
    }

    let acquirePromise: Promise<InteractiveLaunchOptions> | undefined = undefined;

    context.subscriptions.push(vscode.commands.registerCommand('dotnet-interactive.acquire', async (args?: InstallInteractiveArgs | string | undefined): Promise<InteractiveLaunchOptions | undefined> => {
        try {
            const installArgs = computeToolInstallArguments(args);
            DotNetPathManager.setDotNetPath(installArgs.dotnetPath);

            if (!acquirePromise) {
                const installationPromiseCompletionSource = new PromiseCompletionSource<void>();
                acquirePromise = acquireDotnetInteractive(
                    installArgs,
                    requiredDotNetInteractiveVersion,
                    context.globalStorageUri.fsPath,
                    getInteractiveVersion,
                    createToolManifest,
                    (version: string) => {
                        vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: `Installing .NET Interactive version ${version}...` },
                            (_progress, _token) => installationPromiseCompletionSource.promise);
                    },
                    installInteractiveTool,
                    () => { installationPromiseCompletionSource.resolve(); });
            }
            const launchOptions = await acquirePromise;
            return launchOptions;
        } catch (err) {
            diagnosticChannel.appendLine(`Error acquiring dotnet-interactive tool: ${err}`);
        }
    }));

    async function createToolManifest(dotnetPath: string, globalStoragePath: string): Promise<void> {
        const result = await executeSafeAndLog(diagnosticChannel, 'create-tool-manifest', dotnetPath, ['new', 'tool-manifest'], globalStoragePath);
        if (result.code !== 0) {
            throw new Error(`Unable to create local tool manifest.  Command failed with code ${result.code}.\n\nSTDOUT:\n${result.output}\n\nSTDERR:\n${result.error}`);
        }
    }

    async function installInteractiveTool(args: InstallInteractiveArgs, globalStoragePath: string): Promise<void> {
        // remove previous tool; swallow errors in case it's not already installed
        let uninstallArgs = [
            'tool',
            'uninstall',
            'Microsoft.dotnet-interactive'
        ];
        await executeSafeAndLog(diagnosticChannel, 'tool-uninstall', args.dotnetPath, uninstallArgs, globalStoragePath);

        let toolArgs = [
            'tool',
            'install',
            '--add-source',
            interactiveToolSource!,
            '--ignore-failed-sources',
            'Microsoft.dotnet-interactive'
        ];
        if (args.toolVersion) {
            toolArgs.push('--version', args.toolVersion);
        }

        return new Promise(async (resolve, reject) => {
            const result = await executeSafeAndLog(diagnosticChannel, 'tool-install', args.dotnetPath, toolArgs, globalStoragePath);
            if (result.code === 0) {
                resolve();
            } else {
                reject();
            }
        });
    }
}

function getCurrentNotebookDocument(): vscode.NotebookDocument | undefined {
    if (!vscode.window.activeNotebookEditor) {
        return undefined;
    }

    return vscode.window.activeNotebookEditor.notebook;
}

export function registerKernelCommands(context: vscode.ExtensionContext, clientMapper: ClientMapper) {

    // Update status bar when active notebook changes
    context.subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(() => {
        updateSqlConnectionStatusBar();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.notebookEditor.restartKernel', async (_notebookEditor) => {
        await vscode.commands.executeCommand('polyglot-notebook.restartCurrentNotebookKernel');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.notebookEditor.openValueViewer', async () => {
        // vscode creates a command named `<viewId>.focus` for all contributed views, so we need to match the id
        await vscode.commands.executeCommand('polyglot-notebook-panel-values.focus');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.notebookEditor.connectSubkernel', async (notebook?: vscode.NotebookDocument) => {
        notebook = notebook || getCurrentNotebookDocument();

        if (!notebook) {
            return;
        }

        const client = await clientMapper.getOrAddClient(notebook.uri);

        const result = await client.requestCodeExpansionInfos();

        const dataConnectionOptions = mapCodeExpansionInfosToQuickPickOptions(
            result.codeExpansionInfos
                .filter(i => i.kind === "DataConnection"));
        const kernelspecConnectionOptions = mapCodeExpansionInfosToQuickPickOptions(
            result.codeExpansionInfos
                .filter(i => i.kind === "KernelSpecConnection"));
        const recentlyUsedConnectionOptions = mapCodeExpansionInfosToQuickPickOptions(
            result.codeExpansionInfos
                .filter(i => i.kind === "RecentConnection"));

        // Add MSSQL Extension option for creating new SQL proxy kernels
        const mssqlExtensionOption = {
            label: 'MSSQL Extension (Proxy Mode)',
            description: 'Connect to SQL Server using MSSQL extension',
            iconPath: new vscode.ThemeIcon('database'),
            isMssqlExtension: true
        };

        const allOptions = [
            { kind: vscode.QuickPickItemKind.Separator, label: 'Data kernels', description: '' },
            ...dataConnectionOptions,
            mssqlExtensionOption,
            { kind: vscode.QuickPickItemKind.Separator, label: 'Jupyter kernels', description: '' },
            ...kernelspecConnectionOptions,
            { kind: vscode.QuickPickItemKind.Separator, label: 'Recent kernels', description: '' },
            ...recentlyUsedConnectionOptions];

        const selectedOption = await vscode.window.showQuickPick(allOptions, { title: 'Connect to new cell kernel' }) as any;

        if (selectedOption) {
            if (selectedOption.isMssqlExtension) {
                // Open MSSQL extension connection picker for cell-level kernel
                await vscode.commands.executeCommand('polyglot-notebook.connectSqlProxyForCell');
            } else {
                const selection = vscode.window.activeNotebookEditor?.selection;

                client.execute(
                    `#!expand "${selectedOption.label}"`,
                    { kernelName: ".NET", index: selection?.end },
                    output => { }, _ => { });
            }
        }

        function mapCodeExpansionInfosToQuickPickOptions(infos: any[]) {
            return infos.map(i => {
                return {
                    label: i.name,
                    description: i.description,
                    iconPath: new vscode.ThemeIcon('plug')
                };
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.restartCurrentNotebookKernel', async (notebook?: vscode.NotebookDocument | undefined) => {
        notebook = notebook || getCurrentNotebookDocument();
        if (notebook) {
            // notifty the client that the kernel is about to restart
            const restartCompletionSource = new PromiseCompletionSource<void>();
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Restarting kernel...'
            },
                (_progress, _token) => restartCompletionSource.promise);
            await vscode.commands.executeCommand('polyglot-notebook.stopCurrentNotebookKernel', notebook);
            await vscode.commands.executeCommand('polyglot-notebook.resetNotebookKernelCollection', notebook);
            const _client = await clientMapper.getOrAddClient(notebook.uri);
            restartCompletionSource.resolve();
            await vscode.commands.executeCommand('workbench.notebook.layout.webview.reset', notebook.uri);
            vscode.window.showInformationMessage('Kernel restarted.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.stopCurrentNotebookKernel', async (notebook?: vscode.NotebookDocument | undefined) => {
        notebook = notebook || getCurrentNotebookDocument();
        if (notebook) {
            for (const cell of notebook.getCells()) {
                notebookControllers.endExecution(undefined, cell, false);
            }

            const client = await clientMapper.tryGetClient(notebook.uri);
            if (client) {
                client.resetExecutionCount();
            }

            clientMapper.closeClient(notebook.uri);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.stopAllNotebookKernels', async () => {
        vscode.workspace.notebookDocuments
            .filter(document => clientMapper.isDotNetClient(document.uri))
            .forEach(async document => await vscode.commands.executeCommand('polyglot-notebook.stopCurrentNotebookKernel', document));
    }));

    // Register Connect (to saved connection) command - reconnects using proxy mode
    // Happy path: Read connectionId from metadata -> getAvailableKernels() -> connect()
    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.connectSavedSql', async () => {
        const notebook = getCurrentNotebookDocument();
        if (!notebook) {
            return;
        }

        const sqlMetadata = metadataUtilities.getSqlConnectionMetadataFromNotebookDocument(notebook);
        
        if (!sqlMetadata.connectionId) {
            // No saved connection - open picker
            await vscode.commands.executeCommand('polyglot-notebook.connectSqlProxy');
            return;
        }

        // Step 1: Get available kernels (this activates MSSQL extension and registers commands)
        const mssqlService = getMssqlConnectionService();
        const kernels = await mssqlService.getAvailableKernels();
        const kernel = kernels.find(k => k.id === sqlMetadata.connectionId);
        
        if (!kernel) {
            vscode.window.showWarningMessage(`Connection "${sqlMetadata.connectionName}" not found. Please select a new connection.`);
            await vscode.commands.executeCommand('polyglot-notebook.connectSqlProxy');
            return;
        }
        
        // Step 2: Connect via MSSQL
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Connecting SQL', cancellable: false },
                async (progress) => {
                    progress.report({ message: `Connecting to ${kernel.name}...` });
                    
                    const connectionUri = await vscode.commands.executeCommand<string>(
                        'mssql.connectionSharing.connect',
                        'ms-dotnetinteractive.polyglot-notebooks',
                        kernel.id
                    );
                    
                    if (!connectionUri) {
                        throw new Error('Failed to connect to database');
                    }
                    
                    // Step 3: Store connection state
                    const kernelName = `sql-${kernel.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    sqlConnectionTracker.setProxyConnection(notebook.uri.toString(), kernel.name, kernel.id, connectionUri);
                    
                    // Step 4: Register the proxy kernel with the .NET kernel via #!connect mssql-proxy
                    // Send directly to .NET process via channel - events flow back through channel receiver
                    // which has the KernelInfoProduced handler that updates the kernel selector
                    try {
                        const client = await clientMapper.getOrAddClient(notebook.uri);
                        const code = `#!connect mssql-proxy --kernel-name ${kernelName}`;
                        const submitCommand = new commandsAndEvents.KernelCommandEnvelope(
                            commandsAndEvents.SubmitCodeType,
                            {
                                code: code,
                                targetKernelName: '.NET'  // Send to composite kernel
                            } as commandsAndEvents.SubmitCode
                        );
                        await client.channel.sender.send(submitCommand);
                    } catch (e: any) {
                        // Proxy kernel registration failed - continue anyway
                    }
                    
                    // Step 5: Update metadata to ensure proxyMode is set and kernel has connectionId
                    const isIpynb = metadataUtilities.isIpynbNotebook(notebook);
                    let updatedMetadata = metadataUtilities.mergeSqlConnectionMetadataIntoNotebookMetadata(
                        notebook.metadata,
                        { 
                            connectionId: kernel.id, 
                            connectionName: kernel.name, 
                            connectionProfileName: kernel.name,
                            proxyMode: true
                        },
                        isIpynb
                    );
                    
                    // Step 6: Store connectionId in the kernel's metadata for persistence
                    const notebookDocMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(notebook);
                    const updatedKernelMetadata = metadataUtilities.setKernelConnectionId(notebookDocMetadata, kernelName, kernel.id);
                    updatedMetadata = metadataUtilities.getMergedRawNotebookDocumentMetadataFromNotebookDocumentMetadata(
                        updatedKernelMetadata, 
                        updatedMetadata, 
                        metadataUtilities.isIpynbNotebook(notebook)
                    );
                    
                    await vscodeNotebookManagement.updateNotebookMetadata(notebook.uri, updatedMetadata);
                    
                    updateSqlConnectionStatusBar();
                    vscode.window.showInformationMessage(`SQL connected: ${kernel.name}`);
                }
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(`Connection failed: ${error?.message || error}`);
        }
    }));

    // Register Change Connection command - opens picker
    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.changeSqlConnection', async () => {
        await vscode.commands.executeCommand('polyglot-notebook.connectSqlProxy');
    }));

    // Register MSSQL connection command - redirects to proxy picker
    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.connectMssql', async () => {
        await vscode.commands.executeCommand('polyglot-notebook.connectSqlProxy');
    }));

    // Register cell-level SQL proxy connection (doesn't change notebook-level connection)
    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.connectSqlProxyForCell', async () => {
        const notebook = getCurrentNotebookDocument();
        if (!notebook) {
            vscode.window.showWarningMessage('No active notebook');
            return;
        }

        const mssqlService = getMssqlConnectionService();
        const kernels = await mssqlService.getAvailableKernels();
        
        if (kernels.length === 0) {
            vscode.window.showWarningMessage('No saved SQL connections found. Please create a connection in the MSSQL extension first.');
            return;
        }

        // Let user pick a connection
        const items = kernels.map(k => ({
            label: k.name,
            description: `${k.server} / ${k.database}`,
            kernel: k
        }));

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Select SQL Connection for Cell Kernel',
            placeHolder: 'Choose a connection to create a cell-level SQL kernel'
        });

        if (!selected) {
            return;
        }

        const kernel = selected.kernel;
        
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Creating SQL Kernel', cancellable: false },
                async (progress) => {
                    progress.report({ message: `Connecting to ${kernel.name}...` });
                    
                    const connectionUri = await vscode.commands.executeCommand<string>(
                        'mssql.connectionSharing.connect',
                        'ms-dotnetinteractive.polyglot-notebooks',
                        kernel.id
                    );
                    
                    if (!connectionUri) {
                        throw new Error('Failed to connect to database');
                    }
                    
                    const kernelName = `sql-${kernel.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    
                    // Register the proxy kernel with .NET (but don't set as notebook-level connection)
                    try {
                        const client = await clientMapper.getOrAddClient(notebook.uri);
                        const code = `#!connect mssql-proxy --kernel-name ${kernelName}`;
                        const submitCommand = new commandsAndEvents.KernelCommandEnvelope(
                            commandsAndEvents.SubmitCodeType,
                            {
                                code: code,
                                targetKernelName: '.NET'
                            } as commandsAndEvents.SubmitCode
                        );
                        await client.channel.sender.send(submitCommand);
                    } catch (e: any) {
                        // Proxy kernel registration failed - continue anyway
                    }
                    
                    // Store connectionId in kernel metadata for persistence (but not notebook-level)
                    const notebookDocMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(notebook);
                    const updatedKernelMetadata = metadataUtilities.setKernelConnectionId(notebookDocMetadata, kernelName, kernel.id);
                    const updatedMetadata = metadataUtilities.getMergedRawNotebookDocumentMetadataFromNotebookDocumentMetadata(
                        updatedKernelMetadata, 
                        notebook.metadata, 
                        metadataUtilities.isIpynbNotebook(notebook)
                    );
                    
                    await vscodeNotebookManagement.updateNotebookMetadata(notebook.uri, updatedMetadata);
                    
                    // Set the current cell to use this kernel
                    const selection = vscode.window.activeNotebookEditor?.selection;
                    if (selection) {
                        const cell = notebook.cellAt(selection.start);
                        const codeCell = await vscodeUtilities.ensureCellIsCodeCell(cell);
                        const notebookCellMetadata = metadataUtilities.getNotebookCellMetadataFromNotebookCellElement(cell);
                        notebookCellMetadata.kernelName = kernelName;
                        const newRawMetadata = metadataUtilities.getRawNotebookCellMetadataFromNotebookCellMetadata(notebookCellMetadata);
                        const mergedMetadata = metadataUtilities.mergeRawMetadata(cell.metadata, newRawMetadata);
                        await vscodeNotebookManagement.updateNotebookCellMetadata(codeCell.notebook.uri, codeCell.index, mergedMetadata);
                    }
                    
                    vscode.window.showInformationMessage(`Created SQL kernel: ${kernelName}`);
                }
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create SQL kernel: ${error?.message || error}`);
        }
    }));

    // Proof of concept: Execute SQL via MSSQL proxy (no credentials exposed)
    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.executeSqlViaProxy', async () => {
        const mssqlService = getMssqlConnectionService();
        
        try {
            // Get available kernels from MSSQL
            const kernels = await mssqlService.getAvailableKernels();
            if (kernels.length === 0) {
                vscode.window.showWarningMessage('No saved SQL connections found in MSSQL extension.');
                return;
            }

            // Let user pick a kernel
            const items = kernels.map(k => ({
                label: k.name,
                description: `${k.server} / ${k.database}`,
                detail: `Auth: ${k.authenticationType}${k.userName ? ` (${k.userName})` : ''}`,
                kernel: k
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a SQL connection to use',
                title: 'MSSQL Proxy Kernel (Proof of Concept)'
            });

            if (!selected) {
                return;
            }

            // Get SQL query from user
            const query = await vscode.window.showInputBox({
                prompt: 'Enter SQL query to execute',
                placeHolder: 'SELECT TOP 10 * FROM sys.tables',
                value: 'SELECT TOP 5 name, create_date FROM sys.tables ORDER BY create_date DESC'
            });

            if (!query) {
                return;
            }

            // Execute via MSSQL proxy
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Executing SQL via MSSQL Proxy',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: `Connecting to ${selected.kernel.name}...` });
                    
                    try {
                        const result = await mssqlService.executeQueryOnKernel(selected.kernel.id, query);
                        
                        // Format and display results
                        if (result && result.rows && result.rows.length > 0) {
                            const columns = result.columnInfo?.map((c: any) => c.columnName) || Object.keys(result.rows[0]);
                            
                            // Create a simple table output
                            let output = `**Query Results** (${result.rows.length} rows)\n\n`;
                            output += '| ' + columns.join(' | ') + ' |\n';
                            output += '| ' + columns.map(() => '---').join(' | ') + ' |\n';
                            
                            for (const row of result.rows.slice(0, 20)) { // Limit to 20 rows for display
                                const values = row.map((cell: any) => cell?.displayValue ?? cell?.toString() ?? 'NULL');
                                output += '| ' + values.join(' | ') + ' |\n';
                            }
                            
                            if (result.rows.length > 20) {
                                output += `\n*... and ${result.rows.length - 20} more rows*`;
                            }

                            // Show in output channel
                            const outputChannel = vscode.window.createOutputChannel('MSSQL Proxy Results');
                            outputChannel.clear();
                            outputChannel.appendLine(`Query: ${query}`);
                            outputChannel.appendLine(`Connection: ${selected.kernel.name}`);
                            outputChannel.appendLine(`Rows: ${result.rows.length}`);
                            outputChannel.appendLine('');
                            outputChannel.appendLine('Results:');
                            outputChannel.appendLine(JSON.stringify(result.rows.slice(0, 20), null, 2));
                            outputChannel.show();

                            vscode.window.showInformationMessage(
                                `Query executed successfully! ${result.rows.length} rows returned. See output channel for results.`
                            );
                        } else {
                            vscode.window.showInformationMessage('Query executed successfully. No rows returned.');
                        }
                    } catch (error: any) {
                        vscode.window.showErrorMessage(`Query failed: ${error?.message || error}`);
                    }
                }
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error?.message || error}`);
        }
    }));

    // Connect to SQL via MSSQL proxy (no credentials exposed to Polyglot)
    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.connectSqlProxy', async () => {
        const notebook = getCurrentNotebookDocument();
        if (!notebook) {
            vscode.window.showWarningMessage('Please open a notebook first.');
            return;
        }

        const mssqlService = getMssqlConnectionService();
        
        try {
            // Get available kernels from MSSQL
            const kernels = await mssqlService.getAvailableKernels();
            if (kernels.length === 0) {
                vscode.window.showWarningMessage('No saved SQL connections found in MSSQL extension.');
                return;
            }

            // Let user pick a kernel
            const items = kernels.map(k => ({
                label: k.name,
                description: `${k.server} / ${k.database}`,
                detail: `Auth: ${k.authenticationType}${k.userName ? ` (${k.userName})` : ''}`,
                kernel: k
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a SQL connection to use',
                title: 'Connect SQL (Proxy Mode - Secure)'
            });

            if (!selected) {
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Connecting SQL (Proxy Mode)',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: `Connecting to ${selected.kernel.name}...` });
                    
                    const extensionId = 'ms-dotnetinteractive.polyglot-notebooks';
                    
                    // Connect via MSSQL to get a connectionUri
                    const connectionUri = await vscode.commands.executeCommand<string>(
                        'mssql.connectionSharing.connect',
                        extensionId,
                        selected.kernel.id
                    );
                    
                    if (!connectionUri) {
                        throw new Error('Failed to connect to database');
                    }
                    
                    // Store as proxy connection in memory
                    const kernelName = `sql-${selected.kernel.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    sqlConnectionTracker.setProxyConnection(
                        notebook.uri.toString(),
                        selected.kernel.name,
                        selected.kernel.id,
                        connectionUri
                    );
                    
                    // Register the proxy kernel with the .NET kernel via #!connect mssql-proxy
                    // Send directly to .NET process via channel - events flow back through channel receiver
                    // which has the KernelInfoProduced handler that updates the kernel selector
                    try {
                        const client = await clientMapper.getOrAddClient(notebook.uri);
                        const code = `#!connect mssql-proxy --kernel-name ${kernelName}`;
                        const submitCommand = new commandsAndEvents.KernelCommandEnvelope(
                            commandsAndEvents.SubmitCodeType,
                            {
                                code: code,
                                targetKernelName: '.NET'  // Send to composite kernel
                            } as commandsAndEvents.SubmitCode
                        );
                        await client.channel.sender.send(submitCommand);
                    } catch (e: any) {
                        // Proxy kernel registration failed - continue anyway
                    }
                    
                    // Save to notebook metadata for persistence
                    const updatedMetadata = metadataUtilities.mergeSqlConnectionMetadataIntoNotebookMetadata(
                        notebook.metadata,
                        { 
                            connectionId: selected.kernel.id, 
                            connectionName: selected.kernel.name, 
                            connectionProfileName: selected.kernel.name,
                            proxyMode: true
                        },
                        metadataUtilities.isIpynbNotebook(notebook)
                    );
                    await vscodeNotebookManagement.updateNotebookMetadata(notebook.uri, updatedMetadata);
                    
                    updateSqlConnectionStatusBar();
                    
                    vscode.window.showInformationMessage(
                        `SQL Proxy connected: ${selected.kernel.name}. SQL cells will execute via MSSQL extension.`
                    );
                }
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error?.message || error}`);
        }
    }));

}

export function registerFileCommands(context: vscode.ExtensionContext, parserServer: NotebookParserServer, clientMapper: ClientMapper) {

    const eol = getEol();

    const notebookFileFilters = {
        'Polyglot Notebook Script': ['dib'],
        'Jupyter Notebook': ['ipynb'],
    };

    async function newNotebookCommandHandler(preferDefaults: boolean): Promise<void> {
        const extension = await getNewNotebookExtension(preferDefaults);
        if (!extension) {
            return;
        }

        const language = await getNewNotebookLanguage(preferDefaults);
        if (!language) {
            return;
        }

        await newNotebookWithLanguage(extension, language);

        if (preferDefaults) {
            // if the defaults were even in play, ask the user if they want to save them
            // don't await this, since it's not critical
            promptToSaveDefaults(extension, language);
        }
    }

    async function promptToSaveDefaults(extension: string, language: string): Promise<void> {
        const polyglotConfig = vscode.workspace.getConfiguration(constants.PolyglotConfigurationSectionName);

        // check to see if the user doesn't want to see this
        const suppressPromptToSaveDefaults = polyglotConfig.get<boolean>('suppressPromptToSaveDefaults');
        if (suppressPromptToSaveDefaults) {
            return;
        }

        // if some default settings were missing...
        const defaultExtension = polyglotConfig.get<string>('defaultNotebookExtension');
        const defaultLanguage = polyglotConfig.get<string>('defaultNotebookLanguage');
        if (!defaultExtension || !defaultLanguage) {
            // ...ask if they want to save the defaults
            const setDefaultsOption = 'Set defaults';
            const dontAskOption = "Don't ask again";
            const saveDefaults = await vscode.window.showInformationMessage('Would you like to set default values for future notebooks?', setDefaultsOption, 'Dismiss', dontAskOption);
            if (saveDefaults === setDefaultsOption) {
                // set the values the user just selected...
                await polyglotConfig.update('defaultNotebookExtension', extension, vscode.ConfigurationTarget.Global);
                await polyglotConfig.update('defaultNotebookLanguage', language, vscode.ConfigurationTarget.Global);
                // ...then open the settings so they can make any additional changes
                vscode.commands.executeCommand('polyglot-notebook.setNewNotebookDefaults');
            } else if (saveDefaults === dontAskOption) {
                // set the value to suppress the prompt
                await polyglotConfig.update('suppressPromptToSaveDefaults', true, vscode.ConfigurationTarget.Global);
            } else {
                // anything else was either 'Dismiss' or the dialog was closed
            }
        }
    }

    async function getNewNotebookExtension(preferDefault: boolean): Promise<string | undefined> {
        const polyglotConfig = vscode.workspace.getConfiguration(constants.PolyglotConfigurationSectionName);
        if (preferDefault) {
            // try to get the default notebook type
            const defaultNotebookExtension = polyglotConfig.get<string>('defaultNotebookExtension');
            if (defaultNotebookExtension) {
                return defaultNotebookExtension;
            }
        }

        // either wanted a fresh value, or no default was set; directly ask the user
        const availableNotebookExtensions = ['.dib', '.ipynb'];
        const selectedExtension = await vscode.window.showQuickPick(availableNotebookExtensions, { title: 'Create as...' });
        if (selectedExtension) {
            return selectedExtension;
        }

        return undefined;
    }

    // Shared mapping of display names to kernel names
    const languagesAndKernelNames: { [key: string]: string } = {
        'C#': 'csharp',
        'F#': 'fsharp',
        'HTML': 'html',
        'JavaScript': 'javascript',
        'Markdown': 'markdown',
        'Mermaid': 'mermaid',
        'PowerShell': 'pwsh',
        'SQL': 'sql'
    };

    async function getNewNotebookLanguage(preferDefault: boolean): Promise<string | undefined> {
        const polyglotConfig = vscode.workspace.getConfiguration(constants.PolyglotConfigurationSectionName);
        if (preferDefault) {
            // try to get the default notebook type
            const defaultNotebookLanguage = polyglotConfig.get<string>('defaultNotebookLanguage');
            if (defaultNotebookLanguage) {
                return defaultNotebookLanguage;
            }
        }

        // either wanted a fresh value, or no default was set; directly ask the user
        const newLanguageOptions: string[] = [];
        for (const languageName in languagesAndKernelNames) {
            newLanguageOptions.push(languageName);
        }

        const notebookLanguage = await vscode.window.showQuickPick(newLanguageOptions, { title: 'Default Language' });
        if (notebookLanguage) {
            return languagesAndKernelNames[notebookLanguage];
        }

        return undefined;
    }

    async function newNotebookFromExtension(extension: string): Promise<void> {
        const language = await getNewNotebookLanguage(true);
        if (!language) {
            return;
        }

        await newNotebookWithLanguage(extension, language);
    }

    async function newNotebookWithLanguage(extension: string, kernelName: string): Promise<void> {
        const extensionViewTypeMap: { [key: string]: string } = {
            '.dib': constants.NotebookViewType,
            '.ipynb': constants.JupyterViewType,
        };
        const viewType = extensionViewTypeMap[extension];
        const isMarkdown = kernelName.toLowerCase() === 'markdown';

        // the metadata needs an actual kernel name, not the special-cased 'markdown'
        const kernelNameInMetadata = isMarkdown ? 'csharp' : kernelName;
        const notebookCellMetadata: metadataUtilities.NotebookCellMetadata = {
            kernelName: kernelNameInMetadata,
        };
        const rawCellMetadata = metadataUtilities.getRawNotebookCellMetadataFromNotebookCellMetadata(notebookCellMetadata);
        const [cellKind, cellLanguage] = isMarkdown ? [vscode.NotebookCellKind.Markup, 'markdown'] : [vscode.NotebookCellKind.Code, constants.CellLanguageIdentifier];
        const cell = new vscode.NotebookCellData(cellKind, '', cellLanguage);
        cell.metadata = rawCellMetadata;
        const notebookDocumentMetadata: metadataUtilities.NotebookDocumentMetadata = {
            kernelInfo: {
                defaultKernelName: kernelNameInMetadata,
                items: [
                    {
                        name: kernelNameInMetadata,
                        aliases: [],
                        languageName: kernelNameInMetadata // it just happens that the kernel names we allow are also the language names
                    }
                ]
            }
        };

        const createForIpynb = viewType === constants.JupyterViewType;
        const rawNotebookMetadata = metadataUtilities.getMergedRawNotebookDocumentMetadataFromNotebookDocumentMetadata(notebookDocumentMetadata, {}, createForIpynb);
        const content = new vscode.NotebookData([cell]);
        content.metadata = rawNotebookMetadata;
        const notebook = await vscode.workspace.openNotebookDocument(viewType, content);
        const _editor = await vscode.window.showNotebookDocument(notebook);

        if (createForIpynb) {
            await selectDotNetInteractiveKernelForJupyter();
        }
    }

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.setNewNotebookDefaults', async () => {
        await vscode.commands.executeCommand('workbench.action.openGlobalSettings', { query: 'polyglot-notebook.defaultNotebook' });
    }));

    // Command to change the default language of the current notebook
    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.changeNotebookDefaultLanguage', async () => {
        const notebook = getCurrentNotebookDocument();
        if (!notebook) {
            vscode.window.showWarningMessage('No Polyglot Notebook is currently open.');
            return;
        }

        const currentMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(notebook);
        const currentKernel = currentMetadata.kernelInfo.defaultKernelName;
        const currentLanguage = Object.entries(languagesAndKernelNames).find(([_, k]) => k === currentKernel)?.[0] || currentKernel;

        const languageOptions = Object.keys(languagesAndKernelNames).map(lang => ({
            label: lang,
            description: languagesAndKernelNames[lang] === currentKernel ? '(current)' : undefined
        }));

        const selected = await vscode.window.showQuickPick(languageOptions, {
            title: 'Set Default Language for This Notebook',
            placeHolder: `Current: ${currentLanguage}`
        });

        if (!selected) {
            return; // User cancelled
        }

        const newKernelName = languagesAndKernelNames[selected.label];
        if (newKernelName === currentKernel) {
            return; // No change
        }

        // Update the notebook metadata
        const isIpynb = metadataUtilities.isIpynbNotebook(notebook);
        const newMetadata: metadataUtilities.NotebookDocumentMetadata = {
            kernelInfo: {
                defaultKernelName: newKernelName,
                items: currentMetadata.kernelInfo.items
            }
        };

        // Ensure the new kernel is in the items list
        if (!newMetadata.kernelInfo.items.find(item => item.name === newKernelName)) {
            newMetadata.kernelInfo.items.push({
                name: newKernelName,
                aliases: [],
                languageName: newKernelName
            });
        }

        const existingRawMetadata = notebook.metadata;
        const updatedRawMetadata = metadataUtilities.getMergedRawNotebookDocumentMetadataFromNotebookDocumentMetadata(newMetadata, existingRawMetadata, isIpynb);
        const finalMetadata = metadataUtilities.mergeRawMetadata(existingRawMetadata, updatedRawMetadata);

        await vscodeNotebookManagement.updateNotebookMetadata(notebook.uri, finalMetadata);

        // Update the SQL notebook context for toolbar visibility
        updateSqlConnectionStatusBar();

        vscode.window.showInformationMessage(`Notebook default language changed to ${selected.label}.`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.newNotebook', async () => {
        await newNotebookCommandHandler(true);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.newNotebookNoDefaults', async () => {
        await newNotebookCommandHandler(false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.fileNew', async () => {
        // this command exists purely to forward to the polyglot-notebook.newNotebook command, but we need a separate `title`/`shortTitle` for the command palette
        await vscode.commands.executeCommand('polyglot-notebook.newNotebook');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.newNotebookDib', async () => {
        await newNotebookFromExtension('.dib');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.newNotebookIpynb', async () => {
        await newNotebookFromExtension('.ipynb');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.openNotebook', async (notebookUri: vscode.Uri | undefined) => {
        // ensure we have a notebook uri
        if (!notebookUri) {
            const uris = await vscode.window.showOpenDialog({
                filters: notebookFileFilters
            });

            if (uris && uris.length > 0) {
                notebookUri = uris[0];
            }

            if (!notebookUri) {
                // no appropriate uri
                return;
            }
        }

        await openNotebook(notebookUri);
    }));

    async function openNotebook(uri: vscode.Uri): Promise<void> {
        const extension = path.extname(uri.toString());
        const viewType = extension === '.dib'
            ? constants.NotebookViewType
            : constants.JupyterViewType;
        await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
    }

    context.subscriptions.push(vscode.commands.registerCommand('polyglot-notebook.saveAsNotebook', async () => {
        if (vscode.window.activeNotebookEditor) {
            const uri = await vscode.window.showSaveDialog({
                filters: notebookFileFilters
            });

            if (!uri) {
                return;
            }

            const notebook = vscode.window.activeNotebookEditor.notebook;
            const interactiveDocument = toNotebookDocument(notebook);
            const uriPath = uri.toString();
            const extension = path.extname(uriPath);
            const documentType = extensionToDocumentType(extension);
            const buffer = await parserServer.serializeNotebook(documentType, eol, interactiveDocument);
            await vscode.workspace.fs.writeFile(uri, buffer);
            switch (path.extname(uriPath)) {
                case '.dib':
                    await vscode.commands.executeCommand('polyglot-notebook.openNotebook', uri);
                    break;
            }
        }
    }));
}

export async function selectDotNetInteractiveKernelForJupyter(): Promise<void> {
    const extension = 'ms-dotnettools.dotnet-interactive-vscode';
    const id = constants.JupyterKernelId;
    await vscode.commands.executeCommand('notebook.selectKernel', { extension, id });
}

// callbacks used to install interactive tool

async function getInteractiveVersion(dotnetPath: string, globalStoragePath: string): Promise<string | undefined> {
    const result = await executeSafe(dotnetPath, ['tool', 'run', 'dotnet-interactive', '--', '--version'], globalStoragePath);
    if (result.code === 0) {
        const versionString = getVersionNumber(result.output);
        return versionString;
    }

    return undefined;
}
