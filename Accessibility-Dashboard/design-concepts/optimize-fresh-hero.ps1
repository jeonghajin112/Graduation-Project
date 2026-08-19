$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$projectDir = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectDir "design-concepts\fresh-asset-candidates\ima2-20260721-231255-0.png"
$outputDir = Join-Path $projectDir "src\assets\landing\fresh"

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Fresh hero source image was not found: $sourcePath"
}

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq "image/jpeg" } |
  Select-Object -First 1

$qualityEncoder = [System.Drawing.Imaging.Encoder]::Quality
$encoderParameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($qualityEncoder, [long]60)

$variants = @(
  @{ Name = "signal-path-640.jpg"; Width = 640; Height = 480 },
  @{ Name = "signal-path-1024.jpg"; Width = 1024; Height = 640 },
  @{ Name = "signal-path-1600.jpg"; Width = 1600; Height = 900 }
)

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

try {
  foreach ($variant in $variants) {
    $targetRatio = $variant.Width / $variant.Height
    $sourceRatio = $sourceImage.Width / $sourceImage.Height

    if ($sourceRatio -gt $targetRatio) {
      $cropHeight = $sourceImage.Height
      $cropWidth = [int][Math]::Round($cropHeight * $targetRatio)
      $cropX = [int][Math]::Round(($sourceImage.Width - $cropWidth) / 2)
      $cropY = 0
    }
    else {
      $cropWidth = $sourceImage.Width
      $cropHeight = [int][Math]::Round($cropWidth / $targetRatio)
      $cropX = 0
      $cropY = [int][Math]::Round(($sourceImage.Height - $cropHeight) / 2)
    }

    $bitmap = New-Object System.Drawing.Bitmap($variant.Width, $variant.Height)
    $bitmap.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    try {
      $graphics.Clear([System.Drawing.Color]::FromArgb(16, 17, 15))
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

      $destinationRect = New-Object System.Drawing.Rectangle(0, 0, $variant.Width, $variant.Height)
      $graphics.DrawImage(
        $sourceImage,
        $destinationRect,
        $cropX,
        $cropY,
        $cropWidth,
        $cropHeight,
        [System.Drawing.GraphicsUnit]::Pixel
      )

      $destination = Join-Path $outputDir $variant.Name
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

Get-ChildItem -LiteralPath $outputDir -Filter "signal-path-*.jpg" |
  Sort-Object Name |
  Select-Object Name, Length, LastWriteTime
