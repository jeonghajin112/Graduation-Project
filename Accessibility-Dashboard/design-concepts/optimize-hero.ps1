$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$projectDir = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectDir "src\assets\landing\candidates\ima2-20260721-215047-1.png"
$outputDir = Join-Path $projectDir "src\assets\landing"

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Hero source image was not found: $sourcePath"
}

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq "image/jpeg" } |
  Select-Object -First 1

$qualityEncoder = [System.Drawing.Imaging.Encoder]::Quality
$encoderParameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($qualityEncoder, [long]84)

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

try {
  foreach ($width in @(640, 1024, 1600)) {
    $height = [int][Math]::Round($sourceImage.Height * ($width / $sourceImage.Width))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    try {
      $graphics.Clear([System.Drawing.Color]::FromArgb(246, 247, 244))
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($sourceImage, 0, 0, $width, $height)

      $destination = Join-Path $outputDir "accessibility-optics-$width.jpg"
      $bitmap.Save($destination, $jpegCodec, $encoderParameters)
    }
    finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
}
finally {
  $sourceImage.Dispose()
  $encoderParameters.Dispose()
}

Get-ChildItem -LiteralPath $outputDir -Filter "accessibility-optics-*.jpg" |
  Sort-Object Name |
  Select-Object Name, Length, LastWriteTime
