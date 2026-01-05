// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System.Linq;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using Microsoft.DotNet.Interactive.App.ParserServer;
using Xunit;

namespace Microsoft.DotNet.Interactive.Documents.Tests;

public class KernelInfoConnectionIdTests
{
    #region KernelInfo Unit Tests

    [Fact]
    public void KernelInfo_can_be_created_with_connectionId()
    {
        var kernelInfo = new KernelInfo("sql-test", "T-SQL", new[] { "test" }, "test-connection-id");

        kernelInfo.ConnectionId.Should().Be("test-connection-id");
    }

    [Fact]
    public void KernelInfo_connectionId_is_null_by_default()
    {
        var kernelInfo = new KernelInfo("sql-test", "T-SQL");

        kernelInfo.ConnectionId.Should().BeNull();
    }

    [Fact]
    public void KernelInfo_serializes_connectionId_to_json()
    {
        var kernelInfo = new KernelInfo("sql-test", "T-SQL", new[] { "test" }, "ABC-123-DEF");

        var json = JsonSerializer.Serialize(kernelInfo);

        json.Should().Contain("\"connectionId\":\"ABC-123-DEF\"");
    }

    [Fact]
    public void KernelInfo_does_not_serialize_connectionId_when_null()
    {
        var kernelInfo = new KernelInfo("sql-test", "T-SQL");

        var json = JsonSerializer.Serialize(kernelInfo);

        json.Should().NotContain("connectionId");
    }

    [Fact]
    public void KernelInfo_deserializes_connectionId_from_json()
    {
        var json = """{"name":"sql-test","languageName":"T-SQL","connectionId":"XYZ-789"}""";

        var kernelInfo = JsonSerializer.Deserialize<KernelInfo>(json);

        kernelInfo.ConnectionId.Should().Be("XYZ-789");
    }

    [Fact]
    public void KernelInfo_deserializes_without_connectionId()
    {
        var json = """{"name":"sql-test","languageName":"T-SQL"}""";

        var kernelInfo = JsonSerializer.Deserialize<KernelInfo>(json);

        kernelInfo.ConnectionId.Should().BeNull();
    }

    #endregion

    #region DIB Format Tests

    [Fact]
    public void DIB_serialization_preserves_connectionId_on_kernel_items()
    {
        var dibContents = """
            #!meta
            {"kernelInfo":{"defaultKernelName":"csharp","items":[{"name":"csharp","languageName":"C#"},{"name":"sql-MyDb","languageName":"T-SQL","connectionId":"GUID-12345"}]}}

            #!sql-MyDb

            SELECT * FROM Users
            """;

        var parseRequest = new NotebookParseRequest(
            "test-id",
            DocumentSerializationType.Dib,
            defaultLanguage: "csharp",
            rawData: Encoding.UTF8.GetBytes(dibContents));

        var parseResponse = NotebookParserServer.HandleRequest(parseRequest) as NotebookParseResponse;
        var document = parseResponse.Document;

        // Verify connectionId was parsed
        var kernelInfos = document.Metadata["kernelInfo"] as KernelInfoCollection;
        var sqlKernel = kernelInfos.FirstOrDefault(k => k.Name == "sql-MyDb");
        sqlKernel.Should().NotBeNull();
        sqlKernel.ConnectionId.Should().Be("GUID-12345");

        // Now serialize back
        var serializeRequest = new NotebookSerializeRequest(
            "test-id",
            DocumentSerializationType.Dib,
            defaultLanguage: "csharp",
            newLine: "\n",
            document: document);

        var serializeResponse = NotebookParserServer.HandleRequest(serializeRequest) as NotebookSerializeResponse;
        var serializedContent = Encoding.UTF8.GetString(serializeResponse.RawData);

        // Verify connectionId is in the serialized output
        serializedContent.Should().Contain("\"connectionId\":\"GUID-12345\"");
    }

    [Fact]
    public void DIB_deserialization_reads_connectionId_from_meta_block()
    {
        var dibContents = """
            #!meta
            {"kernelInfo":{"defaultKernelName":"sql","items":[{"name":"sql","languageName":"sql"},{"name":"sql-Production","languageName":"T-SQL","connectionId":"PROD-CONN-ID"},{"name":"sql-Staging","languageName":"T-SQL","connectionId":"STAGE-CONN-ID"}]}}

            #!sql-Production

            SELECT * FROM Orders

            #!sql-Staging

            SELECT * FROM TestOrders
            """;

        var request = new NotebookParseRequest(
            "test-id",
            DocumentSerializationType.Dib,
            defaultLanguage: "sql",
            rawData: Encoding.UTF8.GetBytes(dibContents));

        var response = NotebookParserServer.HandleRequest(request) as NotebookParseResponse;
        var kernelInfos = response.Document.Metadata["kernelInfo"] as KernelInfoCollection;

        var prodKernel = kernelInfos.FirstOrDefault(k => k.Name == "sql-Production");
        prodKernel.Should().NotBeNull();
        prodKernel.ConnectionId.Should().Be("PROD-CONN-ID");

        var stageKernel = kernelInfos.FirstOrDefault(k => k.Name == "sql-Staging");
        stageKernel.Should().NotBeNull();
        stageKernel.ConnectionId.Should().Be("STAGE-CONN-ID");

        // sql kernel should not have connectionId
        var sqlKernel = kernelInfos.FirstOrDefault(k => k.Name == "sql");
        sqlKernel.Should().NotBeNull();
        sqlKernel.ConnectionId.Should().BeNull();
    }

    [Fact]
    public void DIB_roundtrip_preserves_multiple_kernel_connectionIds()
    {
        var dibContents = """
            #!meta
            {"kernelInfo":{"defaultKernelName":"csharp","items":[{"name":"csharp","languageName":"C#"},{"name":"sql-Db1","languageName":"T-SQL","connectionId":"CONN-1"},{"name":"sql-Db2","languageName":"T-SQL","connectionId":"CONN-2"},{"name":"sql-Db3","languageName":"T-SQL"}]}}

            #!csharp

            var x = 1;
            """;

        // Parse
        var parseRequest = new NotebookParseRequest(
            "test-id",
            DocumentSerializationType.Dib,
            defaultLanguage: "csharp",
            rawData: Encoding.UTF8.GetBytes(dibContents));

        var parseResponse = NotebookParserServer.HandleRequest(parseRequest) as NotebookParseResponse;

        // Serialize
        var serializeRequest = new NotebookSerializeRequest(
            "test-id",
            DocumentSerializationType.Dib,
            defaultLanguage: "csharp",
            newLine: "\n",
            document: parseResponse.Document);

        var serializeResponse = NotebookParserServer.HandleRequest(serializeRequest) as NotebookSerializeResponse;
        var serializedContent = Encoding.UTF8.GetString(serializeResponse.RawData);

        // Parse again
        var parseRequest2 = new NotebookParseRequest(
            "test-id-2",
            DocumentSerializationType.Dib,
            defaultLanguage: "csharp",
            rawData: serializeResponse.RawData);

        var parseResponse2 = NotebookParserServer.HandleRequest(parseRequest2) as NotebookParseResponse;
        var kernelInfos = parseResponse2.Document.Metadata["kernelInfo"] as KernelInfoCollection;

        // Verify all connectionIds are preserved
        kernelInfos.FirstOrDefault(k => k.Name == "sql-Db1")?.ConnectionId.Should().Be("CONN-1");
        kernelInfos.FirstOrDefault(k => k.Name == "sql-Db2")?.ConnectionId.Should().Be("CONN-2");
        kernelInfos.FirstOrDefault(k => k.Name == "sql-Db3")?.ConnectionId.Should().BeNull();
    }

    #endregion

    #region IPYNB Format Tests

    [Fact]
    public void IPYNB_KernelInfo_with_connectionId_serializes_to_json()
    {
        // Test that KernelInfo with connectionId serializes correctly for IPYNB
        var kernelInfo = new KernelInfo("sql-MyDb", "T-SQL", new[] { "mydb" }, "IPYNB-CONN-123");

        var json = JsonSerializer.Serialize(kernelInfo);

        json.Should().Contain("\"connectionId\":\"IPYNB-CONN-123\"");
        json.Should().Contain("\"name\":\"sql-MyDb\"");
        json.Should().Contain("\"languageName\":\"T-SQL\"");
    }

    [Fact]
    public void IPYNB_KernelInfoCollection_preserves_connectionId()
    {
        // Test that a collection of KernelInfo preserves connectionId through serialization
        var collection = new KernelInfoCollection
        {
            new KernelInfo("csharp", "C#"),
            new KernelInfo("sql-Server1", "T-SQL", null, "SERVER1-ID"),
            new KernelInfo("sql-Server2", "T-SQL", null, "SERVER2-ID")
        };

        var json = JsonSerializer.Serialize(collection);
        var deserialized = JsonSerializer.Deserialize<KernelInfoCollection>(json);

        deserialized.FirstOrDefault(k => k.Name == "sql-Server1")?.ConnectionId.Should().Be("SERVER1-ID");
        deserialized.FirstOrDefault(k => k.Name == "sql-Server2")?.ConnectionId.Should().Be("SERVER2-ID");
        deserialized.FirstOrDefault(k => k.Name == "csharp")?.ConnectionId.Should().BeNull();
    }

    #endregion

    #region Edge Cases

    [Fact]
    public void ConnectionId_with_special_characters_is_preserved()
    {
        var kernelInfo = new KernelInfo("sql-test", "T-SQL", null, "conn-id-with-special-chars!@#$%");

        var json = JsonSerializer.Serialize(kernelInfo);
        var deserialized = JsonSerializer.Deserialize<KernelInfo>(json);

        deserialized.ConnectionId.Should().Be("conn-id-with-special-chars!@#$%");
    }

    [Fact]
    public void ConnectionId_with_guid_format_is_preserved()
    {
        var guid = "E14AA0D9-8893-4B53-AB1A-3425A62356F3";
        var kernelInfo = new KernelInfo("sql-test", "T-SQL", null, guid);

        var json = JsonSerializer.Serialize(kernelInfo);
        var deserialized = JsonSerializer.Deserialize<KernelInfo>(json);

        deserialized.ConnectionId.Should().Be(guid);
    }

    [Fact]
    public void Empty_connectionId_is_serialized_as_empty_string()
    {
        var kernelInfo = new KernelInfo("sql-test", "T-SQL", null, "");

        var json = JsonSerializer.Serialize(kernelInfo);

        // Empty string should still be serialized
        json.Should().Contain("\"connectionId\":\"\"");
    }

    #endregion
}
