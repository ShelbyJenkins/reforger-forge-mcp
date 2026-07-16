#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for ReforgerForge MCP.

.DESCRIPTION
  - Installs npm dependencies and builds the server
  - Verifies required tools register and prints the discovered count
  - Optionally installs reforger-forge into supported MCP clients
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "ReforgerForge MCP Setup" -ForegroundColor Cyan
Write-Host "=======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Repo: $Root"

$requiredAssets = @(
    "reforger-forge.config.example.json",
    "scripts\list-tools.mjs",
    "scripts\install-agents.ps1",
    "scripts\windows\workbench-lifecycle.ps1",
    "docs\AGENTS.md",
    "configs\claude-desktop.json",
    "configs\cursor-global.json"
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

# Create local config if missing
$configPath = Join-Path $Root "reforger-forge.config.json"
if (-not (Test-Path $configPath)) {
    Copy-Item (Join-Path $Root "reforger-forge.config.example.json") $configPath
    Write-Host "Created reforger-forge.config.json - edit your projectPath if needed." -ForegroundColor Yellow
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
node (Join-Path $Root "scripts\list-tools.mjs")
if ($LASTEXITCODE -ne 0) { exit 1 }

# Optional global Cursor config
Write-Host ""
$answer = Read-Host "Install into AI agents? (all/cursor/antigravity/claude/windsurf/vscode/continue/kiro/n)"
if ($answer -eq "all") {
    & (Join-Path $Root "scripts\install-agents.ps1") -All
} elseif ($answer -ne "n" -and $answer -ne "N" -and $answer -ne "") {
    & (Join-Path $Root "scripts\install-agents.ps1") -Agent $answer
}

Write-Host ""
Write-Host "Setup complete! Open this folder as your workspace." -ForegroundColor Green
