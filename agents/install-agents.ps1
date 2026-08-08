#Requires -Version 5.1
<#
.SYNOPSIS
  Install ReforgerForge MCP into any supported AI agent.

.DESCRIPTION
  Merges the reforger-forge server entry into agent MCP config files.
  Supports: Codex, Cursor, Google Antigravity, Claude Desktop, Windsurf,
  VS Code (Copilot), Kiro (workspace), and Continue.dev.

.PARAMETER All
  Install to all supported agents without prompting.

.PARAMETER Agent
  Install to a specific agent: codex, cursor, antigravity, claude, windsurf, vscode, continue, kiro

.PARAMETER ConfigPath
  Explicit ReforgerForge JSON configuration passed to every MCP registration.

.EXAMPLE
  .\agents\install-agents.ps1 -ConfigPath C:\path\to\config.json -All
  .\agents\install-agents.ps1 -ConfigPath C:\path\to\config.json -Agent codex
  .\agents\install-agents.ps1 -ConfigPath C:\path\to\config.json -Agent antigravity
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,
    [switch]$All,
    [ValidateSet("codex", "cursor", "antigravity", "claude", "windsurf", "vscode", "continue", "kiro", "all")]
    [string]$Agent = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ServerEntry = Join-Path $Root "dist\index.js"
$LifecycleHelper = Join-Path $Root "scripts\windows\workbench-lifecycle.ps1"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Write-Host "ERROR: Explicit config file not found: $ConfigPath" -ForegroundColor Red
    exit 1
}
$ResolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path

if (-not (Test-Path -LiteralPath $ServerEntry -PathType Leaf)) {
    Write-Host "ERROR: Server not built. Run: npm run build" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $LifecycleHelper -PathType Leaf)) {
    Write-Host "ERROR: Bundled Windows lifecycle helper is missing: $LifecycleHelper" -ForegroundColor Red
    exit 1
}

# This is the public standalone override installer, so it always verifies
# before its first client-config write.
Write-Host "Verifying registered tools..." -ForegroundColor Yellow
node --title=ReforgerForge-MCP-agent-installer `
    (Join-Path $Root "scripts\verify-mcp-server.mjs") `
    --mcp-client-label agent-installer --config $ResolvedConfigPath
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host ""

function New-McpServerArguments {
    param(
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[a-z0-9][a-z0-9._-]{0,47}$')]
        [string]$ClientLabel
    )
    return @(
        "--title=ReforgerForge-MCP-$ClientLabel",
        $ServerEntry,
        "--mcp-client-label",
        $ClientLabel,
        "--config",
        $ResolvedConfigPath
    )
}

function New-McpStdioEntry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ClientLabel,

        [switch]$VsCode
    )
    $entry = [ordered]@{
        command = "node"
        args = @(New-McpServerArguments -ClientLabel $ClientLabel)
    }
    if ($VsCode) {
        $entry = [ordered]@{
            type = "stdio"
            command = "node"
            args = @(New-McpServerArguments -ClientLabel $ClientLabel)
        }
    }
    return $entry
}

function Merge-McpServers {
    param(
        [string]$Path,
        [System.Collections.IDictionary]$Entry,
        [string]$Key = "reforger-forge",
        [string]$RootKey = "mcpServers"
    )
    $dir = Split-Path $Path -Parent
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    } else {
        $existing = [PSCustomObject]@{}
    }
    if ($existing -isnot [PSCustomObject]) {
        throw "MCP config root must be a JSON object: $Path"
    }
    $rootProperty = $existing.PSObject.Properties[$RootKey]
    if ($null -eq $rootProperty -or $null -eq $rootProperty.Value) {
        $existing | Add-Member -NotePropertyName $RootKey -NotePropertyValue ([PSCustomObject]@{}) -Force
    } elseif ($rootProperty.Value -isnot [PSCustomObject]) {
        throw "MCP config '$RootKey' must be a JSON object: $Path"
    }
    $existing.$RootKey | Add-Member -NotePropertyName $Key -NotePropertyValue $Entry -Force
    $json = $existing | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText(
        $Path,
        $json + [Environment]::NewLine,
        $Utf8NoBom
    )
    Write-Host "  Updated: $Path" -ForegroundColor Green
}

function Install-Cursor {
    $entry = New-McpStdioEntry -ClientLabel "cursor"
    Merge-McpServers -Path (Join-Path $env:USERPROFILE ".cursor\mcp.json") -Entry $entry
}

function Install-Codex {
    $codexCommand = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $codexCommand) {
        if ($All -or $Agent -eq "all") {
            Write-Warning "Skipped Codex because the Codex CLI is not installed or is not available on PATH."
            return
        }
        throw "Codex CLI is not installed or is not available on PATH."
    }

    $existingJson = & $codexCommand.Source mcp get reforger-forge --json 2>$null
    if ($LASTEXITCODE -eq 0) {
        try {
            $existing = $existingJson | ConvertFrom-Json
        } catch {
            throw "Codex returned an invalid MCP registration for 'reforger-forge': $($_.Exception.Message)"
        }
        $existingArgs = @($existing.transport.args)
        $expectedArgs = @(New-McpServerArguments -ClientLabel "codex")
        $alreadyCurrent =
            $existing.transport.type -eq "stdio" -and
            $existing.transport.command -eq "node" -and
            $existingArgs.Count -eq $expectedArgs.Count -and
            ($existingArgs -join [char]0) -eq ($expectedArgs -join [char]0)
        if ($alreadyCurrent) {
            Write-Host "  Already current: Codex MCP registration" -ForegroundColor Green
            return
        }

        & $codexCommand.Source mcp remove reforger-forge
        if ($LASTEXITCODE -ne 0) {
            throw "Codex could not remove the existing 'reforger-forge' MCP registration."
        }
    }

    $codexArgs = @(New-McpServerArguments -ClientLabel "codex")
    & $codexCommand.Source mcp add reforger-forge -- node @codexArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Codex could not add the 'reforger-forge' MCP registration."
    }
    Write-Host "  Updated through Codex CLI: reforger-forge" -ForegroundColor Green
}

function Install-Antigravity {
    $entry = New-McpStdioEntry -ClientLabel "antigravity"
    Merge-McpServers -Path (Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json") -Entry $entry
}

function Install-Claude {
    $entry = New-McpStdioEntry -ClientLabel "claude-desktop"
    Merge-McpServers -Path (Join-Path $env:APPDATA "Claude\claude_desktop_config.json") -Entry $entry
}

function Install-Windsurf {
    $entry = New-McpStdioEntry -ClientLabel "windsurf"
    Merge-McpServers -Path (Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json") -Entry $entry
}

function Install-VSCode {
    $entry = New-McpStdioEntry -ClientLabel "vscode" -VsCode
    # User-level
    Merge-McpServers -Path (Join-Path $env:APPDATA "Code\User\mcp.json") -Entry $entry -RootKey "servers"
    # Workspace-level
    $wsDir = Join-Path $Root ".vscode"
    New-Item -ItemType Directory -Force -Path $wsDir | Out-Null
    Merge-McpServers -Path (Join-Path $wsDir "mcp.json") -Entry $entry -RootKey "servers"
}

function Install-Continue {
    $entry = New-McpStdioEntry -ClientLabel "continue"
    Merge-McpServers -Path (Join-Path $env:USERPROFILE ".continue\config.json") -Entry $entry
}

function Install-Kiro {
    $kiroDir = Join-Path $Root ".kiro\settings"
    New-Item -ItemType Directory -Force -Path $kiroDir | Out-Null
    $entry = [ordered]@{
        command     = "node"
        args        = @(New-McpServerArguments -ClientLabel "kiro")
        disabled    = $false
        autoApprove = @()
    }
    Merge-McpServers -Path (Join-Path $kiroDir "mcp.json") -Entry $entry
}

$agents = @{
    codex       = @{ Name = "Codex";               Fn = { Install-Codex } }
    cursor      = @{ Name = "Cursor";              Fn = { Install-Cursor } }
    antigravity = @{ Name = "Google Antigravity";  Fn = { Install-Antigravity } }
    claude      = @{ Name = "Claude Desktop";      Fn = { Install-Claude } }
    windsurf    = @{ Name = "Windsurf (Cascade)"; Fn = { Install-Windsurf } }
    vscode      = @{ Name = "VS Code (Copilot)";  Fn = { Install-VSCode } }
    continue    = @{ Name = "Continue.dev";        Fn = { Install-Continue } }
    kiro        = @{ Name = "Kiro (workspace)";    Fn = { Install-Kiro } }
}

Write-Host ""
Write-Host "ReforgerForge MCP - Agent Installer" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "Server: $ServerEntry"
Write-Host "Config: $ResolvedConfigPath"
Write-Host ""

if ($All -or $Agent -eq "all") {
    foreach ($key in $agents.Keys) {
        Write-Host "Installing: $($agents[$key].Name)..." -ForegroundColor Yellow
        & $agents[$key].Fn
    }
} elseif ($Agent) {
    Write-Host "Installing: $($agents[$Agent].Name)..." -ForegroundColor Yellow
    & $agents[$Agent].Fn
} else {
    Write-Host "Select agents to install (comma-separated keys):" -ForegroundColor Yellow
    Write-Host "  codex, cursor, antigravity, claude, windsurf, vscode, continue, kiro"
    Write-Host "  Or use: -All   or   -Agent antigravity"
    Write-Host ""
    $input = Read-Host "Agents (or 'all')"
    if ($input -eq "all") {
        foreach ($key in $agents.Keys) {
            Write-Host "Installing: $($agents[$key].Name)..." -ForegroundColor Yellow
            & $agents[$key].Fn
        }
    } else {
        $selected = @($input -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($selected.Count -eq 0) {
            throw "At least one agent key is required."
        }
        $unknown = @($selected | Where-Object { -not $agents.ContainsKey($_) })
        if ($unknown.Count -gt 0) {
            throw "Unknown agent key(s): $($unknown -join ', ')"
        }
        foreach ($key in $selected) {
            Write-Host "Installing: $($agents[$key].Name)..." -ForegroundColor Yellow
            & $agents[$key].Fn
        }
    }
}

Write-Host ""
Write-Host "Done! Restart your agent and verify 'reforger-forge' is available." -ForegroundColor Green
Write-Host ""
Write-Host "Agent config locations:" -ForegroundColor Cyan
Write-Host "  Codex:        managed by 'codex mcp' (normally $env:USERPROFILE\.codex\config.toml)"
Write-Host "  Cursor:       $env:USERPROFILE\.cursor\mcp.json"
Write-Host "  Antigravity:  $env:USERPROFILE\.gemini\config\mcp_config.json"
Write-Host "  Claude:       $env:APPDATA\Claude\claude_desktop_config.json"
Write-Host "  Windsurf:     $env:USERPROFILE\.codeium\windsurf\mcp_config.json"
Write-Host "  VS Code:      $env:APPDATA\Code\User\mcp.json"
Write-Host "  Continue:     $env:USERPROFILE\.continue\config.json"
Write-Host "  Kiro:         $Root\.kiro\settings\mcp.json"
