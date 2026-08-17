$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
$pngPath = Join-Path $buildDir 'icon.png'
$icoPath = Join-Path $buildDir 'icon.ico'

$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
try {
    $bounds = [System.Drawing.Rectangle]::new(0, 0, 256, 256)
    $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $bounds,
        [System.Drawing.Color]::FromArgb(18, 21, 26),
        [System.Drawing.Color]::FromArgb(6, 8, 10),
        45
    )
    $graphics.FillRectangle($background, $bounds)
    $background.Dispose()

    $accent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(167, 244, 60))
    $graphics.FillEllipse($accent, 37, 37, 182, 182)
    $accent.Dispose()

    $inner = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(18, 22, 15))
    $graphics.FillEllipse($inner, 54, 54, 148, 148)
    $inner.Dispose()

    $font = [System.Drawing.Font]::new('Segoe UI', 104, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(194, 255, 111))
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString('P', $font, $textBrush, [System.Drawing.RectangleF]::new(0, -6, 256, 256), $format)
    $format.Dispose()
    $textBrush.Dispose()
    $font.Dispose()

    $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    try {
        $stream = [System.IO.File]::Create($icoPath)
        try { $icon.Save($stream) } finally { $stream.Dispose() }
    } finally {
        $icon.Dispose()
    }
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

