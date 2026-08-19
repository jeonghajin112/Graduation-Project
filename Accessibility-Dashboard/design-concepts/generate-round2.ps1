$ErrorActionPreference = "Stop"

$ima2Cli = "C:\Users\hajin\AppData\Roaming\npm\ima2.cmd"
$projectDir = Split-Path -Parent $PSScriptRoot
$referenceSwiss = "design-concepts\round1\01-swiss-diagnostic.png"
$referenceScientific = "design-concepts\round1\03-scientific-dimensional.png"
$referenceAtlas = "design-concepts\round1\05-editorial-atlas.png"

$sharedBrief = @'
Image 1 is the Swiss Diagnostic reference and contributes its bright neutral palette, clear URL entry, and calm public-service credibility. Image 2 is the Scientific Dimensional reference and contributes only the semantic visual of three analysis systems converging into one score; do not inherit its dark cyber-like mood. Image 3 is the Editorial Atlas reference and is the primary structural reference, contributing open editorial fields, fine rules, score hierarchy, issue priority, and correction preview. Synthesize these elements rather than copying any one reference. This is a non-shippable concept mockup for UNI ACCESS, a Korean web-accessibility evaluation service.
Use case: ui-mockup.
Asset type: refined pre-code desktop landing-page concept.
Primary request: Create a bright Scientific Editorial Atlas landing page that makes automated accessibility evaluation feel exact, transparent, and useful.
Scene/backdrop: A straight-on 1536 by 1024 desktop browser page on cool paper #F7F8F5 with a restrained technical grid and large intentional negative space.
Subject: Minimal UNI ACCESS header, concise Korean hero, short descriptor, one URL input with one coral action, a real product analysis stage containing score 96 and grade A+, three weighted engine signals 50/30/20, issue priority, and one correction preview. Reveal the start of a varied next section without equal cards.
Style/medium: Korean public-interest technology editorial, Swiss information design with scientific dimensional evidence, premium product UI, code-buildable React and CSS.
Composition/framing: Product visual is the full-width stage below or behind the hero, never a boxed screenshot in a right column. Use a 12-column grid, open rule-based grouping, one strong asymmetric anchor, and no sealed-card syndrome.
Lighting/mood: Bright diffused daylight, calm, precise, low-anxiety.
Color palette: cool paper #F7F8F5, white #FFFFFF, ink #151817, graphite #5D6663, pale steel #DEE3E0, one coral accent #CF4D3C occupying less than ten percent.
Materials/textures: Matte archival paper, anodized graphite, subtle optical glass only in the decorative analysis visual, faint halftone grain at very low opacity.
Text (verbatim): Brand "UNI ACCESS". Headline "모두가 쓸 수 있는 웹, 더 정확하게". Descriptor "URL 하나로 규칙·한국어 문장·시각 명암비를 함께 진단합니다". Input placeholder "https://example.kr". Button "무료로 평가하기". Labels "규칙 기반 50%", "문장 난이도 30%", "시각 명암비 20%", "수정 우선순위". Use Korean-safe sans-serif, readable Hangul, compact monospaced numerals only for metrics.
Dimensions: 1536x1024 landscape.
Constraints: One dominant CTA, maximum four hero text elements, score and functional copy on opaque surfaces, excellent contrast, no fake claims, no people or disability stereotypes, implementable with one generated textless hero asset plus real HTML UI.
Avoid: Purple, neon, green as a brand accent, warm beige luxury, gradient soup, outer glow, giant 900-weight Hangul, three equal cards, glass cards, right-side boxed screenshot, excessive pills, browser traffic-light dots, people, mascots, emojis, watermarks, illegible text.
'@

$refinements = @(
  @{
    Name = "01-stage-below-copy"
    Delta = @'
Refinement 1 — PRODUCT STAGE BELOW COPY. Keep the hero copy left-aligned in the upper third with generous empty space to the right. Place the URL form directly below the descriptor. Make the analysis product stage span almost the entire lower half: score on the left, three analysis streams converging through the center, issue priority and a small before/after correction preview on the right. Use hairline dividers rather than card borders. The page should feel like an accessibility instrument laid open on a worktable.
'@
  },
  @{
    Name = "02-atlas-side-index"
    Delta = @'
Refinement 2 — EDITORIAL SIDE INDEX. Add one narrow vertical index rail on the far left with small section metadata and a simple 01 marker. The main hero uses the remaining width: headline and URL form above, then a wide foldout report. Integrate the three-engine convergence as a subtle diagram behind the report rows, while the score and issue priority remain crisp opaque DOM-like content. Remove oversized decorative numerals and keep corners nearly square except for the input and CTA.
'@
  },
  @{
    Name = "03-optical-field"
    Delta = @'
Refinement 3 — OPTICAL ANALYSIS FIELD. Use a quiet full-width pale optical field behind the upper hero: three translucent inspection lenses and fine rule lines converge toward one coral score ring. Keep the headline left-aligned and the URL form in one opaque white bar. A compact white result band overlaps the lower edge of the expressive field and carries real score, three weights, and issue counts. The field is soft and authored but never busy behind text; the functional band remains high contrast.
'@
  }
)

$jobs = foreach ($refinement in $refinements) {
  $fullPrompt = (($sharedBrief + " " + $refinement.Delta) -replace "`r?`n", " ") -replace "\s{2,}", " "
  $outputPath = "design-concepts\round2\$($refinement.Name).png"

  Start-Job -Name $refinement.Name -ScriptBlock {
    param($cli, $workDir, $prompt, $ref1, $ref2, $ref3, $outPath)
    Set-Location -LiteralPath $workDir
    & $cli gen $prompt --ref $ref1 --ref $ref2 --ref $ref3 --provider oauth --quality low --size 1536x1024 --mode direct -o $outPath --json
    if ($LASTEXITCODE -ne 0) {
      throw "ima2 generation failed with exit code $LASTEXITCODE"
    }
  } -ArgumentList $ima2Cli, $projectDir, $fullPrompt.Trim(), $referenceSwiss, $referenceScientific, $referenceAtlas, $outputPath
}

$jobs | Wait-Job | Out-Null

$failed = @($jobs | Where-Object { $_.State -ne "Completed" })
foreach ($job in $jobs) {
  Write-Output "[$($job.Name)] $($job.State)"
  Receive-Job -Job $job -ErrorAction Continue
}

if ($failed.Count -gt 0) {
  exit 1
}
