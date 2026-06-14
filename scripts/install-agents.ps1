#Requires -Version 5.1
<#
.SYNOPSIS
  Install ReforgerForge MCP into any supported AI agent.

.DESCRIPTION
  Merges the reforger-forge server entry into agent MCP config files.
  Supports: Cursor, Google Antigravity, Claude Desktop, Windsurf,
  VS Code (Copilot), Kiro (workspace), and Continue.dev.

.PARAMETER All
  Install to all supported agents without prompting.

.PARAMETER Agent
  Install to a specific agent: cursor, antigravity, claude, windsurf, vscode, continue, kiro

.EXAMPLE
  .\scripts\install-agents.ps1 -All
  .\scripts\install-agents.ps1 -Agent antigravity
#>

param(
    [switch]$All,
    [ValidateSet("cursor", "antigravity", "claude", "windsurf", "vscode", "continue", "kiro", "all")]
    [string]$Agent = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ServerEntry = Join-Path $Root "dist\index.js"

if (-not (Test-Path $ServerEntry)) {
    Write-Host "ERROR: Server not built. Run: npm run build" -ForegroundColor Red
    exit 1
}

$configPath = Join-Path $Root "reforger-forge.config.json"
if (-not (Test-Path $configPath)) {
    Copy-Item (Join-Path $Root "reforger-forge.config.example.json") $configPath
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json

$envBlock = [ordered]@{
    ENFUSION_WORKBENCH_PATH = $config.workbenchPath
    ENFUSION_GAME_PATH      = $config.gamePath
    ENFUSION_PROJECT_PATH   = $config.projectPath
    ENFUSION_WORKBENCH_HOST = $config.workbenchHost
    ENFUSION_WORKBENCH_PORT = "$($config.workbenchPort)"
}

# Standard mcpServers entry (Cursor, Antigravity, Windsurf, Claude, Continue, Kiro)
$stdioEntry = [ordered]@{
    command = "node"
    args    = @($ServerEntry)
    env     = $envBlock
}

# VS Code uses "servers" with type: stdio
$vscodeEntry = [ordered]@{
    type    = "stdio"
    command = "node"
    args    = @($ServerEntry)
    env     = $envBlock
}

function Merge-McpServers {
    param(
        [string]$Path,
        [hashtable]$Entry,
        [string]$Key = "reforger-forge",
        [string]$RootKey = "mcpServers"
    )
    $dir = Split-Path $Path -Parent
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    if (Test-Path $Path) {
        $existing = Get-Content $Path -Raw | ConvertFrom-Json
    } else {
        $existing = [PSCustomObject]@{}
    }
    if (-not $existing.$RootKey) {
        $existing | Add-Member -NotePropertyName $RootKey -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    $existing.$RootKey | Add-Member -NotePropertyName $Key -NotePropertyValue $Entry -Force
    $existing | ConvertTo-Json -Depth 10 | Set-Content $Path -Encoding UTF8
    Write-Host "  Updated: $Path" -ForegroundColor Green
}

function Install-Cursor {
    Merge-McpServers -Path (Join-Path $env:USERPROFILE ".cursor\mcp.json") -Entry $stdioEntry
}

function Install-Antigravity {
    Merge-McpServers -Path (Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json") -Entry $stdioEntry
}

function Install-Claude {
    Merge-McpServers -Path (Join-Path $env:APPDATA "Claude\claude_desktop_config.json") -Entry $stdioEntry
}

function Install-Windsurf {
    Merge-McpServers -Path (Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json") -Entry $stdioEntry
}

function Install-VSCode {
    # User-level
    Merge-McpServers -Path (Join-Path $env:APPDATA "Code\User\mcp.json") -Entry $vscodeEntry -RootKey "servers"
    # Workspace-level
    $wsDir = Join-Path $Root ".vscode"
    New-Item -ItemType Directory -Force -Path $wsDir | Out-Null
    Merge-McpServers -Path (Join-Path $wsDir "mcp.json") -Entry $vscodeEntry -RootKey "servers"
}

function Install-Continue {
    $path = Join-Path $env:USERPROFILE ".continue\config.json"
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if (Test-Path $path) {
        $existing = Get-Content $path -Raw | ConvertFrom-Json
    } else {
        $existing = [PSCustomObject]@{}
    }
    if (-not $existing.mcpServers) {
        $existing | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    $existing.mcpServers | Add-Member -NotePropertyName "reforger-forge" -NotePropertyValue $stdioEntry -Force
    $existing | ConvertTo-Json -Depth 10 | Set-Content $path -Encoding UTF8
    Write-Host "  Updated: $path" -ForegroundColor Green
}

function Install-Kiro {
    $kiroDir = Join-Path $Root ".kiro\settings"
    New-Item -ItemType Directory -Force -Path $kiroDir | Out-Null
    $entry = [ordered]@{
        command     = "node"
        args        = @($ServerEntry)
        env         = $envBlock
        disabled    = $false
        autoApprove = @()
    }
    Merge-McpServers -Path (Join-Path $kiroDir "mcp.json") -Entry $entry
}

$agents = @{
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
    Write-Host "  cursor, antigravity, claude, windsurf, vscode, continue, kiro"
    Write-Host "  Or use: -All   or   -Agent antigravity"
    Write-Host ""
    $input = Read-Host "Agents (or 'all')"
    if ($input -eq "all") {
        foreach ($key in $agents.Keys) {
            Write-Host "Installing: $($agents[$key].Name)..." -ForegroundColor Yellow
            & $agents[$key].Fn
        }
    } else {
        foreach ($key in ($input -split "," | ForEach-Object { $_.Trim() })) {
            if ($agents.ContainsKey($key)) {
                Write-Host "Installing: $($agents[$key].Name)..." -ForegroundColor Yellow
                & $agents[$key].Fn
            } else {
                Write-Host "Unknown agent: $key" -ForegroundColor Red
            }
        }
    }
}

Write-Host ""
Write-Host "Done! Restart your agent and verify 'reforger-forge' shows 50 tools." -ForegroundColor Green
Write-Host ""
Write-Host "Agent config locations:" -ForegroundColor Cyan
Write-Host "  Cursor:       $env:USERPROFILE\.cursor\mcp.json"
Write-Host "  Antigravity:  $env:USERPROFILE\.gemini\config\mcp_config.json"
Write-Host "  Claude:       $env:APPDATA\Claude\claude_desktop_config.json"
Write-Host "  Windsurf:     $env:USERPROFILE\.codeium\windsurf\mcp_config.json"
Write-Host "  VS Code:      $env:APPDATA\Code\User\mcp.json"
Write-Host "  Continue:     $env:USERPROFILE\.continue\config.json"
Write-Host "  Kiro:         $Root\.kiro\settings\mcp.json"
