// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System.Linq;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.DotNet.Interactive.Commands;
using Microsoft.DotNet.Interactive.Events;
using Microsoft.DotNet.Interactive.Tests.Utility;
using Xunit;

namespace Microsoft.DotNet.Interactive.Tests;

public class MssqlProxyKernelTests
{
    [Fact]
    public async Task Connect_mssql_proxy_registers_kernel()
    {
        using var kernel = new CompositeKernel();
        kernel.AddConnectDirective(new ConnectMssqlProxyDirective());

        var result = await kernel.SubmitCodeAsync("#!connect mssql-proxy --kernel-name sql-TestKernel");

        result.Events.Should().NotContainErrors();
        
        var childKernel = kernel.ChildKernels.FirstOrDefault(k => k.Name == "sql-TestKernel");
        childKernel.Should().NotBeNull();
        childKernel.Should().BeOfType<MssqlProxyKernel>();
    }

    [Fact]
    public async Task MssqlProxyKernel_handles_RequestCompletions()
    {
        var kernel = new MssqlProxyKernel("sql-test");

        var result = await kernel.SendAsync(new RequestCompletions("SELECT ", new LinePosition(0, 7)));

        result.Events.Should().ContainSingle<CompletionsProduced>();
        result.Events.OfType<CompletionsProduced>().Single().Completions.Should().BeEmpty();
    }

    [Fact]
    public async Task MssqlProxyKernel_handles_RequestDiagnostics()
    {
        var kernel = new MssqlProxyKernel("sql-test");

        var result = await kernel.SendAsync(new RequestDiagnostics("SELECT * FROM test"));

        result.Events.Should().ContainSingle<DiagnosticsProduced>();
        result.Events.OfType<DiagnosticsProduced>().Single().Diagnostics.Should().BeEmpty();
    }

    [Fact]
    public async Task MssqlProxyKernel_handles_RequestHoverText()
    {
        var kernel = new MssqlProxyKernel("sql-test");

        var result = await kernel.SendAsync(new RequestHoverText("SELECT", new LinePosition(0, 3)));

        // The handler should produce HoverTextProduced event
        result.Events.Should().NotContainErrors();
    }

    [Fact]
    public async Task MssqlProxyKernel_handles_RequestSignatureHelp()
    {
        var kernel = new MssqlProxyKernel("sql-test");

        var result = await kernel.SendAsync(new RequestSignatureHelp("GETDATE(", new LinePosition(0, 8)));

        result.Events.Should().ContainSingle<SignatureHelpProduced>();
    }
}
