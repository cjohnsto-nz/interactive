using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Microsoft.DotNet.Interactive.SqlServer;

internal static class ToolsServiceClientExtensions
{
    internal static async Task<bool> ConnectAsync(this ToolsServiceClient serviceClient, Uri ownerUri, string connectionStr)
    {
        var connectionOptions = new Dictionary<string, string>();
        
        // Extract AccessToken if present (it's not a valid SqlConnectionStringBuilder keyword)
        // and pass it separately to SQL Tools Service
        var accessToken = ExtractAndRemoveAccessToken(ref connectionStr);
        
        connectionOptions.Add("ConnectionString", connectionStr);
        
        // If we have an access token, add it as a separate option
        if (!string.IsNullOrEmpty(accessToken))
        {
            connectionOptions.Add("azureAccountToken", accessToken);
        }

        var connectionDetails = new ConnectionDetails {Options = connectionOptions};
        var connectionParams = new ConnectParams {OwnerUri = ownerUri.AbsolutePath, Connection = connectionDetails};

        return await serviceClient.ConnectAsync(connectionParams);
    }
    
    internal static string ExtractAndRemoveAccessToken(ref string connectionString)
    {
        // Look for AccessToken=... in the connection string
        var match = Regex.Match(connectionString, @"AccessToken\s*=\s*([^;]+)", RegexOptions.IgnoreCase);
        if (!match.Success)
        {
            return null;
        }
        
        var accessToken = match.Groups[1].Value.Trim();
        
        // Remove AccessToken from connection string
        connectionString = Regex.Replace(
            connectionString,
            @"AccessToken\s*=\s*[^;]+;?",
            "",
            RegexOptions.IgnoreCase);
        
        // Also remove User ID - cannot have both AccessToken and User ID
        connectionString = Regex.Replace(
            connectionString,
            @"User\s*ID\s*=\s*""[^""]*""\s*;?",
            "",
            RegexOptions.IgnoreCase);
        connectionString = Regex.Replace(
            connectionString,
            @"User\s*ID\s*=\s*[^;]+;?",
            "",
            RegexOptions.IgnoreCase);
        
        connectionString = connectionString.Trim().TrimEnd(';');
        
        return accessToken;
    }
}