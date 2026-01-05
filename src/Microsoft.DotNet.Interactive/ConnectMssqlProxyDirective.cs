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
/// Usage: #!connect mssql-proxy --kernel-name sql-MyConnection
/// </summary>
public class ConnectMssqlProxyDirective : ConnectKernelDirective<ConnectMssqlProxyKernel>
{
    public ConnectMssqlProxyDirective()
        : base("mssql-proxy", "Registers an MSSQL proxy kernel for language service support")
    {
        Console.WriteLine($"[MssqlProxy] ConnectMssqlProxyDirective constructor called");
        Console.WriteLine($"[MssqlProxy] Parameters count: {Parameters.Count}");
        foreach (var p in Parameters)
        {
            Console.WriteLine($"[MssqlProxy] Parameter: {p.Name}");
        }
    }

    public override Task<IEnumerable<Kernel>> ConnectKernelsAsync(
        ConnectMssqlProxyKernel connectCommand,
        KernelInvocationContext context)
    {
        var kernelName = connectCommand.ConnectedKernelName;
        
        Console.WriteLine($"[MssqlProxy] ConnectMssqlProxyDirective: registering {kernelName}");

        // Check if kernel already exists
        var existingKernel = context.HandlingKernel?.RootKernel.FindKernelByName(kernelName);
        if (existingKernel is MssqlProxyKernel)
        {
            Console.WriteLine($"[MssqlProxy] Kernel {kernelName} already exists as MssqlProxyKernel");
            return Task.FromResult<IEnumerable<Kernel>>(Array.Empty<Kernel>());
        }

        // Create the proxy kernel
        var proxyKernel = new MssqlProxyKernel(kernelName);
        
        Console.WriteLine($"[MssqlProxy] Kernel {kernelName} created successfully");

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
