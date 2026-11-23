param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$ReportPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:textLimit = 8MB
$script:totalTextLimit = 512MB
$script:archiveLimit = 1GB
$script:totalArchiveLimit = 3GB
$script:archiveBytesRead = 0L
$script:entryLimit = 30000
$script:maxDepth = 8
$script:binaryExtensions = @('.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov', '.mp3', '.wav', '.pdf', '.exe', '.dll', '.bin', '.ico', '.woff', '.woff2')
$script:report = [ordered]@{
    entriesVisited = 0
    archivesOpened = 0
    textFilesRead = 0
    textBytesRead = 0
    nestedArchiveBytesRead = 0
    skipped = [System.Collections.Generic.List[object]]::new()
    encodings = @{}
    limits = @{ textBytes = $script:textLimit; totalTextBytes = $script:totalTextLimit; archiveBytes = $script:archiveLimit; totalArchiveBytes = $script:totalArchiveLimit; entries = $script:entryLimit; nestingDepth = $script:maxDepth }
}
$script:scratchDirectory = Join-Path ([IO.Path]::GetTempPath()) ('prompttap-import-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $script:scratchDirectory
$script:writer = [IO.StreamWriter]::new($OutputPath, $false, [Text.UTF8Encoding]::new($false))

function Add-Skip([string]$Source, [string]$Reason) {
    $script:report.skipped.Add(@{ source = $Source; reason = $Reason })
}

function Start-Tar([string[]]$Arguments) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new('tar')
    foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # Windows bsdtar emits filenames in the system ANSI code page.
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    if ($IsWindows) { $startInfo.StandardOutputEncoding = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage) }
    $startInfo.CreateNoWindow = $true
    return [Diagnostics.Process]::Start($startInfo)
}

function Get-TarEntries([string]$Path) {
    $process = Start-Tar @('-tf', $Path)
    try {
        $errors = $process.StandardError.ReadToEndAsync()
        $listing = $process.StandardOutput.ReadToEnd()
        $process.WaitForExit()
        $errorText = $errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Archive listing failed ($($process.ExitCode)): $errorText" }
        return ($listing -split '\r?\n' | Where-Object { $_ -ne '' })
    } finally { $process.Dispose() }
}

function Copy-LimitedStream([IO.Stream]$InputStream, [IO.Stream]$OutputStream, [long]$Limit, [bool]$IsArchive = $false) {
    $buffer = [byte[]]::new(65536)
    $total = 0L
    while (($read = $InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $total += $read
        if ($total -gt $Limit) { throw 'Expanded entry exceeds size limit' }
        if ($IsArchive) {
            $script:archiveBytesRead += $read
            $script:report.nestedArchiveBytesRead = $script:archiveBytesRead
            if ($script:archiveBytesRead -gt $script:totalArchiveLimit) { throw 'Total expanded archive size limit reached' }
        }
        $OutputStream.Write($buffer, 0, $read)
    }
}

function Read-TextEntry([IO.Stream]$Stream, [string]$Source, [string]$Name) {
    $memory = [IO.MemoryStream]::new()
    try {
        Copy-LimitedStream $Stream $memory $script:textLimit
        $bytes = $memory.ToArray()
        if (($script:report.textBytesRead + $bytes.Length) -gt $script:totalTextLimit) { throw 'Total text size limit reached' }
        $encodingName = 'utf-8'
        if ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
            $content = [Text.Encoding]::Unicode.GetString($bytes)
            $encodingName = 'utf-16le'
        } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
            $content = [Text.Encoding]::BigEndianUnicode.GetString($bytes)
            $encodingName = 'utf-16be'
        } else {
            try { $content = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
            catch {
                $content = [Text.Encoding]::GetEncoding(1251).GetString($bytes)
                $encodingName = 'windows-1251'
            }
        }
        $content = $content.TrimStart([char]0xFEFF)
        if ([string]::IsNullOrWhiteSpace($content)) { Add-Skip $Source 'Empty text'; return }
        $controlCount = [regex]::Matches($content, '[\x00-\x08\x0B\x0C\x0E-\x1F]').Count
        if ($content.Contains([char]0) -or $controlCount -gt [Math]::Max(3, $content.Length / 100)) { Add-Skip $Source 'Binary content in text entry'; return }
        $script:writer.WriteLine((@{ name = $Name; source = $Source; content = $content } | ConvertTo-Json -Compress -Depth 4))
        $script:report.textFilesRead++
        $script:report.textBytesRead += $bytes.Length
        $script:report.encodings[$encodingName] = 1 + $script:report.encodings[$encodingName]
    } finally { $memory.Dispose() }
}

function Read-Zip([string]$Path, [string]$Source, [int]$Depth) {
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $script:report.archivesOpened++
        foreach ($entry in $zip.Entries) {
            if (!$entry.Name) { continue }
            $script:report.entriesVisited++
            $entrySource = "$Source :: $($entry.FullName)"
            if ($script:report.entriesVisited -gt $script:entryLimit) { Add-Skip $Source 'Total entry limit reached'; break }
            $extension = [IO.Path]::GetExtension($entry.Name).ToLowerInvariant()
            if ($extension -notin $script:binaryExtensions -and $extension -notin '.zip', '.rar', '.7z') {
                if ($entry.Length -gt $script:textLimit) { Add-Skip $entrySource 'Text entry exceeds size limit'; continue }
                $stream = $entry.Open()
                try { Read-TextEntry $stream $entrySource $entry.Name }
                catch { Add-Skip $entrySource $_.Exception.Message }
                finally { $stream.Dispose() }
            } elseif ($extension -in '.zip', '.rar', '.7z') {
                if ($Depth -ge $script:maxDepth) { Add-Skip $entrySource 'Nesting depth limit reached'; continue }
                if ($entry.Length -gt $script:archiveLimit) { Add-Skip $entrySource 'Nested archive exceeds size limit'; continue }
                # An archive member name is never used as a destination path.
                $temporaryPath = Join-Path $script:scratchDirectory ([guid]::NewGuid().ToString('N') + $extension)
                try {
                    $inputStream = $entry.Open()
                    $outputStream = [IO.File]::Create($temporaryPath)
                    try { Copy-LimitedStream $inputStream $outputStream $script:archiveLimit $true }
                    finally { $inputStream.Dispose(); $outputStream.Dispose() }
                    Read-Archive $temporaryPath $entrySource ($Depth + 1)
                } catch { Add-Skip $entrySource $_.Exception.Message }
                finally { if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath } }
            } else { Add-Skip $entrySource 'Unsupported file format' }
        }
    } finally { $zip.Dispose() }
}

function Read-TarArchive([string]$Path, [string]$Source, [int]$Depth) {
    $entries = @(Get-TarEntries $Path)
    $script:report.archivesOpened++
    foreach ($name in $entries) {
        if ($name.EndsWith('/')) { continue }
        $script:report.entriesVisited++
        $entrySource = "$Source :: $name"
        if ($script:report.entriesVisited -gt $script:entryLimit) { Add-Skip $Source 'Total entry limit reached'; break }
        $extension = [IO.Path]::GetExtension($name).ToLowerInvariant()
        if ($extension -in $script:binaryExtensions) { Add-Skip $entrySource 'Unsupported file format'; continue }
        $isArchive = $extension -in '.zip', '.rar', '.7z'
        if ($isArchive -and $Depth -ge $script:maxDepth) { Add-Skip $entrySource 'Nesting depth limit reached'; continue }
        $process = Start-Tar @('-xOf', $Path, '--', $name)
        $errorTask = $process.StandardError.ReadToEndAsync()
        $temporaryPath = $null
        try {
            if ($isArchive) {
                $temporaryPath = Join-Path $script:scratchDirectory ([guid]::NewGuid().ToString('N') + $extension)
                $outputStream = [IO.File]::Create($temporaryPath)
                try { Copy-LimitedStream $process.StandardOutput.BaseStream $outputStream $script:archiveLimit $true }
                finally { $outputStream.Dispose() }
            } else {
                Read-TextEntry $process.StandardOutput.BaseStream $entrySource ([IO.Path]::GetFileName($name))
            }
            $process.WaitForExit()
            $errorText = $errorTask.GetAwaiter().GetResult()
            if ($process.ExitCode -ne 0) { throw "Archive entry read failed ($($process.ExitCode)): $errorText" }
            if ($isArchive) { Read-Archive $temporaryPath $entrySource ($Depth + 1) }
        } catch {
            if (!$process.HasExited) { $process.Kill($true) }
            Add-Skip $entrySource $_.Exception.Message
        } finally {
            $process.Dispose()
            if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) { Remove-Item -LiteralPath $temporaryPath }
        }
    }
}

function Read-Archive([string]$Path, [string]$Source, [int]$Depth) {
    if ([IO.Path]::GetExtension($Path).ToLowerInvariant() -eq '.zip') { Read-Zip $Path $Source $Depth }
    else { Read-TarArchive $Path $Source $Depth }
}

try {
    Read-Archive ([IO.Path]::GetFullPath($ArchivePath)) ([IO.Path]::GetFileName($ArchivePath)) 0
} finally {
    $script:writer.Dispose()
    $script:report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
    # Only remove our known empty scratch directory. Each temporary archive is removed above.
    Remove-Item -LiteralPath $script:scratchDirectory
}
