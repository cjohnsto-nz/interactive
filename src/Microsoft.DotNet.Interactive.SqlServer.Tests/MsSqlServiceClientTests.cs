// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System;
using Xunit;
using FluentAssertions;

namespace Microsoft.DotNet.Interactive.SqlServer.Tests;

public class ToolsServiceClientExtensionsTests
{
    [Fact]
    public void ExtractAndRemoveAccessToken_returns_null_when_no_token_present()
    {
        var connectionString = "Server=myserver;Database=mydb;User ID=myuser;Password=mypassword;";
        
        var token = ToolsServiceClientExtensions.ExtractAndRemoveAccessToken(ref connectionString);
        
        token.Should().BeNull();
        connectionString.Should().Be("Server=myserver;Database=mydb;User ID=myuser;Password=mypassword;");
    }

    [Fact]
    public void ExtractAndRemoveAccessToken_extracts_token_and_removes_from_connection_string()
    {
        var connectionString = "Server=myserver;Database=mydb;AccessToken=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9;";
        
        var token = ToolsServiceClientExtensions.ExtractAndRemoveAccessToken(ref connectionString);
        
        token.Should().Be("eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9");
        connectionString.Should().Be("Server=myserver;Database=mydb");
    }

    [Fact]
    public void ExtractAndRemoveAccessToken_removes_user_id_when_token_present()
    {
        var connectionString = "Server=myserver;Database=mydb;User ID=myuser@domain.com;AccessToken=mytoken;";
        
        var token = ToolsServiceClientExtensions.ExtractAndRemoveAccessToken(ref connectionString);
        
        token.Should().Be("mytoken");
        connectionString.Should().NotContain("User ID");
        connectionString.Should().NotContain("myuser");
    }

    [Fact]
    public void ExtractAndRemoveAccessToken_handles_quoted_user_id()
    {
        var connectionString = "Server=myserver;Database=mydb;User ID=\"myuser@domain.com\";AccessToken=mytoken;";
        
        var token = ToolsServiceClientExtensions.ExtractAndRemoveAccessToken(ref connectionString);
        
        token.Should().Be("mytoken");
        connectionString.Should().NotContain("User ID");
        connectionString.Should().NotContain("myuser");
    }

    [Fact]
    public void ExtractAndRemoveAccessToken_is_case_insensitive()
    {
        var connectionString = "Server=myserver;Database=mydb;ACCESSTOKEN=mytoken;";
        
        var token = ToolsServiceClientExtensions.ExtractAndRemoveAccessToken(ref connectionString);
        
        token.Should().Be("mytoken");
        connectionString.Should().Be("Server=myserver;Database=mydb");
    }
}

public class MsSqlServiceClientTests
{
    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public void Should_parse_doc_change_correctly_with_different_line_endings(string lineEnding)
    {
        string oldText = string.Join(lineEnding, "abc", "def", "", "abc", "abcdef");
        int oldTextLineCount = 5;
        int oldTextLastCharacterNum = 6;
        string newText = string.Join(lineEnding, "abc", "def");
        var testUri = new Uri("untitled://test");

        var docChange = ToolsServiceClient.GetDocumentChangeForText(testUri, newText, oldText);

        docChange.ContentChanges.Length
            .Should()
            .Be(1);
        docChange.ContentChanges[0].Range.End.Line
            .Should()
            .Be(oldTextLineCount - 1);
        docChange.ContentChanges[0].Range.End.Character
            .Should()
            .Be(oldTextLastCharacterNum);
        docChange.ContentChanges[0].Range.Start.Line
            .Should()
            .Be(0);
        docChange.ContentChanges[0].Range.Start.Character
            .Should()
            .Be(0);
        docChange.ContentChanges[0].Text
            .Should()
            .Be(newText);
        docChange.TextDocument.Uri
            .Should()
            .Be(testUri.AbsolutePath);
        docChange.TextDocument.Version
            .Should()
            .Be(1);
    }
}