@echo off
setlocal
title Twitch Tab Manager - Firefox AMO build

set "TTM_FIREFOX_BUILD_BAT=%~f0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$raw=[System.IO.File]::ReadAllText($env:TTM_FIREFOX_BUILD_BAT); $marker='###__TTM_FIREFOX_AMO_POWERSHELL__###'; $i=$raw.LastIndexOf($marker); if($i -lt 0){ throw 'Embedded PowerShell marker not found.' }; $script=$raw.Substring($i+$marker.Length).TrimStart([char]13,[char]10); Invoke-Expression $script"

if errorlevel 1 (
    echo.
    echo ============================================================
    echo  FIREFOX BUILD FAILED
    echo ============================================================
    pause
    exit /b 1
)

echo.
pause
exit /b 0

###__TTM_FIREFOX_AMO_POWERSHELL__###
$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------
# Twitch Tab Manager - Firefox / AMO builder
# Preferred project root:
# D:\Documents\GitHub\Twitch-Tab-Manager
#
# The BAT can live in the repo root OR elsewhere. If the
# preferred path exists, it is used. Otherwise parent folders
# of the BAT are searched for manifest.json.
# ------------------------------------------------------------
$preferredRoot = 'D:\Documents\GitHub\Twitch-Tab-Manager'
$root = $null

if (Test-Path -LiteralPath (Join-Path $preferredRoot 'manifest.json') -PathType Leaf) {
    $root = $preferredRoot
}
else {
    $batPath = $env:TTM_FIREFOX_BUILD_BAT
    if ([string]::IsNullOrWhiteSpace($batPath)) {
        throw 'Could not determine the BAT path.'
    }

    $probe = Split-Path -Parent $batPath
    for ($i = 0; $i -lt 7 -and $probe; $i++) {
        if (Test-Path -LiteralPath (Join-Path $probe 'manifest.json') -PathType Leaf) {
            $root = $probe
            break
        }
        $parent = Split-Path -Parent $probe
        if ($parent -eq $probe) { break }
        $probe = $parent
    }
}

if (-not $root) {
    throw 'Could not find Twitch Tab Manager project root. Expected D:\Documents\GitHub\Twitch-Tab-Manager or a BAT parent folder containing manifest.json.'
}

$sourceManifest = Join-Path $root 'manifest.json'
$source = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
$version = [string]$source.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'manifest.json does not contain a version.'
}

$buildBase = Join-Path $root 'firefox_build'
$stage = Join-Path $buildBase 'twitch-tab-manager-firefox'
$zip = Join-Path $buildBase ("twitch-tab-manager-firefox-$version.zip")
$latestZip = Join-Path $buildBase 'twitch-tab-manager-firefox.zip'
$stageManifest = Join-Path $stage 'manifest.json'

$firefoxId = 'twitch-tab-manager@drache.uk'
$firefoxMinVersion = '140.0'
$homepage = 'https://github.com/drachescript/Twitch-Tab-Manager'

Write-Host ''
Write-Host '============================================================'
Write-Host ' Twitch Tab Manager - Firefox AMO build'
Write-Host '============================================================'
Write-Host ('Source:      ' + $root)
Write-Host ('Version:     ' + $version)
Write-Host ('Stage:       ' + $stage)
Write-Host ('Version ZIP: ' + $zip)
Write-Host ('Latest ZIP:  ' + $latestZip)
Write-Host ''

if ($stage -notlike "$root\firefox_build\*") {
    throw "Safety check failed: stage is not inside $root\firefox_build"
}
if ($zip -notlike "$root\firefox_build\*") {
    throw "Safety check failed: ZIP is not inside $root\firefox_build"
}

New-Item -ItemType Directory -Force -Path $buildBase | Out-Null

Write-Host '[1/8] Cleaning previous Firefox build...'
foreach ($path in @($zip, $latestZip)) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Remove-Item -LiteralPath $path -Force
    }
}
if (Test-Path -LiteralPath $stage -PathType Container) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host '[2/8] Copying extension source...'

$excludedDirs = @(
    '.git',
    '.github',
    'node_modules',
    'archive',
    '_zip_stage',
    'firefox_build',
    'dev_build',
    'release_build'
)

$excludedExtensions = @('.zip', '.xpi', '.crx', '.bat')
$excludedNames = @('.gitattributes', '.gitignore', 'README_old.md')

$rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
$prefixLen = $rootFull.Length + 1

Get-ChildItem -LiteralPath $root -File -Recurse -Force | ForEach-Object {
    $fileFull = [System.IO.Path]::GetFullPath($_.FullName)
    if (-not $fileFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $relative = $fileFull.Substring($prefixLen)
    $parts = $relative -split '[\\/]'

    $skipDir = $false
    foreach ($part in $parts) {
        if ($part -in $excludedDirs) {
            $skipDir = $true
            break
        }
    }
    if ($skipDir) { return }
    if ($_.Extension.ToLowerInvariant() -in $excludedExtensions) { return }
    if ($_.Name -in $excludedNames) { return }

    $dest = Join-Path $stage $relative
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
}

if (-not (Test-Path -LiteralPath $stageManifest -PathType Leaf)) {
    throw 'manifest.json was not copied into the Firefox staging folder.'
}
if (-not (Test-Path -LiteralPath (Join-Path $stage 'background.js') -PathType Leaf)) {
    throw 'background.js is missing from the Firefox staging folder.'
}

Write-Host '[3/8] Converting manifest.json for Firefox / AMO...'

$manifest = Get-Content -LiteralPath $stageManifest -Raw | ConvertFrom-Json

# Firefox MV3 currently uses background scripts/event pages rather than
# extension service workers. TTM background.js is an ES module entry point,
# so keep type=module when converting.
$manifest.background = [pscustomobject]@{
    scripts = @('background.js')
    type = 'module'
}

# Use the modern Firefox options-page declaration and keep it in a normal tab,
# matching how TTM's full Options UI is designed to be used.
$manifest | Add-Member -NotePropertyName options_ui -NotePropertyValue ([pscustomobject]@{
    page = 'options.html'
    open_in_tab = $true
}) -Force
if ($manifest.PSObject.Properties.Name -contains 'options_page') {
    $manifest.PSObject.Properties.Remove('options_page')
}

# New AMO submissions must declare Firefox data transmission. TTM does not
# send telemetry or data to developer-controlled servers, but when configured
# it sends Twitch authentication information and Twitch page/channel-derived
# data directly to Twitch for the add-on's core functionality.
$geckoSettings = [pscustomobject]@{
    id = $firefoxId
    strict_min_version = $firefoxMinVersion
    data_collection_permissions = [pscustomobject]@{
        required = @(
            'authenticationInfo',
            'websiteContent'
        )
    }
}

# Desktop Firefox only for now. Do NOT add gecko_android until TTM's dedicated
# window/tab-management behavior has been explicitly tested on Firefox Android.
$manifest | Add-Member -NotePropertyName browser_specific_settings -NotePropertyValue ([pscustomobject]@{
    gecko = $geckoSettings
}) -Force

$manifest | Add-Member -NotePropertyName homepage_url -NotePropertyValue $homepage -Force

# The source currently includes a cookies permission even though most Twitch
# authentication is performed through normal HTTPS fetches. Keep the source
# permission set unchanged for first Firefox testing; remove only after a
# dedicated permission audit so Firefox and Chromium behavior do not diverge.

$json = $manifest | ConvertTo-Json -Depth 100
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($stageManifest, $json, $utf8NoBom)

Write-Host '[4/8] Creating Firefox-sized icons...'

$iconsDir = Join-Path $stage 'icons'
$icon192 = Join-Path $iconsDir 'icon192.png'
$icon48 = Join-Path $iconsDir 'icon48.png'
$icon96 = Join-Path $iconsDir 'icon96.png'

if (-not (Test-Path -LiteralPath $icon192 -PathType Leaf)) {
    throw "Base icon not found: $icon192"
}

Add-Type -AssemblyName System.Drawing

function New-ResizedPng([string]$source, [string]$destination, [int]$size) {
    $img = [System.Drawing.Image]::FromFile($source)
    try {
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.DrawImage($img, 0, 0, $size, $size)
            }
            finally {
                $graphics.Dispose()
            }
            $bmp.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $bmp.Dispose()
        }
    }
    finally {
        $img.Dispose()
    }
}

New-ResizedPng $icon192 $icon48 48
New-ResizedPng $icon192 $icon96 96

$manifest = Get-Content -LiteralPath $stageManifest -Raw | ConvertFrom-Json
$iconMap = [pscustomobject]@{
    '16' = 'icons/icon16.png'
    '32' = 'icons/icon32.png'
    '48' = 'icons/icon48.png'
    '96' = 'icons/icon96.png'
    '192' = 'icons/icon192.png'
}
$manifest | Add-Member -NotePropertyName icons -NotePropertyValue $iconMap -Force
if (-not $manifest.action) {
    $manifest | Add-Member -NotePropertyName action -NotePropertyValue ([pscustomobject]@{}) -Force
}
$manifest.action | Add-Member -NotePropertyName default_icon -NotePropertyValue $iconMap -Force

$json = $manifest | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($stageManifest, $json, $utf8NoBom)

Write-Host '[5/8] Verifying Firefox manifest and source tree...'

$manifest = Get-Content -LiteralPath $stageManifest -Raw | ConvertFrom-Json

if ($manifest.manifest_version -ne 3) {
    throw "Expected Manifest V3, found: $($manifest.manifest_version)"
}
if ($manifest.background.scripts -notcontains 'background.js') {
    throw 'Firefox background.scripts conversion failed.'
}
if ($manifest.background.type -ne 'module') {
    throw 'Firefox background module type is missing.'
}
if ($manifest.background.PSObject.Properties.Name -contains 'service_worker') {
    throw 'Firefox manifest still contains background.service_worker.'
}
if ($manifest.browser_specific_settings.gecko.id -ne $firefoxId) {
    throw 'Firefox add-on ID verification failed.'
}
if ($manifest.browser_specific_settings.PSObject.Properties.Name -contains 'gecko_android') {
    throw 'Firefox Android was enabled unexpectedly. TTM desktop build should not advertise Android compatibility yet.'
}
if ($manifest.options_ui.page -ne 'options.html' -or -not $manifest.options_ui.open_in_tab) {
    throw 'Firefox options_ui conversion failed.'
}

$requiredData = @($manifest.browser_specific_settings.gecko.data_collection_permissions.required)
foreach ($needed in @('authenticationInfo', 'websiteContent')) {
    if ($requiredData -notcontains $needed) {
        throw "Firefox data collection declaration is missing: $needed"
    }
}

$missing = New-Object System.Collections.Generic.List[string]
function Test-ManifestFile([string]$relativePath) {
    if ([string]::IsNullOrWhiteSpace($relativePath)) { return }
    if ($relativePath.Contains('*')) { return }
    $normalized = $relativePath -replace '/', '\'
    $full = Join-Path $stage $normalized
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $script:missing.Add($relativePath)
    }
}

foreach ($bg in @($manifest.background.scripts)) { Test-ManifestFile $bg }
if ($manifest.action.default_popup) { Test-ManifestFile $manifest.action.default_popup }
if ($manifest.options_ui.page) { Test-ManifestFile $manifest.options_ui.page }
if ($manifest.icons) {
    foreach ($property in $manifest.icons.PSObject.Properties) {
        Test-ManifestFile ([string]$property.Value)
    }
}
if ($manifest.action.default_icon) {
    foreach ($property in $manifest.action.default_icon.PSObject.Properties) {
        Test-ManifestFile ([string]$property.Value)
    }
}
foreach ($war in @($manifest.web_accessible_resources)) {
    foreach ($resource in @($war.resources)) { Test-ManifestFile $resource }
}

if ($missing.Count -gt 0) {
    $uniqueMissing = $missing | Sort-Object -Unique
    Write-Host ''
    Write-Host 'ERROR: manifest.json references missing files:' -ForegroundColor Red
    foreach ($item in $uniqueMissing) { Write-Host ('  - ' + $item) -ForegroundColor Red }
    throw 'Firefox build stopped because required extension files are missing.'
}

# Catch common accidental package junk.
$badPackagedFiles = Get-ChildItem -LiteralPath $stage -File -Recurse -Force | Where-Object {
    $_.Extension.ToLowerInvariant() -in @('.zip', '.xpi', '.crx', '.bat')
}
if ($badPackagedFiles.Count -gt 0) {
    throw ('Build verification failed: packaged build/archive files found: ' + (($badPackagedFiles | ForEach-Object FullName) -join ', '))
}

Write-Host '[6/8] Running basic JavaScript syntax checks...'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    # node --check treats .js as CommonJS unless a package says module. Use a
    # temporary package.json only in the staging folder for the check, then
    # remove it before packaging.
    $tempPackage = Join-Path $stage 'package.json'
    $hadPackage = Test-Path -LiteralPath $tempPackage -PathType Leaf
    $originalPackage = $null
    if ($hadPackage) { $originalPackage = [System.IO.File]::ReadAllText($tempPackage) }
    [System.IO.File]::WriteAllText($tempPackage, '{"type":"module"}', $utf8NoBom)
    try {
        $jsFiles = Get-ChildItem -LiteralPath $stage -File -Recurse -Filter '*.js'
        foreach ($js in $jsFiles) {
            & $node.Source --check $js.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "JavaScript syntax check failed: $($js.FullName)"
            }
        }
        Write-Host ('      checked ' + $jsFiles.Count + ' JavaScript files')
    }
    finally {
        if ($hadPackage) {
            [System.IO.File]::WriteAllText($tempPackage, $originalPackage, $utf8NoBom)
        }
        elseif (Test-Path -LiteralPath $tempPackage) {
            Remove-Item -LiteralPath $tempPackage -Force
        }
    }
}
else {
    Write-Host '      Node.js not found; skipping optional JS syntax check.'
}

Write-Host '[7/8] Creating AMO-safe ZIPs...'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-AmoZip([string]$sourceDir, [string]$destinationZip) {
    if (Test-Path -LiteralPath $destinationZip) {
        Remove-Item -LiteralPath $destinationZip -Force
    }

    $zipStream = [System.IO.File]::Open(
        $destinationZip,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )

    try {
        $zipArchive = New-Object System.IO.Compression.ZipArchive(
            $zipStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )
        try {
            $sourceFull = [System.IO.Path]::GetFullPath($sourceDir).TrimEnd('\', '/')
            $sourcePrefixLength = $sourceFull.Length + 1

            Get-ChildItem -LiteralPath $sourceDir -File -Recurse -Force |
                Sort-Object FullName |
                ForEach-Object {
                    $fileFull = [System.IO.Path]::GetFullPath($_.FullName)
                    if (-not $fileFull.StartsWith($sourceFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                        throw "Refusing to ZIP file outside staging folder: $fileFull"
                    }

                    $entryName = $fileFull.Substring($sourcePrefixLength).Replace('\', '/')
                    if ([string]::IsNullOrWhiteSpace($entryName)) {
                        throw "Could not create ZIP entry name for: $fileFull"
                    }
                    if ($entryName.Contains('\')) {
                        throw "AMO-invalid ZIP entry path: $entryName"
                    }

                    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                        $zipArchive,
                        $fileFull,
                        $entryName,
                        [System.IO.Compression.CompressionLevel]::Optimal
                    ) | Out-Null
                }
        }
        finally {
            if ($null -ne $zipArchive) { $zipArchive.Dispose() }
        }
    }
    finally {
        $zipStream.Dispose()
    }
}

New-AmoZip $stage $zip
Copy-Item -LiteralPath $zip -Destination $latestZip -Force

Write-Host '[8/8] Verifying final Firefox ZIP...'

$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    $badPaths = @($archive.Entries | Where-Object { $_.FullName.Contains('\') })
    if ($badPaths.Count -gt 0) {
        throw ('ZIP contains AMO-invalid backslash paths: ' + (($badPaths | ForEach-Object FullName) -join ', '))
    }

    $entry = $archive.Entries | Where-Object { $_.FullName -eq 'manifest.json' } | Select-Object -First 1
    if (-not $entry) {
        throw 'ZIP verification failed: manifest.json is not at ZIP root.'
    }

    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $zipManifest = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose() }

    if ($zipManifest.version -ne $version) {
        throw "ZIP verification failed. Version: $($zipManifest.version)"
    }
    if ($zipManifest.background.scripts -notcontains 'background.js') {
        throw 'ZIP verification failed: Firefox background.scripts missing.'
    }
    if ($zipManifest.background.type -ne 'module') {
        throw 'ZIP verification failed: Firefox module background type missing.'
    }
    if ($zipManifest.background.PSObject.Properties.Name -contains 'service_worker') {
        throw 'ZIP verification failed: service_worker still present.'
    }
    if ($zipManifest.browser_specific_settings.gecko.id -ne $firefoxId) {
        throw 'ZIP verification failed: Firefox add-on ID incorrect.'
    }

    $entryCount = $archive.Entries.Count
}
finally {
    $archive.Dispose()
}

$zipInfo = Get-Item -LiteralPath $zip
$sizeMB = [math]::Round($zipInfo.Length / 1MB, 2)

Write-Host ''
Write-Host '============================================================'
Write-Host ' FIREFOX AMO BUILD COMPLETE'
Write-Host '============================================================'
Write-Host ('Version:      ' + $version)
Write-Host ('Firefox ID:   ' + $firefoxId)
Write-Host ('Firefox min:  ' + $firefoxMinVersion)
Write-Host 'Android:      NOT advertised yet (desktop Firefox only)'
Write-Host ('Stage:        ' + $stage)
Write-Host ('Version ZIP:  ' + $zip)
Write-Host ('Latest ZIP:   ' + $latestZip)
Write-Host ('Files:        ' + $entryCount)
Write-Host ('ZIP size:     ' + $sizeMB + ' MB')
Write-Host 'AMO paths:    forward slashes verified'
Write-Host 'Background:   ES-module Firefox background scripts'
Write-Host 'Data declare: authenticationInfo + websiteContent (directly to Twitch)'
Write-Host ''
Write-Host 'Local Firefox test:'
Write-Host '  about:debugging -> This Firefox -> Load Temporary Add-on'
Write-Host ('  Pick: ' + $stageManifest)
Write-Host ''
