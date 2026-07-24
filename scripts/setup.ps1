#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for ReforgerForge MCP.

.DESCRIPTION
  - Installs npm dependencies and builds the server
  - Verifies required tools register and prints the discovered count
  - Optionally installs reforger-forge into supported MCP clients
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "ReforgerForge MCP Setup" -ForegroundColor Cyan
Write-Host "=======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Repo: $Root"

$requiredAssets = @(
    "reforger-forge.config.example.json",
    "scripts\verify-mcp-server.mjs",
    "agents\install-agents.ps1",
    "scripts\windows\workbench-lifecycle.ps1",
    "agents\AGENTS.md",
    "agents\configs\claude-desktop.json",
    "agents\configs\cursor-global.json"
)
foreach ($asset in $requiredAssets) {
    if (-not (Test-Path (Join-Path $Root $asset) -PathType Leaf)) {
        Write-Host "ERROR: Required package asset is missing: $asset" -ForegroundColor Red
        exit 1
    }
}

# Check Node.js
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Host "ERROR: Node.js 20+ is required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}
$nodeVersion = & $nodeCommand.Source --version 2>$null
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion -or $nodeVersion -notmatch '^v?(?<major>\d+)(?:\.|$)') {
    Write-Host "ERROR: Could not determine the installed Node.js version." -ForegroundColor Red
    exit 1
}
$nodeMajor = [int]$Matches.major
if ($nodeMajor -lt 20) {
    Write-Host "ERROR: Node.js 20+ is required (found $nodeVersion)." -ForegroundColor Red
    exit 1
}
Write-Host "Node.js: $nodeVersion"

# Create the explicitly selected config if missing, then stop so placeholder
# installation paths cannot be mistaken for a valid setup.
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    $configDirectory = Split-Path $ConfigPath -Parent
    if ($configDirectory -and -not (Test-Path -LiteralPath $configDirectory)) {
        New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $Root "reforger-forge.config.example.json") -Destination $ConfigPath
    Write-Host "Created $ConfigPath" -ForegroundColor Yellow
    Write-Host "Edit its required paths, then rerun this exact setup command." -ForegroundColor Yellow
    exit 2
}

# Build
Write-Host ""
Write-Host "Building..." -ForegroundColor Yellow
Push-Location $Root
npm.cmd install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location
Write-Host "Build complete." -ForegroundColor Green

# List tools
Write-Host ""
Write-Host "Verifying tools..." -ForegroundColor Yellow
node (Join-Path $Root "scripts\verify-mcp-server.mjs") --config $ConfigPath
if ($LASTEXITCODE -ne 0) { exit 1 }

# Optional MCP client installation
Write-Host ""
$answer = Read-Host "Install into AI agents? (all/codex/cursor/antigravity/claude/windsurf/vscode/continue/kiro/n)"
if ($answer -eq "all") {
    & (Join-Path $Root "agents\install-agents.ps1") -ConfigPath $ConfigPath -All
} elseif ($answer -ne "n" -and $answer -ne "N" -and $answer -ne "") {
    & (Join-Path $Root "agents\install-agents.ps1") -ConfigPath $ConfigPath -Agent $answer
}

Write-Host ""
Write-Host "Setup complete! Open this folder as your workspace." -ForegroundColor Green
