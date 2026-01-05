// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import { CompositeKernel } from './polyglot-notebooks';
import * as commandsAndEvents from './polyglot-notebooks/commandsAndEvents';
import * as vscodeLike from './interfaces/vscode-like';

export interface NotebookDocumentMetadata {
    kernelInfo: commandsAndEvents.DocumentKernelInfoCollection;
}

export interface NotebookCellMetadata {
    kernelName?: string;
}

export interface KernelspecMetadata {
    display_name: string;
    language: string;
    name: string;
}

export function isIpynbNotebook(notebookDocument: vscodeLike.NotebookDocument) {
    return notebookDocument.uri.fsPath.toLowerCase().endsWith('.ipynb');
}

export function isDotNetNotebook(notebook: vscodeLike.NotebookDocument): boolean {
    const notebookUriString = notebook.uri.toString();
    if (notebookUriString.endsWith('.dib') || notebook.uri.fsPath.endsWith('.dib')) {
        return true;
    }

    const kernelspecMetadata = getKernelspecMetadataFromIpynbNotebookDocument(notebook);
    if (kernelspecMetadata.name.startsWith('.net-')) {
        return true;
    }

    // Also recognize SQL notebooks (ADS-style)
    if (kernelspecMetadata.name.toLowerCase() === 'sql' || kernelspecMetadata.language?.toLowerCase() === 'sql') {
        return true;
    }

    // doesn't look like us
    return false;
}

export function isSqlNotebook(notebook: vscodeLike.NotebookDocument): boolean {
    // Check for legacy ADS-style SQL notebooks (kernelspec name/language is 'sql')
    // Also check for .net-sql kernelspec (new Polyglot SQL notebooks)
    const kernelspecMetadata = getKernelspecMetadataFromIpynbNotebookDocument(notebook);
    const ksName = kernelspecMetadata.name.toLowerCase();
    const ksLang = kernelspecMetadata.language?.toLowerCase();
    if (ksName === 'sql' || ksName === '.net-sql' || ksLang === 'sql') {
        return true;
    }
    
    // Check for Polyglot notebooks with SQL as default kernel
    const fileMetadata = notebook.metadata?.metadata || {};
    const directMetadata = notebook.metadata || {};
    
    // Check polyglot_notebook.kernelInfo.defaultKernelName in file metadata (ipynb)
    const polyglotFile = fileMetadata.polyglot_notebook;
    if (polyglotFile?.kernelInfo?.defaultKernelName?.toLowerCase() === 'sql') {
        return true;
    }
    
    // Check polyglot_notebook.kernelInfo.defaultKernelName in direct metadata
    const polyglotDirect = directMetadata.polyglot_notebook;
    if (polyglotDirect?.kernelInfo?.defaultKernelName?.toLowerCase() === 'sql') {
        return true;
    }
    
    return false;
}

export interface SqlConnectionMetadata {
    connectionId?: string;
    connectionName?: string;
    connectionProfileName?: string;
    /** If true, use MSSQL proxy mode (no credentials exposed to Polyglot) */
    proxyMode?: boolean;
}

export function getSqlConnectionMetadataFromNotebookDocument(notebook: vscodeLike.NotebookDocument): SqlConnectionMetadata {
    // For .ipynb files, VS Code nests the file's metadata under notebook.metadata.metadata
    // For .dib files, metadata is directly on notebook.metadata
    const fileMetadata = notebook.metadata?.metadata || {};
    const directMetadata = notebook.metadata || {};
    
    // Check for ADS-style connection metadata (in file metadata)
    const azdata_connection = fileMetadata.azdata_connection;
    if (typeof azdata_connection === 'object') {
        return {
            connectionId: azdata_connection.connectionId,
            connectionName: azdata_connection.connectionName,
            connectionProfileName: azdata_connection.connectionProfileName
        };
    }
    
    // Check for polyglot_notebook SQL connection in file metadata (ipynb)
    const polyglot_notebook_file = fileMetadata.polyglot_notebook || {};
    if (polyglot_notebook_file.sqlConnection) {
        return {
            connectionId: polyglot_notebook_file.sqlConnection.connectionId,
            connectionName: polyglot_notebook_file.sqlConnection.connectionName,
            connectionProfileName: polyglot_notebook_file.sqlConnection.connectionProfileName,
            proxyMode: polyglot_notebook_file.sqlConnection.proxyMode
        };
    }
    
    // Check for polyglot_notebook SQL connection in direct metadata (dib)
    const polyglot_notebook_direct = directMetadata.polyglot_notebook || {};
    if (polyglot_notebook_direct.sqlConnection) {
        return {
            connectionId: polyglot_notebook_direct.sqlConnection.connectionId,
            connectionName: polyglot_notebook_direct.sqlConnection.connectionName,
            connectionProfileName: polyglot_notebook_direct.sqlConnection.connectionProfileName,
            proxyMode: polyglot_notebook_direct.sqlConnection.proxyMode
        };
    }
    
    return {};
}

export function createSqlConnectionMetadata(connectionId: string | undefined, connectionName: string, connectionProfileName: string): { [key: string]: any } {
    return {
        polyglot_notebook: {
            sqlConnection: {
                connectionId,
                connectionName,
                connectionProfileName
            }
        }
    };
}

export function mergeSqlConnectionMetadataIntoNotebookMetadata(
    existingMetadata: { [key: string]: any },
    sqlConnectionMetadata: SqlConnectionMetadata
): { [key: string]: any } {
    const result = { ...existingMetadata };
    
    // For ipynb files, metadata is nested under 'metadata'
    if (result.metadata) {
        result.metadata = {
            ...result.metadata,
            polyglot_notebook: {
                ...(result.metadata.polyglot_notebook || {}),
                sqlConnection: sqlConnectionMetadata
            }
        };
    } else {
        // For dib files, metadata is at the root
        result.polyglot_notebook = {
            ...(result.polyglot_notebook || {}),
            sqlConnection: sqlConnectionMetadata
        };
    }
    
    return result;
}

export function getNotebookCellMetadataFromInteractiveDocumentElement(interactiveDocumentElement: commandsAndEvents.InteractiveDocumentElement): NotebookCellMetadata {
    const cellMetadata: NotebookCellMetadata = {};

    // first try to get the old `dotnet_interactive` value...
    const dotnet_interactive = interactiveDocumentElement.metadata?.dotnet_interactive;
    if (typeof dotnet_interactive === 'object') {
        const language = dotnet_interactive.language;
        if (typeof language === 'string') {
            // this is a really unfortunate case where we were storing the kernel name, but calling it the language
            cellMetadata.kernelName = language;
        }
    }

    // ...then try newer `polyglot_notebook` value
    const polyglot_notebook = interactiveDocumentElement.metadata?.polyglot_notebook;
    if (typeof polyglot_notebook === 'object') {
        const kernelName = polyglot_notebook.kernelName;
        if (typeof kernelName === 'string') {
            cellMetadata.kernelName = kernelName;
        }
    }

    return cellMetadata;
}

export function getNotebookCellMetadataFromNotebookCellElement(notebookCell: vscodeLike.NotebookCell): NotebookCellMetadata {
    const cellMetadata: NotebookCellMetadata = {};

    const metadata = getCellMetadata(notebookCell);

    if (typeof metadata === 'object') {
        // first try to get the old `dotnet_interactive` value...
        const dotnet_interactive = metadata.dotnet_interactive;
        if (typeof dotnet_interactive === 'object') {
            const language = dotnet_interactive.language;
            if (typeof language === 'string') {
                // this is a really unfortunate case where we were storing the kernel name, but calling it the language
                cellMetadata.kernelName = language;
            }
        }

        // ...then try newer `polyglot_notebook` value
        const polyglot_notebook = metadata.polyglot_notebook;
        if (typeof polyglot_notebook === 'object') {
            const kernelName = polyglot_notebook.kernelName;
            if (typeof kernelName === 'string') {
                cellMetadata.kernelName = kernelName;
            }
        }
    }

    return cellMetadata;
}

export function getNotebookDocumentMetadataFromInteractiveDocument(interactiveDocument: commandsAndEvents.InteractiveDocument): NotebookDocumentMetadata {
    const notebookMetadata = createDefaultNotebookDocumentMetadata();
    const kernelInfo = interactiveDocument.metadata?.kernelInfo || interactiveDocument.metadata.polyglot_notebook?.kernelInfo;
    if (typeof kernelInfo === 'object') {
        if (typeof kernelInfo.defaultKernelName === 'string') {
            notebookMetadata.kernelInfo.defaultKernelName = kernelInfo.defaultKernelName;
        }

        const items = kernelInfo.items;
        if (Array.isArray(items) && items.every(item => typeof item === 'object')) {
            notebookMetadata.kernelInfo.items = items;
        }
    }

    notebookMetadata.kernelInfo.items = notebookMetadata.kernelInfo.items.map(item => ensureProperShapeForDocumentKernelInfo(item));
    cleanUpMetadata(notebookMetadata);
    return notebookMetadata;
}

export function getCellMetadata(cell: vscodeLike.NotebookCell) {
    return cell.metadata?.metadata || {};
}

export function getDocumentMetadata(document: vscodeLike.NotebookDocument) {
    const ipynbMetadata = document.metadata?.metadata?.polyglot_notebook ?? {};
    const polyglot_notebook = document.metadata.polyglot_notebook ?? {};

    const merged = { ...ipynbMetadata, ...polyglot_notebook };

    return merged;
}

export function getNotebookDocumentMetadataFromNotebookDocument(document: vscodeLike.NotebookDocument): NotebookDocumentMetadata {
    const notebookMetadata = createDefaultNotebookDocumentMetadata();
    let setDefaultKernel = false;
    let setItems = false;

    // .dib files will have their metadata at the root; .ipynb files will have their metadata a little deeper
    const polyglot_notebook = getDocumentMetadata(document);

    if (typeof polyglot_notebook === 'object') {
        const kernelInfo = polyglot_notebook.kernelInfo;
        if (typeof kernelInfo === 'object') {
            if (typeof kernelInfo.defaultKernelName === 'string') {
                notebookMetadata.kernelInfo.defaultKernelName = kernelInfo.defaultKernelName;
                setDefaultKernel = true;
            }

            const items = kernelInfo.items;
            if (Array.isArray(items) && items.every(item => typeof item === 'object')) {
                notebookMetadata.kernelInfo.items = items;
                setItems = true;
            }
        }
    }

    // if nothing was found, populate it from the kernelspec metadata
    if (isIpynbNotebook(document)) {
        if (!setDefaultKernel) {
            const kernelSpecMetadata = getKernelspecMetadataFromIpynbNotebookDocument(document);
            if (kernelSpecMetadata.name.startsWith('.net-')) {
                // the command `dotnet interactive jupyter install` lays down 3 well-known kernelspecs, all with the name `.net-<kernelName>`
                notebookMetadata.kernelInfo.defaultKernelName = kernelSpecMetadata.name.substring('.net-'.length);
            }
        }

        if (!setItems) {
            notebookMetadata.kernelInfo.items = [
                {
                    name: notebookMetadata.kernelInfo.defaultKernelName,
                    aliases: [],
                }
            ];
        }
    }

    notebookMetadata.kernelInfo.items = notebookMetadata.kernelInfo.items.map(item => ensureProperShapeForDocumentKernelInfo(item));
    cleanUpMetadata(notebookMetadata);
    return notebookMetadata;
}

export function getNotebookDocumentMetadataFromCompositeKernel(kernel: CompositeKernel): NotebookDocumentMetadata {
    const notebookMetadata = createDefaultNotebookDocumentMetadata();
    notebookMetadata.kernelInfo.defaultKernelName = kernel.defaultKernelName ?? notebookMetadata.kernelInfo.defaultKernelName;
    notebookMetadata.kernelInfo.items = kernel.childKernels.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).filter(k => k.supportsCommand(commandsAndEvents.SubmitCodeType)).map(k => ({ name: k.name, aliases: k.kernelInfo.aliases, languageName: k.kernelInfo.languageName }));
    cleanUpMetadata(notebookMetadata);
    return notebookMetadata;
}

function ensureProperShapeForDocumentKernelInfo(kernelInfo: commandsAndEvents.DocumentKernelInfo) {
    if (!kernelInfo.aliases) {
        kernelInfo.aliases = [];
    }

    if (kernelInfo.languageName === undefined) {
        delete kernelInfo.languageName;
    }

    return kernelInfo;
}

export function getKernelspecMetadataFromIpynbNotebookDocument(notebook: vscodeLike.NotebookDocument): KernelspecMetadata {
    // defaulting to empty values so we don't mis-represent the document
    const kernelspecMetadata: KernelspecMetadata = {
        display_name: '',
        language: '',
        name: ''
    };

    const metadata = notebook.metadata.metadata;

    if (typeof metadata === 'object') {
        const kernelspec = metadata.kernelspec;
        if (typeof kernelspec === 'object') {
            const display_name = kernelspec.display_name;
            if (typeof display_name === 'string') {
                kernelspecMetadata.display_name = display_name;
            }

            const language = kernelspec.language;
            if (typeof language === 'string') {
                kernelspecMetadata.language = language;
            }

            const name = kernelspec.name;
            if (typeof name === 'string') {
                kernelspecMetadata.name = name;
            }
        }
    }

    return kernelspecMetadata;
}

export function getKernelInfosFromNotebookDocument(notebookDocument: vscodeLike.NotebookDocument): commandsAndEvents.KernelInfo[] {
    const notebookDocumentMetadata = getNotebookDocumentMetadataFromNotebookDocument(notebookDocument);
    const kernelInfos: commandsAndEvents.KernelInfo[] = notebookDocumentMetadata.kernelInfo.items.map(item => ({
        // these are the only important ones
        localName: item.name,
        isComposite: false,
        isProxy: false,
        aliases: item.aliases,
        languageName: item.languageName,
        // these are unused
        uri: 'unused',
        displayName: 'unused',
        supportedKernelCommands: [],
        supportedDirectives: []
    }));

    kernelInfos.forEach(ki => {
        if (ki.languageName === undefined || ki.languageName === null) {
            delete ki["languageName"];
        }
    });
    return kernelInfos;
}

export function getKernelspecMetadataFromNotebookDocumentMetadata(notebookDocumentMetadata: NotebookDocumentMetadata): KernelspecMetadata {
    // these options are hard-coded because this is exactly what we put on disk with `dotnet interactive jupyter install`
    switch (notebookDocumentMetadata.kernelInfo.defaultKernelName) {
        case 'fsharp':
            return {
                display_name: '.NET (F#)',
                language: 'F#',
                name: '.net-fsharp'
            };
        case 'pwsh':
            return {
                display_name: '.NET (PowerShell)',
                language: 'PowerShell',
                name: '.net-pwsh'
            };
        case 'sql':
            return {
                display_name: '.NET (SQL)',
                language: 'sql',
                name: '.net-sql'
            };
        case 'csharp':
        default:
            return {
                display_name: '.NET (C#)',
                language: 'C#',
                name: '.net-csharp'
            };
    }
}

export function getRawNotebookCellMetadataFromNotebookCellMetadata(notebookCellMetadata: NotebookCellMetadata): { [key: string]: any } {
    return {
        metadata: {
            polyglot_notebook: notebookCellMetadata,
            language_info: { name: "polyglot-notebook" }
        }
    };
}

export function getMergedRawNotebookDocumentMetadataFromNotebookDocumentMetadata(notebookDocumentMetadata: NotebookDocumentMetadata, documentRawMetadata: { [key: string]: any }, createForIpynb: boolean): { [key: string]: any } {
    const rawMetadata: { [key: string]: any } = {};

    if (createForIpynb) {
        const kernelspec = getKernelspecMetadataFromNotebookDocumentMetadata(notebookDocumentMetadata);

        rawMetadata.metadata = {
            kernelspec,
            polyglot_notebook: notebookDocumentMetadata,
            language_info: { name: "polyglot-notebook" }
        };
    } else {
        rawMetadata.polyglot_notebook = notebookDocumentMetadata;
    }

    sortAndMerge(rawMetadata, documentRawMetadata);
    return rawMetadata;
}

export function sortAndMerge(destination: { [key: string]: any }, source: { [key: string]: any }) {

    if (destination === null) {
        return;
    }
    if (source === null) {
        if (destination !== null) {
            sortInPlace(destination);
        }
    }
    else {
        sortInPlace(destination);
        sortInPlace(source);

        const sourceKeys = Object.keys(source);
        for (const key of sourceKeys) {
            if (destination[key] === undefined) {
                destination[key] = source[key];

            } else {
                if (source[key] !== undefined && source[key] !== null) {
                    if (Array.isArray(destination[key])) {
                        mergeArray(destination[key], source[key]);
                    } else if (typeof destination[key] === 'object') {
                        sortAndMerge(destination[key], source[key]);
                    }
                }
            }
        }
    }
}

function mergeArray(destination: any[], source: any[]) {
    for (let i = 0; i < source.length; i++) {
        let srcValue = source[i];
        if (srcValue !== null) {
            if (isKernelInfo(srcValue)) {
                const found = destination.find(e => srcValue.localName.localeCompare(e.localName) === 0);
                if (found) {
                    sortAndMerge(found, srcValue);
                } else {
                    destination.push(srcValue);
                }
            } else if (isDocumentKernelInfo(srcValue)) {
                const found = destination.find(e => srcValue.name.localeCompare(e.name) === 0);
                if (found) {
                    sortAndMerge(found, srcValue);
                } else {
                    destination.push(srcValue);
                }
            } else {
                const found = destination.find(e => e === srcValue);
                if (found) {
                    sortAndMerge(found, srcValue);
                } else {
                    destination.push(srcValue);
                }
            }
        }
    }
}

function isKernelInfo(k: any): k is commandsAndEvents.KernelInfo {
    return k.localName !== undefined;
}

function isDocumentKernelInfo(k: any): k is commandsAndEvents.DocumentKernelInfo {
    return k.name !== undefined;
}

export function sortInPlace(value: any): any {
    if (value === null) {
        return value;
    }
    else if (value === undefined) {
        return value;
    }
    else if (Array.isArray(value)) {
        if (value.length > 0) {
            for (let i = 0; i < value.length; i++) {
                value[i] = sortInPlace(value[i]);
            }
            return value.sort((a, b) => {
                if (isKernelInfo(a) && isKernelInfo(b)) {
                    return a.localName.localeCompare(b.localName);
                } else if (isDocumentKernelInfo(a) && isDocumentKernelInfo(b)) {
                    return a.name.localeCompare(b.name);
                }
                else {
                    return a > b ? 1 : (a < b ? -1 : 0);
                }
            });
        }
        else {
            return value;
        }
    } else if (typeof value === 'object') {
        const sourceKeys = Object.keys(value).sort();
        let sorted: { [key: string]: any } = {};
        for (const key of sourceKeys) {
            const sourceValue = value[key];
            sorted[key] = sortInPlace(sourceValue);
            if (isWritable(value, key)) {
                delete value[key];
                value[key] = sorted[key];
            }

        }

        return value;
    } else {
        return value;
    }
}

function isWritable<T extends Object>(obj: T, key: keyof T) {
    const desc = Object.getOwnPropertyDescriptor(obj, key) || {};
    return Boolean(desc.writable);
}

export function mergeNotebookCellMetadata(baseMetadata: NotebookCellMetadata, metadataWithNewValues: NotebookCellMetadata): NotebookCellMetadata {
    const resultMetadata = { ...baseMetadata };
    if (metadataWithNewValues.kernelName) {
        resultMetadata.kernelName = metadataWithNewValues.kernelName;
    }

    return sortInPlace(resultMetadata);
}

export function mergeNotebookDocumentMetadata(baseMetadata: NotebookDocumentMetadata, metadataWithNewValues: NotebookDocumentMetadata): NotebookDocumentMetadata {
    const resultMetadata = { ...baseMetadata };
    const kernelInfoItems: Map<string, commandsAndEvents.DocumentKernelInfo> = new Map();
    for (const item of baseMetadata.kernelInfo.items) {
        kernelInfoItems.set(item.name, item);
    }
    for (const item of metadataWithNewValues.kernelInfo.items) {
        kernelInfoItems.set(item.name, item);
    }

    resultMetadata.kernelInfo.items = [...kernelInfoItems.values()];
    cleanUpMetadata(resultMetadata);
    return sortInPlace(resultMetadata);
}

export function setKernelConnectionId(notebookMetadata: NotebookDocumentMetadata, kernelName: string, connectionId: string): NotebookDocumentMetadata {
    const resultMetadata = { ...notebookMetadata };
    resultMetadata.kernelInfo = { ...notebookMetadata.kernelInfo };
    resultMetadata.kernelInfo.items = notebookMetadata.kernelInfo.items.map(item => {
        if (item.name === kernelName) {
            return { ...item, connectionId };
        }
        return item;
    });
    return resultMetadata;
}

export function getKernelConnectionId(notebookMetadata: NotebookDocumentMetadata, kernelName: string): string | undefined {
    const kernelInfo = notebookMetadata.kernelInfo.items.find(item => item.name === kernelName);
    return kernelInfo?.connectionId;
}

export function mergeRawMetadata(baseMetadata: { [key: string]: any }, metadataWithNewValues: { [key: string]: any }): { [key: string]: any } {
    const resultMetadata = { ...baseMetadata };
    for (const key in metadataWithNewValues) {
        resultMetadata[key] = metadataWithNewValues[key];
    }

    return sortInPlace(resultMetadata);
}

export function createDefaultNotebookDocumentMetadata(): NotebookDocumentMetadata {
    return {
        kernelInfo: {
            defaultKernelName: 'csharp',
            items: [
                {
                    name: 'csharp',
                    aliases: [],
                }
            ],
        }
    };
}

export function areEquivalentObjects(object1: { [key: string]: any }, object2: { [key: string]: any }, keysToIgnore?: Set<string>): boolean {
    sortInPlace(object1);
    sortInPlace(object2);

    const isObject = (object: any) => {
        return object !== null && typeof object === 'object';
    };

    const object1Keys = Object.keys(object1).filter(k => !(keysToIgnore?.has(k)));
    const object2Keys = Object.keys(object2).filter(k => !(keysToIgnore?.has(k)));

    if (object1Keys.length !== object2Keys.length) {
        return false;
    }

    for (const key of object1Keys) {
        const value1 = object1[key];
        const value2 = object2[key];
        const bothAreObjects = isObject(value1) && isObject(value2);
        const bothAreArrays = Array.isArray(value1) && Array.isArray(value2);

        if (bothAreArrays) {
            if (value1.length !== value2.length) {
                return false;
            }
            for (let index = 0; index < value1.length; index++) {
                const element1 = value1[index];
                const element2 = value2[index];
                if (!areEquivalentObjects(element1, element2)) {
                    return false;
                }
            }
        } else if (bothAreObjects) {
            const equivalent = areEquivalentObjects(value1, value2);
            if (!equivalent) {
                return false;
            }
        } else if (value1 !== value2) {
            return false;
        }
    }
    return true;
}

function cleanUpMetadata(notebookMetadata: NotebookDocumentMetadata) {
    notebookMetadata.kernelInfo.items.forEach(ki => {
        if (ki.languageName === undefined || ki.languageName === null) {
            delete ki.languageName;
        }
    });
}
