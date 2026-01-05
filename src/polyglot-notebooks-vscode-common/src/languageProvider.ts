// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import { ClientMapper } from './clientMapper';
import { provideCompletion } from './languageServices/completion';
import { provideHover } from '././languageServices/hover';
import { notebookCellChanged } from './interactiveNotebook';
import { convertToRange, getCellKernelName, toVsCodeDiagnostic } from './vscodeUtilities';
import { getDiagnosticCollection } from './diagnostics';
import { provideSignatureHelp } from './languageServices/signatureHelp';
import * as vscodeNotebookManagement from './vscodeNotebookManagement';
import * as constants from './constants';
import * as metadataUtilities from './metadataUtilities';
import * as sqlConnectionTracker from './sqlConnectionTracker';

function getNotebookDcoumentFromCellDocument(cellDocument: vscode.TextDocument): vscode.NotebookDocument | undefined {
    const notebookDocument = vscode.workspace.notebookDocuments.find(notebook => notebook.getCells().some(cell => cell.document === cellDocument));
    return notebookDocument;
}

function getCellFromCellDocument(notebookDocument: vscode.NotebookDocument, cellDocument: vscode.TextDocument): vscode.NotebookCell | undefined {
    return notebookDocument.getCells().find(cell => cell.document === cellDocument);
}

export class CompletionItemProvider implements vscode.CompletionItemProvider {
    static readonly triggerCharacters = ['.'];

    constructor(readonly clientMapper: ClientMapper, private languageServiceDelay: number) {
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const notebookDocument = getNotebookDcoumentFromCellDocument(document);
        if (notebookDocument) {
            const cell = getCellFromCellDocument(notebookDocument, document);
            if (cell) {
                const kernelName = getCellKernelName(cell);
                const documentText = document.getText();
                
                // Check if this is an MSSQL proxy kernel - route to MSSQL extension for completions
                // Only intercept if it's a proxy connection (has connectionId in metadata)
                if (metadataUtilities.isMssqlProxyKernel(kernelName)) {
                    const isProxyKernel = this.isSqlProxyKernel(notebookDocument, kernelName);
                    if (isProxyKernel) {
                        return this.provideSqlCompletions(notebookDocument, cell, kernelName, documentText, position);
                    }
                }
                
                const completionPromise = provideCompletion(this.clientMapper, kernelName, notebookDocument.uri, documentText, position, this.languageServiceDelay);
                return ensureErrorsAreRejected(completionPromise, result => {
                    let range: vscode.Range | undefined = undefined;
                    if (result.linePositionSpan) {
                        range = new vscode.Range(
                            new vscode.Position(result.linePositionSpan.start.line, result.linePositionSpan.start.character),
                            new vscode.Position(result.linePositionSpan.end.line, result.linePositionSpan.end.character));
                    }
                    const completionItems: Array<vscode.CompletionItem> = [];
                    for (const item of result.completions) {
                        const insertText: string | vscode.SnippetString = item.insertTextFormat === 'snippet' ? new vscode.SnippetString(item.insertText) : item.insertText;
                        const vscodeItem: vscode.CompletionItem = {
                            label: item.displayText,
                            documentation: item.documentation,
                            filterText: item.filterText,
                            insertText: insertText,
                            sortText: item.sortText,
                            range: range,
                            kind: this.mapCompletionItem(item.kind)
                        };
                        completionItems.push(vscodeItem);
                    }

                    const completionList = new vscode.CompletionList(completionItems, false);
                    return completionList;
                });
            }
        }
    }
    
    private isSqlProxyKernel(notebookDocument: vscode.NotebookDocument, kernelName: string): boolean {
        // Only cell-level MSSQL kernels (mssql-*) are supported as proxy kernels
        if (!metadataUtilities.isMssqlProxyKernel(kernelName)) {
            return false;
        }
        
        // Check if kernel has connectionId in metadata
        const notebookMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(notebookDocument);
        const connectionId = metadataUtilities.getKernelConnectionId(notebookMetadata, kernelName);
        return !!connectionId;
    }
    
    private async connectForCompletions(notebookDocument: vscode.NotebookDocument, kernelName: string): Promise<string | undefined> {
        // Ensure MSSQL extension is activated
        const mssqlExtension = vscode.extensions.getExtension('ms-mssql.mssql');
        if (!mssqlExtension) {
            return undefined;
        }
        if (!mssqlExtension.isActive) {
            await mssqlExtension.activate();
        }
        
        const notebookMetadata = metadataUtilities.getNotebookDocumentMetadataFromNotebookDocument(notebookDocument);
        const connectionId = metadataUtilities.getKernelConnectionId(notebookMetadata, kernelName);
        if (!connectionId) {
            return undefined;
        }
        
        const connectionUri = await vscode.commands.executeCommand<string>(
            'mssql.connectionSharing.connect',
            'ms-dotnetinteractive.polyglot-notebooks',
            connectionId
        );
        
        if (connectionUri) {
            // Cache it
            sqlConnectionTracker.setKernelConnection(kernelName, connectionId, connectionUri);
        }
        
        return connectionUri;
    }
    
    private async provideSqlCompletions(
        notebookDocument: vscode.NotebookDocument,
        cell: vscode.NotebookCell,
        kernelName: string,
        documentText: string,
        position: vscode.Position
    ): Promise<vscode.CompletionList | undefined> {
        try {
            // Only cell-level MSSQL kernels (mssql-*) are supported
            if (!metadataUtilities.isMssqlProxyKernel(kernelName)) {
                return undefined;
            }
            
            // Get connection URI for this kernel - try cached first
            let connectionUri: string | undefined = sqlConnectionTracker.getProxyConnectionUriForKernel(kernelName);
            
            // If no cached URI, we need to connect
            if (!connectionUri) {
                // Check if there's already a pending connection to avoid race conditions
                const pendingConnection = sqlConnectionTracker.getPendingConnection(kernelName);
                if (pendingConnection) {
                    // Wait for the existing connection attempt
                    connectionUri = await pendingConnection;
                } else {
                    // Start a new connection attempt
                    const connectionPromise = this.connectForCompletions(notebookDocument, kernelName);
                    sqlConnectionTracker.setPendingConnection(kernelName, connectionPromise);
                    try {
                        connectionUri = await connectionPromise;
                    } finally {
                        sqlConnectionTracker.clearPendingConnection(kernelName);
                    }
                }
            }
            
            if (!connectionUri) {
                return undefined;
            }
            
            // Call MSSQL extension for completions
            const mssqlCompletions = await vscode.commands.executeCommand<any[]>(
                'mssql.connectionSharing.getCompletions',
                connectionUri,
                documentText,
                position.line,
                position.character
            );
            
            if (!mssqlCompletions || mssqlCompletions.length === 0) {
                return undefined;
            }
            
            // Map MSSQL completions to VS Code completions
            const completionItems: vscode.CompletionItem[] = mssqlCompletions.map((item: any) => {
                const completionItem = new vscode.CompletionItem(item.label, item.kind !== undefined ? item.kind : vscode.CompletionItemKind.Text);
                completionItem.detail = item.detail;
                completionItem.documentation = item.documentation;
                completionItem.insertText = item.insertText || item.label;
                completionItem.filterText = item.filterText;
                completionItem.sortText = item.sortText;
                return completionItem;
            });
            
            return new vscode.CompletionList(completionItems, false);
        } catch (e: any) {
            // Silently fail - fall back to no completions
            return undefined;
        }
    }

    private mapCompletionItem(completionItemText: string): vscode.CompletionItemKind {
        // incomplete mapping from http://sourceroslyn.io/#Microsoft.CodeAnalysis.Workspaces/Tags/WellKnownTags.cs
        switch (completionItemText) {
            case "Class": return vscode.CompletionItemKind.Class;
            case "Constant": return vscode.CompletionItemKind.Constant;
            case "Delegate": return vscode.CompletionItemKind.Function;
            case "Enum": return vscode.CompletionItemKind.Enum;
            case "EnumMember": return vscode.CompletionItemKind.EnumMember;
            case "Event": return vscode.CompletionItemKind.Event;
            case "ExtensionMethod": return vscode.CompletionItemKind.Method;
            case "Field": return vscode.CompletionItemKind.Field;
            case "Interface": return vscode.CompletionItemKind.Interface;
            case "Local": return vscode.CompletionItemKind.Variable;
            case "Method": return vscode.CompletionItemKind.Method;
            case "Module": return vscode.CompletionItemKind.Module;
            case "Namespace": return vscode.CompletionItemKind.Module;
            case "Property": return vscode.CompletionItemKind.Property;
            case "Structure": return vscode.CompletionItemKind.Struct;
            case "Value": return vscode.CompletionItemKind.Value;
            default: return vscode.CompletionItemKind.Value; // what's an appropriate default?
        }
    }
}

export class HoverProvider implements vscode.HoverProvider {
    constructor(readonly clientMapper: ClientMapper, private languageServiceDelay: number) {
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {

        const notebookDocument = getNotebookDcoumentFromCellDocument(document);
        if (notebookDocument) {
            const cell = getCellFromCellDocument(notebookDocument, document);
            if (cell) {
                const kernelName = getCellKernelName(cell);
                const documentText = document.getText();
                const hoverPromise = provideHover(this.clientMapper, kernelName, notebookDocument.uri, documentText, position, this.languageServiceDelay);
                return ensureErrorsAreRejected(hoverPromise, result => {
                    // Return undefined if no hover content (e.g., from proxy kernels)
                    if (!result.contents || result.contents.length === 0) {
                        return undefined;
                    }
                    const contents = result.isMarkdown
                        ? new vscode.MarkdownString(result.contents)
                        : result.contents;
                    const hover = new vscode.Hover(contents, convertToRange(result.range));
                    return hover;
                });
            }
        }
    }
}

export class SignatureHelpProvider implements vscode.SignatureHelpProvider {
    static readonly triggerCharacters = ['(', ','];

    constructor(readonly clientMapper: ClientMapper, private languageServiceDelay: number) {
    }

    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): vscode.ProviderResult<vscode.SignatureHelp> {
        const notebookDocument = getNotebookDcoumentFromCellDocument(document);
        if (notebookDocument) {
            const cell = getCellFromCellDocument(notebookDocument, document);
            if (cell) {
                const kernelName = getCellKernelName(cell);
                const documentText = document.getText();
                const sigHelpPromise = provideSignatureHelp(this.clientMapper, kernelName, notebookDocument.uri, documentText, position, this.languageServiceDelay);
                return ensureErrorsAreRejected(sigHelpPromise, result => {
                    const signatures: Array<vscode.SignatureInformation> = result.signatures.map(sig => {
                        const parameters: Array<vscode.ParameterInformation> = sig.parameters.map(p => new vscode.ParameterInformation(p.label, p.documentation.value));
                        let si = new vscode.SignatureInformation(
                            sig.label,
                            sig.documentation.value
                        );
                        si.parameters = parameters;
                        return si;
                    });
                    let sh = new vscode.SignatureHelp();
                    sh.signatures = signatures;
                    sh.activeSignature = result.activeSignatureIndex;
                    sh.activeParameter = result.activeParameterIndex;
                    return sh;
                });
            }
        }
    }
}

function ensureErrorsAreRejected<TInterimResult, TFinalResult>(promise: Promise<TInterimResult>, successHandler: { (result: TInterimResult): TFinalResult }): Promise<TFinalResult> {
    return new Promise<TFinalResult>((resolve, reject) => {
        promise.then(interimResult => {
            const finalResult = successHandler(interimResult);
            resolve(finalResult);
        }).catch(err => {
            reject(err);
        });
    });
}

export async function registerLanguageProviders(clientMapper: ClientMapper, languageServiceDelay: number): Promise<vscode.Disposable> {
    const disposables: Array<vscode.Disposable> = [];

    const languages = [constants.CellLanguageIdentifier];
    disposables.push(vscode.languages.registerCompletionItemProvider(languages, new CompletionItemProvider(clientMapper, languageServiceDelay), ...CompletionItemProvider.triggerCharacters));
    disposables.push(vscode.languages.registerHoverProvider(languages, new HoverProvider(clientMapper, languageServiceDelay)));
    disposables.push(vscode.languages.registerSignatureHelpProvider(languages, new SignatureHelpProvider(clientMapper, languageServiceDelay), ...SignatureHelpProvider.triggerCharacters));
    disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === constants.CellLanguageIdentifier && vscode.window.activeNotebookEditor) {
            const notebookDocument = vscode.window.activeNotebookEditor.notebook;
            const cells = notebookDocument.getCells();
            const cell = cells?.find(cell => cell.document === e.document);
            if (cell) {
                const kernelName = getCellKernelName(cell);
                notebookCellChanged(clientMapper, notebookDocument.uri, e.document.getText(), kernelName, languageServiceDelay, diagnostics => {
                    const collection = getDiagnosticCollection(e.document.uri);
                    collection.set(e.document.uri, diagnostics.map(toVsCodeDiagnostic));
                });
            }
        }
    }));

    return vscode.Disposable.from(...disposables);
}
