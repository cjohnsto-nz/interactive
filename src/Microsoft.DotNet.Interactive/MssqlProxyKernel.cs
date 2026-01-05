// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.DotNet.Interactive.Commands;
using Microsoft.DotNet.Interactive.Events;
using Microsoft.DotNet.Interactive.Formatting;

namespace Microsoft.DotNet.Interactive;

/// <summary>
/// A proxy kernel for MSSQL connections that handles language service requests
/// by returning empty results. The actual SQL execution is handled by the
/// MSSQL VS Code extension on the TypeScript side.
/// </summary>
public class MssqlProxyKernel : Kernel,
    IKernelCommandHandler<SubmitCode>,
    IKernelCommandHandler<RequestCompletions>,
    IKernelCommandHandler<RequestDiagnostics>,
    IKernelCommandHandler<RequestHoverText>,
    IKernelCommandHandler<RequestSignatureHelp>
{
    private readonly Func<string, Task<object>> _executeFunc;

    public MssqlProxyKernel(string name, Func<string, Task<object>> executeFunc = null) : base(name)
    {
        _executeFunc = executeFunc ?? (_ => Task.FromResult<object>(null));
        
        KernelInfo.LanguageName = "T-SQL";
        KernelInfo.DisplayName = name;
    }

    Task IKernelCommandHandler<SubmitCode>.HandleAsync(SubmitCode command, KernelInvocationContext context)
    {
        // The actual execution is handled by TypeScript via MSSQL extension
        // This is just a placeholder that does nothing
        return Task.CompletedTask;
    }

    Task IKernelCommandHandler<RequestCompletions>.HandleAsync(RequestCompletions command, KernelInvocationContext context)
    {
        // Return empty completions - the MSSQL extension handles intellisense
        context.Publish(new CompletionsProduced(Array.Empty<CompletionItem>(), command));
        return Task.CompletedTask;
    }

    Task IKernelCommandHandler<RequestDiagnostics>.HandleAsync(RequestDiagnostics command, KernelInvocationContext context)
    {
        // Return empty diagnostics - the MSSQL extension handles diagnostics
        context.Publish(new DiagnosticsProduced(Array.Empty<Diagnostic>(), Array.Empty<FormattedValue>(), command));
        return Task.CompletedTask;
    }

    Task IKernelCommandHandler<RequestHoverText>.HandleAsync(RequestHoverText command, KernelInvocationContext context)
    {
        // Return empty hover text - the MSSQL extension handles hover
        // HoverTextProduced requires at least one FormattedValue, so we provide an empty string
        context.Publish(new HoverTextProduced(command, new[] { new FormattedValue("text/plain", "") }));
        return Task.CompletedTask;
    }

    Task IKernelCommandHandler<RequestSignatureHelp>.HandleAsync(RequestSignatureHelp command, KernelInvocationContext context)
    {
        // Return empty signature help - the MSSQL extension handles this
        context.Publish(new SignatureHelpProduced(command, Array.Empty<SignatureInformation>(), 0, 0));
        return Task.CompletedTask;
    }

    /// <summary>
    /// Registers an MSSQL proxy kernel with the composite kernel.
    /// This method is accessible from C# scripting.
    /// </summary>
    public static void RegisterProxyKernel(CompositeKernel compositeKernel, string kernelName, string displayName = null)
    {
        // Check if kernel already exists
        var existingKernel = compositeKernel.ChildKernels.FirstOrDefault(k => k.Name == kernelName);
        if (existingKernel is MssqlProxyKernel)
        {
            return;
        }

        // Create the proxy kernel
        var proxyKernel = new MssqlProxyKernel(kernelName);

        // Set display name if provided
        if (!string.IsNullOrEmpty(displayName))
        {
            proxyKernel.KernelInfo.DisplayName = displayName;
        }

        // Add to composite kernel
        compositeKernel.Add(proxyKernel);
    }
}
