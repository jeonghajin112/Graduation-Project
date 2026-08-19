$ErrorActionPreference = "Stop"

$ima2Cli = "C:\Users\hajin\AppData\Roaming\npm\ima2.cmd"
$projectDir = Split-Path -Parent $PSScriptRoot
$outputDir = "src\assets\landing\candidates"

$prompt = @'
Use case: scientific-educational.
Asset type: textless responsive landing-page hero background for a Korean web-accessibility diagnostics product.
Primary request: Create a refined optical analysis instrument made of three distinct inspection systems that converge into one precise circular result target, communicating rule validation, language readability, and visual contrast without showing any interface or words.
Scene/backdrop: A wide cool-paper studio field in exact base color #F6F7F4. The left forty percent is calm negative space with only a few extremely faint horizontal measurement lines so real HTML headline and URL controls can sit there. The main object cluster occupies the center-right.
Subject: Three sequential optical analysis elements aligned from center-left to right: first a broad thin ring with a subtle square rule grid, second a medium ring crossed by flowing parallel language-like ribbons that are abstract and unreadable, third a smaller overlapping aperture pair suggesting contrast. Fine graphite data filaments pass through all three and converge into one clean circular target near the right third. A single coral trace follows the center path and outlines only part of the final target.
Style/medium: Premium scientific editorial still life, precise information sculpture, Korean public-interest technology, physically plausible but gently abstract. It should feel like a museum-grade diagnostic instrument photographed for an annual report.
Composition/framing: Wide 16:9 landscape, straight-on with a slight three-quarter depth so the rings recede from left to right. Leave generous crop-safe space on the left and extra air above the target. No object touches the canvas edge. Mobile center crop must still show at least two rings and the coral target.
Lighting/mood: Large diffused daylight source from upper left, soft natural contact shadows, low anxiety, clear and bright. No theatrical spotlight, no neon, no ambient glow.
Color palette: cool paper #F6F7F4, ceramic white #FFFFFF, pale steel #DDE3E0, graphite #6F7976 used at low opacity, ink #151817 only in a few hairlines, single coral #C94735 under eight percent of the image.
Materials/textures: Ultra-clear optical acrylic, lightly frosted glass edges, matte anodized graphite rings, embossed archival paper, extremely subtle halftone grain. Maintain crisp clean edges.
Text: No text of any kind. No letters, numbers, labels, logos, symbols, badges, buttons, charts, screenshots, or interface components.
Dimensions: 1792x1024 landscape, crop-safe for 16:9 desktop and 4:3 tablet.
Constraints: The visual must remain purely decorative and work behind real HTML. Preserve the quiet left zone, three-stage convergence, one partial coral trace, bright background, and restrained scientific tone. High local contrast on object edges but low visual noise overall.
Avoid: Fake dashboard UI, browser frames, score numbers, accessibility wheelchair icons, eyes as icons, people, hands, disability stereotypes, robots, mascots, emojis, purple, blue neon, green brand accents, gradient mesh, glow soup, glossy black background, excessive lens flare, floating spheres, text, watermark, signature, poster layout.
'@

$normalizedPrompt = (($prompt -replace "`r?`n", " ") -replace "\s{2,}", " ").Trim()
Set-Location -LiteralPath $projectDir

& $ima2Cli gen $normalizedPrompt --provider oauth --quality high --size 1792x1024 --mode direct -n 3 -d $outputDir --json
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
