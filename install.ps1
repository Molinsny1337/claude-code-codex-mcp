# One-click installer for Claude Code Codex MCP on Windows
$ErrorActionPreference = "Stop"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Installing Claude Code Codex MCP (Windows) " -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

$CurrentDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $CurrentDir

Write-Host "[1/3] Installing dependencies..." -ForegroundColor Yellow
npm install

Write-Host "[2/3] Verifying MCP server..." -ForegroundColor Yellow
node test/test.mjs

Write-Host "[3/3] Registering with Claude Code (user scope)..." -ForegroundColor Yellow
$IndexPath = Join-Path $CurrentDir "src\index.mjs"

# Execute claude mcp add
try {
    claude mcp add -s user codex node $IndexPath
    Write-Host "`n[SUCCESS] Successfully added 'codex' MCP server to Claude Code!" -ForegroundColor Green
    Write-Host "Run 'claude mcp list' to check server status." -ForegroundColor Green
} catch {
    Write-Host "`n[NOTICE] 'claude' CLI not in PATH or command failed." -ForegroundColor Yellow
    Write-Host "Add manually via: claude mcp add -s user codex node `"$IndexPath`"" -ForegroundColor Cyan
}
