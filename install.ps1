#!/usr/bin/env pwsh
# Rebuild, package and install the VS Code extension into the local VS Code.
# Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).
# Use Continue: native tools (npx/code) may write warnings to stderr; failures are
# detected via $LASTEXITCODE below instead of PowerShell's stderr-to-error conversion.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host '[ext] npm install ...'
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

Write-Host '[ext] typecheck ...'
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }

Write-Host '[ext] build ...'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

Write-Host '[ext] package vsix ...'
npx @vscode/vsce package --allow-missing-repository --skip-license --no-dependencies
if ($LASTEXITCODE -ne 0) { throw 'vsce package failed' }

$vsix = Get-ChildItem $PSScriptRoot -Filter 'embedded-workbench-*.vsix' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $vsix) { throw 'vsix not found' }

Write-Host "[ext] install $($vsix.Name) ..."
& code --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw 'code --install-extension failed' }

Write-Host '[ext] done. In VS Code: "Developer: Reload Window" to activate it.'
