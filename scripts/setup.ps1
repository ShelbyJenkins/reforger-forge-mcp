#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup for ReforgerForge MCP.

.DESCRIPTION
  - Installs npm dependencies and builds the server
  - Writes agent config files with correct absolute paths
  - Verifies all 50 tools register
  - Optionally adds reforger-forge to global Cursor MCP config
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ServerEntry = Join-Path $Root "dist\index.js"

Write-Host "ReforgerForge MCP Setup" -ForegroundColor Cyan
Write-Host "=======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Repo: $Root"

# Check Node.js
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "ERROR: Node.js 20+ is required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js: $nodeVersion"

# Create local config if missing
$configPath = Join-Path $Root "reforger-forge.config.json"
if (-not (Test-Path $configPath)) {
    Copy-Item (Join-Path $Root "reforger-forge.config.example.json") $configPath
    Write-Host "Created reforger-forge.config.json - edit your projectPath if needed." -ForegroundColor Yellow
}

# Read config for env vars
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$envBlock = @{
    ENFUSION_WORKBENCH_PATH = $config.workbenchPath
    ENFUSION_GAME_PATH       = $config.gamePath
    ENFUSION_PROJECT_PATH    = $config.projectPath
    ENFUSION_WORKBENCH_HOST  = $config.workbenchHost
    ENFUSION_WORKBENCH_PORT  = "$($config.workbenchPort)"
}

$mcpEntry = @{
    command = "node"
    args    = @($ServerEntry)
    env     = $envBlock
}

# Write agent configs
$cursorDir = Join-Path $Root ".cursor"
$kiroDir   = Join-Path $Root ".kiro\settings"
New-Item -ItemType Directory -Force -Path $cursorDir | Out-Null
New-Item -ItemType Directory -Force -Path $kiroDir   | Out-Null

@{
    mcpServers = @{ "reforger-forge" = $mcpEntry }
} | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $cursorDir "mcp.json") -Encoding UTF8

@{
    mcpServers = @{
        "reforger-forge" = @{
            command  = "node"
            args     = @($ServerEntry)
            env      = $envBlock
            disabled = $false
            autoApprove = @()
        }
    }
} | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $kiroDir "mcp.json") -Encoding UTF8

@{
    mcpServers = @{ "reforger-forge" = $mcpEntry }
} | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $Root "configs\cursor-global.json") -Encoding UTF8

@{
    mcpServers = @{
        "reforger-forge" = @{
            command = "cmd"
            args    = @("/c", "node", $ServerEntry)
            env     = $envBlock
        }
    }
} | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $Root "configs\claude-desktop.json") -Encoding UTF8

Write-Host "Agent configs written." -ForegroundColor Green

# Build
Write-Host ""
Write-Host "Building..." -ForegroundColor Yellow
Push-Location $Root
npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location
Write-Host "Build complete." -ForegroundColor Green

# List tools
Write-Host ""
Write-Host "Verifying tools..." -ForegroundColor Yellow
node (Join-Path $Root "scripts\list-tools.mjs")

# Optional global Cursor config
Write-Host ""
$answer = Read-Host "Add reforger-forge to global Cursor MCP config? (y/n)"
if ($answer -eq "y" -or $answer -eq "Y") {
    $cursorMcp = Join-Path $env:USERPROFILE ".cursor\mcp.json"
    if (Test-Path $cursorMcp) {
        $existing = Get-Content $cursorMcp -Raw | ConvertFrom-Json
    } else {
        $existing = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{} }
    }
    if (-not $existing.mcpServers) {
        $existing | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{})
    }
    $existing.mcpServers | Add-Member -NotePropertyName "reforger-forge" -NotePropertyValue $mcpEntry -Force
    $existing | ConvertTo-Json -Depth 10 | Set-Content $cursorMcp -Encoding UTF8
    Write-Host "Updated $cursorMcp" -ForegroundColor Green
    Write-Host "Restart Cursor: MCP: Restart Servers" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Setup complete! Open this folder as your workspace." -ForegroundColor Green
