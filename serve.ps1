param([int]$Port = 8000)

$root = $PSScriptRoot
$prefix = "http://localhost:$Port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try { $listener.Start() } catch {
  Write-Host "Failed to start on port $Port. Try a different port: .\serve.ps1 -Port 8001" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  SPUD SHOCKERS  " -ForegroundColor Yellow -BackgroundColor DarkRed
Write-Host ""
Write-Host "Open: $prefix" -ForegroundColor Cyan
Write-Host "Stop: Ctrl+C" -ForegroundColor DarkGray
Write-Host ""

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $url = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ($url -eq '/') { $url = '/index.html' }
      $rel = $url.TrimStart('/').Replace('/', '\')
      $file = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      $rootFull = [System.IO.Path]::GetFullPath($root)

      if (-not $file.StartsWith($rootFull)) {
        $res.StatusCode = 403
      } elseif (Test-Path $file -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        # Disable caching so browser refresh always picks up the latest JS/CSS.
        $res.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate')
        $res.Headers.Add('Pragma', 'no-cache')
        $res.Headers.Add('Expires', '0')
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        $msg = [Text.Encoding]::UTF8.GetBytes('Not found')
        $res.OutputStream.Write($msg, 0, $msg.Length)
      }
      Write-Host ("  {0,3}  {1}" -f $res.StatusCode, $url) -ForegroundColor DarkGray
    } catch {
      $res.StatusCode = 500
    } finally {
      $res.Close()
    }
  }
} finally {
  $listener.Stop()
}
