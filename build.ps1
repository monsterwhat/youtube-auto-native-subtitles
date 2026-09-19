#Requires -Version 5.1
<#
.SYNOPSIS
  Packages the extension into a versioned zip for AMO upload or local install.
.DESCRIPTION
  Validates manifest.json, syntax-checks every JS file when node is
  available, then zips the extension files (manifest at the zip root)
  into dist\youtube-auto-native-subtitles-<version>.zip.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File build.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectDir = $PSScriptRoot,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
  if ($PSScriptRoot) {
    $ProjectDir = $PSScriptRoot
  } else {
    $ProjectDir = (Get-Location).Path
  }
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $ProjectDir 'dist'
}

$manifestPath = Join-Path $ProjectDir 'manifest.json'
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} catch {
  throw "manifest.json is not valid JSON: $_"
}
$version = $manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw 'manifest.json has no version field.'
}
Write-Host "Building $($manifest.name) v$version ..."

$files = @(
  'manifest.json',
  'background.js',
  'content.js',
  'defaults.js',
  'injected.js',
  'options.js',
  'options.html'
)
$missing = @($files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ProjectDir $_)) })
if ($missing.Count -gt 0) {
  throw "Missing files: $($missing -join ', ')"
}
$iconsDir = Join-Path $ProjectDir 'icons'
$icons = @(Get-ChildItem -LiteralPath $iconsDir -Filter '*.png' -ErrorAction SilentlyContinue)
if ($icons.Count -eq 0) {
  throw 'No PNG icons found in icons/.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  foreach ($js in @($files | Where-Object { $_ -like '*.js' })) {
    & node --check (Join-Path $ProjectDir $js)
    if ($LASTEXITCODE -ne 0) {
      throw "Syntax check failed: $js"
    }
  }
  Write-Host 'JS syntax OK.'
} else {
  Write-Warning 'node not found on PATH, skipping syntax checks.'
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$zipName = "youtube-auto-native-subtitles-$version.zip"
$zipPath = Join-Path $OutDir $zipName
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('anns-build-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($f in $files) {
    Copy-Item -LiteralPath (Join-Path $ProjectDir $f) -Destination $stage -Force
  }
  $stageIcons = Join-Path $stage 'icons'
  New-Item -ItemType Directory -Path $stageIcons | Out-Null
  Copy-Item -LiteralPath (Join-Path $iconsDir '*') -Destination $stageIcons -Recurse -Force
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -Force
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

$zipItem = Get-Item -LiteralPath $zipPath
Write-Host ("Built: {0} ({1} bytes)" -f $zipItem.FullName, $zipItem.Length)
