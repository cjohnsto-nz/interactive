// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.DotNet.Interactive.Commands;
using Microsoft.DotNet.Interactive.Connection;
using Microsoft.DotNet.Interactive.Directives;

namespace Microsoft.DotNet.Interactive;

/// <summary>
/// Connect directive for registering MSSQL proxy kernels.
/// Usage: #!connect mssql-proxy --kernel-name mssql-MyConnection
/// </summary>
public class ConnectMssqlProxyDirective : ConnectKernelDirective<ConnectMssqlProxyKernel>
{
    /// <summary>
    /// Prefix for MSSQL proxy kernel names (e.g., "mssql-MyConnection").
    /// </summary>
    public const string KernelNamePrefix = "mssql-";

    /// <summary>
    /// Checks if a kernel name is an MSSQL proxy kernel.
    /// </summary>
    public static bool IsMssqlProxyKernel(string kernelName) => 
        kernelName?.StartsWith(KernelNamePrefix) == true;

    public ConnectMssqlProxyDirective()
        : base("mssql-proxy", "Registers an MSSQL proxy kernel for language service support")
    {
    }

    public override Task<IEnumerable<Kernel>> ConnectKernelsAsync(
        ConnectMssqlProxyKernel connectCommand,
        KernelInvocationContext context)
    {
        var kernelName = connectCommand.ConnectedKernelName;
        
        if (!IsMssqlProxyKernel(kernelName))
        {
            return Task.FromResult<IEnumerable<Kernel>>(Array.Empty<Kernel>());
        }
        
        // Check if kernel already exists as a proxy kernel
        var existingKernel = context.HandlingKernel?.RootKernel.FindKernelByName(kernelName);
        if (existingKernel is MssqlProxyKernel)
        {
            return Task.FromResult<IEnumerable<Kernel>>(Array.Empty<Kernel>());
        }

        // Create the proxy kernel
        var proxyKernel = new MssqlProxyKernel(kernelName);

        return Task.FromResult<IEnumerable<Kernel>>(new[] { proxyKernel });
    }
}

/// <summary>
/// Command for connecting an MSSQL proxy kernel.
/// </summary>
public class ConnectMssqlProxyKernel : ConnectKernelCommand
{
    public ConnectMssqlProxyKernel(string connectedKernelName) : base(connectedKernelName)
    {
    }
}
