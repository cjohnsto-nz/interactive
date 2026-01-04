// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import { ClientMapper } from './clientMapper';
import * as commandsAndEvents from './polyglot-notebooks/commandsAndEvents';
import * as vscodeLike from './interfaces/vscode-like';
import * as diagnostics from './diagnostics';
import * as vscodeUtilities from './vscodeUtilities';
import { reshapeOutputValueForVsCode } from './interfaces/utilities';
import { selectDotNetInteractiveKernelForJupyter, updateSqlConnectionStatusBar } from './commands';
import { ErrorOutputCreator, InteractiveClient } from './interactiveClient';
import { LogEntry, Logger } from './polyglot-notebooks/logger';
import { isKernelCommandEnvelopeModel, isKernelEventEnvelope, isKernelEventEnvelopeModel, KernelCommandOrEventEnvelope } from './polyglot-notebooks/connection';
import * as rxjs from 'rxjs';
import * as metadataUtilities from './metadataUtilities';
import * as constants from './constants';
import * as vscodeNotebookManagement from './vscodeNotebookManagement';
import * as sqlConnectionTracker from './sqlConnectionTracker';
import { getMssqlConnectionService } from './mssqlConnectionService';
import * as semanticTokens from './documentSemanticTokenProvider';
import { ServiceCollection } from './serviceCollection';

const executionTasks: Map<string, vscode.NotebookCellExecution> = new Map();
const standardOutputMimeType = 'application/vnd.code.notebook.stdout';
const standardErrorMimeType = 'application/vnd.code.notebook.stderr';

export interface DotNetNotebookKernelConfiguration {
    clientMapper: ClientMapper,
    preloadUris: vscode.Uri[],
    createErrorOutput: ErrorOutputCreator,
}

export class DotNetNotebookKernel {

    private trackedOutputIds: Map<vscode.Uri, Set<string>> = new Map(); // tracks notebookUri => [trackedOutputId]
    private disposables: { dispose(): void }[] = [];

    constructor(readonly config: DotNetNotebookKernelConfiguration, readonly tokensProvider: semanticTokens.DocumentSemanticTokensProvider) {
        // ensure the tracked output ids are always fresh
        ServiceCollection.Instance.NotebookWatcher.onNotebookDocumentOpened((notebook, _client) => this.trackedOutputIds.delete(notebook.uri));
        ServiceCollection.Instance.NotebookWatcher.onNotebookDocumentClosed((notebook, _client) => this.trackedOutputIds.delete(notebook.uri));

        const preloads = config.preloadUris.map(uri => new vscode.NotebookRendererScript(uri));

        // .dib execution
        const dibController = vscode.notebooks.createNotebookController(
            constants.NotebookControllerId,
            constants.NotebookViewType,
            '.NET Interactive',
            this.executeHandler.bind(this),
            preloads
        );
        this.commonControllerInit(dibController);

        // .ipynb execution via Jupyter extension (optional)
        const jupyterController = vscode.notebooks.createNotebookController(
            constants.JupyterNotebookControllerId,
            constants.JupyterViewType,
            '.NET Interactive',
            this.executeHandler.bind(this),
            preloads
        );
        jupyterController.onDidChangeSelectedNotebooks(async e => {
            // update metadata
            if (e.selected) {
                // await updateNotebookMetadata(e.notebook, this.config.clientMapper);
            }
        });
        this.commonControllerInit(jupyterController);

        this.disposables.push(vscode.workspace.onDidOpenNotebookDocument(async notebook => {
            await this.onNotebookOpen(notebook, config.clientMapper, jupyterController);
        }));

        this.disposables.push(vscode.workspace.onDidCloseNotebookDocument(notebook => {
            stopTrackingNotebook(notebook);
        }));

        // ...but we may have to look at already opened ones if we were activated late
        for (const notebook of vscode.workspace.notebookDocuments) {
            this.onNotebookOpen(notebook, config.clientMapper, jupyterController);
        }

        this.disposables.push(vscode.workspace.onDidOpenTextDocument(async textDocument => {
            const notebook = vscode.workspace.notebookDocuments.find(n => n.getCells().find(c => c.document === textDocument) !== undefined);
            if (notebook) {
                const isDotNetNotebook = metadataUtilities.isDotNetNotebook(notebook);
                if (isDotNetNotebook) {
                    // only look at the cell metadata if the notebook is fully open
                    const isOpenComplete = isNotebookOpenComplete(notebook);
                    if (isOpenComplete) {
                        const cell = notebook.getCells().find(c => c.document === textDocument);
                        if (cell) {
                            ensureCellKernelMetadata(cell, { preferPreviousCellMetadata: true });
                        }
                    }
                }
            }
        }));
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }

    private async onNotebookOpen(notebook: vscode.NotebookDocument, clientMapper: ClientMapper, jupyterController: vscode.NotebookController): Promise<void> {
        if (metadataUtilities.isDotNetNotebook(notebook)) {
            // prepare initial grammar
            const kernelInfos = metadataUtilities.getKernelInfosFromNotebookDocument(notebook);
            this.tokensProvider.dynamicTokenProvider.rebuildNotebookGrammar(notebook.uri, kernelInfos);

            // eagerly spin up the backing process
            const client = await clientMapper.getOrAddClient(notebook.uri);
            client.resetExecutionCount();

            if (notebook.notebookType === constants.JupyterViewType) {
                jupyterController.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
                await selectDotNetInteractiveKernelForJupyter();
            }

            await updateNotebookMetadata(notebook, this.config.clientMapper);

            // Check for saved SQL connection and update status bar (don't auto-connect)
            await this.checkSavedSqlConnection(notebook);
        }
    }

    /**
     * Check for saved SQL connection in notebook metadata and update the status bar.
     * Does NOT auto-connect - user must click Connect button.
     */
    private async checkSavedSqlConnection(notebook: vscode.NotebookDocument): Promise<void> {
        const sqlConnectionMetadata = metadataUtilities.getSqlConnectionMetadataFromNotebookDocument(notebook);
        
        if (!sqlConnectionMetadata.connectionId) {
            return; // No saved connection
        }

        // Look up connection details from mssql settings to get display name
        const config = vscode.workspace.getConfiguration('mssql');
        const connections = config.get<any[]>('connections') || [];
        const conn = connections.find((c: any) => c.id === sqlConnectionMetadata.connectionId);
        
        if (!conn) {
            console.log(`[Polyglot SQL] Saved connection ${sqlConnectionMetadata.connectionId} not found in mssql settings`);
            return;
        }

        // Derive display name: profileName or "database (server)"
        const displayName = conn.profileName || `${conn.database} (${conn.server})`;
        console.log(`[Polyglot SQL] Found saved connection: ${displayName} (id: ${sqlConnectionMetadata.connectionId})`);
        
        sqlConnectionTracker.setSavedConnection(
            notebook.uri.toString(), 
            displayName,
            sqlConnectionMetadata.connectionId
        );
        updateSqlConnectionStatusBar();
    }

    /**
     * Actually connect to SQL Server using the saved or selected connection.
     * Called when user clicks the Connect button.
     */
    private async connectSqlConnection(notebook: vscode.NotebookDocument, client: InteractiveClient, connectionName?: string, connectionId?: string): Promise<void> {
        const mssqlService = getMssqlConnectionService();
        if (!mssqlService.isMssqlExtensionInstalled()) {
            vscode.window.showErrorMessage('MSSQL extension is required. Please install it from the VS Code marketplace.');
            return;
        }

        let finalConnectionName: string;
        let connectionString: string;
        let finalConnectionId: string | undefined;
        
        // Check if we have a cached connection string from this session
        if (connectionName) {
            const cachedConnectionString = mssqlService.getCachedConnectionString(connectionName);
            if (cachedConnectionString) {
                console.log(`[Polyglot SQL] Using cached connection string for "${connectionName}"`);
                finalConnectionName = connectionName;
                connectionString = cachedConnectionString;
                finalConnectionId = connectionId;
            } else if (connectionId) {
                // Use connectionId with connectionSharing API (preferred)
                console.log(`[Polyglot SQL] Connecting by connectionId: ${connectionId}`);
                const result = await mssqlService.connectByConnectionId(connectionId);
                if (result) {
                    finalConnectionName = result.name;
                    connectionString = result.connectionString;
                    finalConnectionId = result.connectionId;
                    mssqlService.cacheConnectionString(finalConnectionName, connectionString);
                } else {
                    vscode.window.showWarningMessage(`Could not connect. Please select a connection.`);
                    const promptResult = await mssqlService.promptForConnection();
                    if (!promptResult) {
                        return; // User cancelled
                    }
                    finalConnectionName = promptResult.name;
                    connectionString = promptResult.connectionString;
                    finalConnectionId = promptResult.connectionId;
                    mssqlService.cacheConnectionString(finalConnectionName, connectionString);
                }
            } else {
                // No connectionId, prompt for connection
                console.log(`[Polyglot SQL] No connectionId, prompting for connection`);
                const promptResult = await mssqlService.promptForConnection();
                if (!promptResult) {
                    return; // User cancelled
                }
                finalConnectionName = promptResult.name;
                connectionString = promptResult.connectionString;
                finalConnectionId = promptResult.connectionId;
                mssqlService.cacheConnectionString(finalConnectionName, connectionString);
            }
        } else {
            // No connection name provided, prompt for one
            const promptResult = await mssqlService.promptForConnection();
            if (!promptResult) {
                return; // User cancelled
            }
            finalConnectionName = promptResult.name;
            connectionString = promptResult.connectionString;
            finalConnectionId = promptResult.connectionId;
            mssqlService.cacheConnectionString(finalConnectionName, connectionString);
        }

        try {
            // Sanitize kernel name
            const kernelName = finalConnectionName.replace(/[^a-zA-Z0-9_]/g, '_');

            // Check if this kernel is already connected (avoid duplicate kernel error)
            const existingConnection = sqlConnectionTracker.getConnection(notebook.uri.toString());
            if (existingConnection && existingConnection.kernelName === kernelName) {
                Logger.default.info(`Kernel "${kernelName}" already connected for this notebook`);
                return;
            }

            // Load SQL Server extension and connect
            // Add local NuGet source first, then reference the package
            const addSourceCode = `#i "nuget:c:\\Projects\\interactive\\src\\Microsoft.DotNet.Interactive.SqlServer\\nupkg"`;
            console.log(`[Polyglot SQL] Executing: ${addSourceCode}`);
            await client.execute(addSourceCode, { kernelName: "csharp" }, () => {}, () => {});
            const nugetCode = `#r "nuget: Microsoft.DotNet.Interactive.SqlServer, 1.0.0-dev.26054.4"`;
            console.log(`[Polyglot SQL] Executing: ${nugetCode}`);
            await client.execute(nugetCode, { kernelName: "csharp" }, () => {}, () => {});
            console.log(`[Polyglot SQL] NuGet package loaded`);

            // Fix User ID quoting for connection strings with spaces
            const fixedConnectionString = connectionString.replace(
                /User ID="([^"]*)"/,
                (_match: string, userId: string) => `User ID='${userId.replace(/'/g, "''")}'`
            );

            const connectCode = `#!connect mssql --kernel-name ${kernelName} "${fixedConnectionString}"`;
            await client.execute(connectCode, { kernelName: "csharp" }, () => {}, () => {});

            // Store in memory tracker
            sqlConnectionTracker.setConnection(notebook.uri.toString(), finalConnectionName, kernelName);
            
            // Update status bar to show the connection
            updateSqlConnectionStatusBar();

            Logger.default.info(`Connected SQL notebook to "${finalConnectionName}"`);
            vscode.window.showInformationMessage(`SQL connection established: ${finalConnectionName}`);
        } catch (error: any) {
            Logger.default.error(`Failed to connect SQL: ${error?.message || error}`);
            vscode.window.showErrorMessage(`Failed to connect: ${error?.message || error}`);
        }
    }

    private uriMessageHandlerMap: Map<string, rxjs.Subject<KernelCommandOrEventEnvelope>> = new Map();

    private commonControllerInit(controller: vscode.NotebookController) {
        controller.supportedLanguages = [constants.CellLanguageIdentifier];
        controller.supportsExecutionOrder = true;
        this.disposables.push(controller.onDidReceiveMessage(e => {
            const notebookUri = e.editor.notebook.uri;
            const notebookUriString = notebookUri.toString();

            if (e.message.envelope) {
                let messageHandler = this.uriMessageHandlerMap.get(notebookUriString);
                if (isKernelEventEnvelopeModel(e.message.envelope)) {
                    const event = commandsAndEvents.KernelEventEnvelope.fromJson(e.message.envelope);
                    messageHandler?.next(event);
                } else if (isKernelCommandEnvelopeModel(e.message.envelope)) {
                    const command = commandsAndEvents.KernelCommandEnvelope.fromJson(e.message.envelope);
                    messageHandler?.next(command);
                }
            }

            switch (e.message.preloadCommand) {
                case '#!connect':
                    this.config.clientMapper.getOrAddClient(notebookUri).then(() => {
                        const hostUri = e.message.hostUri;
                        vscodeNotebookManagement.hashBangConnect(this.config.clientMapper, hostUri, e.message.kernelInfos as commandsAndEvents.KernelInfo[], this.uriMessageHandlerMap,
                            (arg) => {
                                controller.postMessage({ ...arg, webViewId: e.message.webViewId });
                            },
                            notebookUri);
                        this.config.clientMapper.getOrAddClient(notebookUri).then(client => {
                            const kernelInfos = client.kernelHost.getKernelInfos();
                            controller.postMessage({ webViewId: e.message.webViewId, preloadCommand: "#!connect", kernelInfos });
                        });
                    });
                    break;
            }

            if (e.message.logEntry) {
                Logger.default.write(e.message.logEntry as LogEntry);
            }
        }));
        this.disposables.push(controller);
    }

    private async executeHandler(cells: vscode.NotebookCell[], document: vscode.NotebookDocument, controller: vscode.NotebookController): Promise<void> {
        for (const cell of cells) {
            await this.executeCell(cell, controller);
        }
    }

    private async executeCell(cell: vscode.NotebookCell, controller: vscode.NotebookController): Promise<void> {
        const executionTask = controller.createNotebookCellExecution(cell);
        if (executionTask) {
            executionTasks.set(cell.document.uri.toString(), executionTask);
            let outputUpdatePromise = Promise.resolve();
            try {
                const startTime = Date.now();
                executionTask.start(startTime);
                executionTask.executionOrder = undefined;
                await executionTask.clearOutput(cell);

                const outputObserver = (output: vscodeLike.NotebookCellOutput) => {
                    outputUpdatePromise = outputUpdatePromise.catch(ex => {
                        Logger.default.error(`Failed to update output: ${ex}`);
                    }).finally(() => this.applyCellOutput(executionTask, output).catch(ex => {
                        Logger.default.error(`Failed to update output: ${ex}`);
                    }));
                };

                const client = await this.config.clientMapper.getOrAddClient(cell.notebook.uri);
                executionTask.token.onCancellationRequested(() => {
                    client.cancel().catch(async err => {
                        // command failed to cancel
                        const cancelFailureMessage = typeof err?.message === 'string' ? err.message as string : '' + err;
                        const errorOutput = new vscode.NotebookCellOutput(this.config.createErrorOutput(cancelFailureMessage).items.map(oi => generateVsCodeNotebookCellOutputItem(oi.data, oi.mime, oi.stream)));
                        await executionTask.appendOutput(errorOutput);
                    });
                });
                const source = cell.document.getText();
                const diagnosticCollection = diagnostics.getDiagnosticCollection(cell.document.uri);

                function diagnosticObserver(diags: Array<commandsAndEvents.Diagnostic>) {
                    diagnosticCollection.set(cell.document.uri, diags.filter(d => d.severity !== commandsAndEvents.DiagnosticSeverity.Hidden).map(vscodeUtilities.toVsCodeDiagnostic));
                }

                return client.execute(
                    source,
                    { kernelName: vscodeUtilities.getCellKernelName(cell), index: cell.index },
                    outputObserver,
                    diagnosticObserver,
                    { id: cell.document.uri.toString() })
                    .then(async (success) => {
                        await outputUpdatePromise;

                        const isIpynb = metadataUtilities.isIpynbNotebook(cell.notebook);
                        const notebookDocumentMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(cell.notebook);
                        const kernelNotebookMetadata = metadataUtilities.getNotebookDocumentMetadataFromCompositeKernel(client.kernel);
                        const mergedMetadata = metadataUtilities.mergeNotebookDocumentMetadata(notebookDocumentMetadata, kernelNotebookMetadata);
                        const rawNotebookDocumentMetadata = metadataUtilities.getMergedRawNotebookDocumentMetadataFromNotebookDocumentMetadata(mergedMetadata, cell.notebook.metadata, isIpynb);

                        await vscodeNotebookManagement.updateNotebookMetadata(cell.notebook.uri, rawNotebookDocumentMetadata);
                        endExecution(client, cell, success);
                    }).catch(async () => {
                        await outputUpdatePromise;
                        endExecution(client, cell, false);
                    });
            } catch (err) {
                const errorOutput = new vscode.NotebookCellOutput(this.config.createErrorOutput(`Error executing cell: ${err}`).items.map(oi => generateVsCodeNotebookCellOutputItem(oi.data, oi.mime, oi.stream)));
                await executionTask.appendOutput(errorOutput);
                await outputUpdatePromise;
                endExecution(undefined, cell, false);
                throw err;
            }
        }
    }

    private async applyCellOutput(executionTask: vscode.NotebookCellExecution, output: vscodeLike.NotebookCellOutput): Promise<void> {
        const streamMimetypes = new Set([standardOutputMimeType, standardErrorMimeType]);

        // ensure we're tracking output ids
        const cell = executionTask.cell;
        const trackedOutputs = this.trackedOutputIds.get(cell.notebook.uri) ?? new Set<string>();
        this.trackedOutputIds.set(cell.notebook.uri, trackedOutputs);

        if (trackedOutputs.has(output.id)) {
            // if already tracking this output, build a new collection and update them all
            const newOutputs = cell.outputs.map(o => {
                if (o.metadata?.id === output.id) {
                    return generateVsCodeNotebookCellOutput(output);
                } else {
                    return o;
                }
            });

            await executionTask.replaceOutput(newOutputs);
        } else {
            // if the very last output item is stdout/stderr, append to it's parent
            let appendItems = false;
            if (cell.outputs.length > 0 && output.items.length === 1) {
                const lastOutput = cell.outputs[cell.outputs.length - 1];
                if (lastOutput.items.length > 0) {
                    const lastOutputItem = lastOutput.items[lastOutput.items.length - 1];
                    const vsCodeMimeType = getVsCodeMimeTypeFromStreamType(output.items[0].stream);
                    if (streamMimetypes.has(lastOutputItem.mime) && lastOutputItem.mime === vsCodeMimeType) {
                        // last mime type matches the incomming one; append the items
                        appendItems = true;
                    }
                }
            }

            const outputItems = output.items.map(i => generateVsCodeNotebookCellOutputItem(i.data, i.mime, i.stream));
            if (appendItems) {
                const lastOutput = cell.outputs[cell.outputs.length - 1];
                await executionTask.appendOutputItems(outputItems, lastOutput);
            } else {
                // couldn't append to last output item, so just create a new output and track it
                const newOutput = createVsCodeNotebookCellOutput(outputItems, output.id);
                trackedOutputs.add(output.id);
                await executionTask.appendOutput(newOutput);
            }
        }
    }
}

// When a new notebook cell is discovered via `onDidOpenTextDocument` and if the cell metadata doesn't have a kernel name,
// we need to know what value to use.  If we've never seen the notebook before, then the user opened a new one and the correct
// kernel is the notebook's default.  If we _have_ seen the notebook before, then the user added a new cell and we need to
// look at the previous cell's metadata to determine the correct kernel name.
const openedNotebooks = new Set<string>();
function markNotebookAsOpened(notebook: vscode.NotebookDocument) {
    openedNotebooks.add(notebook.uri.fsPath);
}

function isNotebookOpenComplete(notebook: vscode.NotebookDocument) {
    return openedNotebooks.has(notebook.uri.fsPath);
}

function stopTrackingNotebook(notebook: vscode.NotebookDocument) {
    openedNotebooks.delete(notebook.uri.fsPath);
    // Clear SQL connection state so reopening the notebook will reconnect properly
    sqlConnectionTracker.clearConnection(notebook.uri.toString());
}

async function ensureCellKernelMetadata(cell: vscode.NotebookCell, options: { preferPreviousCellMetadata: boolean }): Promise<void> {

    // markdown cells should not have metadata, so if we find it, remove it.
    if (cell.document.languageId === 'markdown') {
        const existingCellMetadata = metadataUtilities.getCellMetadata(cell);
        if (existingCellMetadata?.polyglot_notebook || existingCellMetadata?.dotnet_interactive) {
            const updatedCellMetadata = { ...cell.metadata };
            delete updatedCellMetadata.dotnet_interactive;
            delete updatedCellMetadata.polyglot_notebook;
            await vscodeNotebookManagement.updateNotebookCellMetadata(cell.notebook.uri, cell.index, updatedCellMetadata);
        }
        return;
    }

    // if we found the cell ensure it has kernel metadata
    const cellMetadata = metadataUtilities.getNotebookCellMetadataFromNotebookCellElement(cell);
    if (!cellMetadata.kernelName) {
        // no kernel name found; if asked, set from previous cell, otherwise set it from the notebook metadata
        let kernelNameToSet: string | undefined = undefined;
        if (options.preferPreviousCellMetadata && cell.index > 0) {
            const previousCell = cell.notebook.cellAt(cell.index - 1);
            const previousCellMetadata = metadataUtilities.getNotebookCellMetadataFromNotebookCellElement(previousCell);
            kernelNameToSet = previousCellMetadata.kernelName;
        }

        if (!kernelNameToSet) {
            // couldn't get it from the previous cell, or we weren't supposed to
            const notebookMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(cell.notebook);
            kernelNameToSet = notebookMetadata.kernelInfo.defaultKernelName;
        }

        await vscodeUtilities.setCellKernelName(cell, kernelNameToSet);
    }
}

function getVsCodeMimeTypeFromStreamType(stream: string | undefined): string | undefined {
    switch (stream) {
        case 'stdout':
            return standardOutputMimeType;
        case 'stderr':
            return standardErrorMimeType;
        default:
            return undefined;
    }
}

async function updateNotebookMetadata(notebook: vscode.NotebookDocument, clientMapper: ClientMapper): Promise<void> {
    try {
        // update various metadata
        await updateDocumentKernelspecMetadata(notebook);

        for (let cell of notebook.getCells()) {
            await vscodeUtilities.ensureCellLanguageId(cell);

            // the previous call might have replaced the cell in the notebook, so we need to fetch it again to make sure it's fresh
            cell = notebook.cellAt(cell.index);
            await ensureCellKernelMetadata(cell, { preferPreviousCellMetadata: false });
        }

        markNotebookAsOpened(notebook);

        // force creation of the client so we don't have to wait for the user to execute a cell to get the tool
        const client = await clientMapper.getOrAddClient(notebook.uri);

        await updateKernelInfoMetadata(client, notebook);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to set document metadata for '${notebook.uri}': ${err}`);
    }
}

async function updateKernelInfoMetadata(client: InteractiveClient, document: vscode.NotebookDocument): Promise<void> {
    const isIpynb = metadataUtilities.isIpynbNotebook(document);
    client.channel.receiver.subscribe({
        next: async (commandOrEventEnvelope) => {
            if (isKernelEventEnvelope(commandOrEventEnvelope) && commandOrEventEnvelope.eventType === commandsAndEvents.KernelInfoProducedType) {
                // got info about a kernel; either update an existing entry, or add a new one
                let metadataChanged = false;
                const kernelInfoProduced = commandOrEventEnvelope.event as commandsAndEvents.KernelInfoProduced;
                const notebookMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(document);
                for (const item of notebookMetadata.kernelInfo.items) {
                    if (item.name === kernelInfoProduced.kernelInfo.localName) {
                        metadataChanged = true;
                        if (kernelInfoProduced.kernelInfo.languageName) {
                            item.languageName = kernelInfoProduced.kernelInfo.languageName;
                        }
                        item.aliases = kernelInfoProduced.kernelInfo.aliases;
                    }
                }

                if (!metadataChanged) {
                    if (kernelInfoProduced.kernelInfo.supportedKernelCommands.find(ci => ci.name === commandsAndEvents.SubmitCodeType)) {
                        const kernelInfo: commandsAndEvents.DocumentKernelInfo = {
                            name: kernelInfoProduced.kernelInfo.localName,
                            aliases: kernelInfoProduced.kernelInfo.aliases
                        };
                        if (kernelInfoProduced.kernelInfo.languageName !== undefined && kernelInfoProduced.kernelInfo.languageName !== null) {
                            kernelInfo.languageName = kernelInfoProduced.kernelInfo.languageName;
                        }
                        // nothing changed, must be a new kernel
                        notebookMetadata.kernelInfo.items.push(kernelInfo);
                    }
                }

                const existingRawNotebookDocumentMetadata = document.metadata;
                const updatedRawNotebookDocumentMetadata = metadataUtilities.getMergedRawNotebookDocumentMetadataFromNotebookDocumentMetadata(notebookMetadata, existingRawNotebookDocumentMetadata, isIpynb);
                const newRawNotebookDocumentMetadata = metadataUtilities.mergeRawMetadata(existingRawNotebookDocumentMetadata, updatedRawNotebookDocumentMetadata);
                await vscodeNotebookManagement.updateNotebookMetadata(document.uri, newRawNotebookDocumentMetadata);
            }
        }
    });

    if (isIpynb &&
        !document.metadata.metadata.language_info) {
        document.metadata.metadata.language_info = { name: "polyglot-notebook" };
    }
}

export function endExecution(client: InteractiveClient | undefined, cell: vscode.NotebookCell, success: boolean) {
    const key = cell.document.uri.toString();
    const executionTask = executionTasks.get(key);
    if (executionTask) {
        executionTasks.delete(key);
        executionTask.executionOrder = client?.getNextExecutionCount();
        const endTime = Date.now();
        executionTask.end(success, endTime);
    }
}

function createVsCodeNotebookCellOutput(outputItems: vscode.NotebookCellOutputItem[], id: string): vscode.NotebookCellOutput {
    return new vscode.NotebookCellOutput(outputItems, { id });
}

function generateVsCodeNotebookCellOutput(output: vscodeLike.NotebookCellOutput): vscode.NotebookCellOutput {
    const items = output.items.map(i => generateVsCodeNotebookCellOutputItem(i.data, i.mime, i.stream));
    return createVsCodeNotebookCellOutput(items, output.id);
}

function generateVsCodeNotebookCellOutputItem(data: Uint8Array, mime: string, stream: 'stdout' | 'stderr' | undefined): vscode.NotebookCellOutputItem {
    const displayData = reshapeOutputValueForVsCode(data, mime);
    switch (stream) {
        case 'stdout':
            return vscode.NotebookCellOutputItem.stdout(new TextDecoder().decode(displayData));
        case 'stderr':
            return vscode.NotebookCellOutputItem.stderr(new TextDecoder().decode(displayData));
        default:
            return new vscode.NotebookCellOutputItem(displayData, mime);
    }
}

async function updateDocumentKernelspecMetadata(document: vscode.NotebookDocument): Promise<void> {
    const newMetadata: { [key: string]: any } = { ...document.metadata };
    await vscodeNotebookManagement.updateNotebookMetadata(document.uri, newMetadata);
}
