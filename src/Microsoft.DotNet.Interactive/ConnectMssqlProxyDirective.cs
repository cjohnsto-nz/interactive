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
    }

    public override Task<IEnumerable<Kernel>> ConnectKernelsAsync(
        ConnectMssqlProxyKernel connectCommand,
        KernelInvocationContext context)
    {
        var kernelName = connectCommand.ConnectedKernelName;
        
        // Check if kernel already exists as a proxy kernel
        var existingKernel = context.HandlingKernel?.RootKernel.FindKernelByName(kernelName);
        if (existingKernel is MssqlProxyKernel)
        {
            return Task.FromResult<IEnumerable<Kernel>>(Array.Empty<Kernel>());
        }

        // If the requested name is "sql", we need to use a different internal name
        // since "sql" might conflict with an existing kernel
        string actualKernelName = kernelName;
        string[] aliases = null;
        
        if (kernelName == "sql")
        {
            // Use a unique internal name and add "sql" as an alias
            actualKernelName = "sql-proxy";
            aliases = new[] { "sql" };
        }

        // Check if the actual kernel name already exists
        var existingActualKernel = context.HandlingKernel?.RootKernel.FindKernelByName(actualKernelName);
        if (existingActualKernel is MssqlProxyKernel existingProxy)
        {
            // Add alias if needed
            if (aliases != null)
            {
                foreach (var alias in aliases)
                {
                    existingProxy.KernelInfo.NameAndAliases.Add(alias);
                }
            }
            return Task.FromResult<IEnumerable<Kernel>>(Array.Empty<Kernel>());
        }

        // Create the proxy kernel
        var proxyKernel = new MssqlProxyKernel(actualKernelName);
        
        // Add aliases
        if (aliases != null)
        {
            foreach (var alias in aliases)
            {
                proxyKernel.KernelInfo.NameAndAliases.Add(alias);
            }
        }

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
