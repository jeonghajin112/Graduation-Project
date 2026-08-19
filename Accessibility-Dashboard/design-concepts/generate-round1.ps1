$ErrorActionPreference = "Stop"

$ima2Cli = "C:\Users\hajin\AppData\Roaming\npm\ima2.cmd"
$outputDir = Join-Path $PSScriptRoot "round1"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$concepts = @(
  @{
    Name = "01-swiss-diagnostic"
    Prompt = @'
Use case: ui-mockup.
Asset type: pre-code desktop landing-page concept mockup for a Korean web-accessibility evaluation service.
Primary request: Design a distinctive Swiss International Typographic landing page for UNI ACCESS that makes a real URL accessibility scan feel precise, calm, and trustworthy.
Scene/backdrop: A full 1536 by 1024 desktop browser canvas on a cool porcelain background #F6F7F4 with a very faint technical baseline grid and large intentional empty zones.
Subject: A Korean landing page with a compact top navigation, one concise hero headline, one short descriptor, a long URL input with a single primary action, and a large full-width analysis result stage rising from below the copy. The result stage shows one accessibility score ring, three weighted analysis tracks, and a compact issue summary. Below the fold, reveal the beginning of an asymmetric 6-3-3 engine composition rather than three equal cards.
Style/medium: High-fidelity product design mockup, Swiss editorial systems, strict typographic hierarchy, objective data visualization, restrained public-service credibility, no generic SaaS template.
Composition/framing: Browser page shown straight-on with the entire first viewport visible. Left-aligned type uses roughly five columns while the real product result stage spans the full lower width and overlaps the fold slightly. Strong 12-column alignment, crisp 1-pixel rules, no boxed screenshot on the right.
Lighting/mood: Bright diffused daylight, neutral and exact, calm rather than playful.
Color palette: porcelain #F6F7F4, paper white #FFFFFF, near-black #121416, muted slate #687078, one coral signal accent #D9503F. Coral occupies less than ten percent of the surface.
Materials/textures: Matte paper, crisp ink, barely visible offset-print grain, no glossy glass.
Text (verbatim): Brand "UNI ACCESS". Headline "모두가 쓸 수 있는 웹, 점수로 확인하세요". Descriptor "URL 하나로 규칙·문장·명암비를 함께 진단합니다". Input placeholder "https://example.kr". Button "무료로 평가하기". Use clean Korean sans-serif and keep all Hangul readable; no extra marketing copy.
Dimensions: 1536x1024 landscape.
Constraints: Exactly one dominant CTA. Product visual is the stage, not a right-column card. Use one score example of 96 with grade A+. Keep functional text on opaque high-contrast surfaces. Make the layout implementable in React and CSS.
Avoid: Purple, blue-indigo gradients, glow soup, three equal feature cards, oversized 900-weight Hangul, rounded cards everywhere, fake browser chrome, people, mascots, stock photos, disability stereotypes, illegible microtext, watermarks.
'@
  },
  @{
    Name = "02-organic-capsule"
    Prompt = @'
Use case: ui-mockup.
Asset type: pre-code desktop landing-page concept mockup for a Korean accessibility analytics product.
Primary request: Create an Organic Capsule landing direction where an authored soft-focus visual field communicates inclusive perception while all controls remain in crisp opaque white functional layers.
Scene/backdrop: A full 1536 by 1024 browser canvas filled in the hero by a subtle macro photograph-like field of translucent lenses, woven paper fibers, and overlapping high-contrast apertures, with a quiet pale zone behind navigation.
Subject: A centered light-weight Korean hero for UNI ACCESS, one concise descriptor, one white capsule containing the URL input and primary CTA, and a substantial real DOM-like score panel emerging full-width at the bottom edge. The background metaphor shows three visual signals converging toward one circular score without any text embedded in the expressive field.
Style/medium: Contemporary Korean product editorial, OpenAI-style organic announcement grammar interpreted for accessibility diagnostics, premium but not luxurious, tangible and human without using people.
Composition/framing: Straight-on browser page. Centered copy stack occupies the upper middle, with generous breathing room. The functional URL capsule and score panel are opaque and sharply legible. Show only the start of the next section as a clean horizontal evidence band.
Lighting/mood: Soft overcast window light, optimistic and low-anxiety, no dramatic glow.
Color palette: cool milk white #F8F9F7, charcoal #171918, muted sage #8B9A90, fog blue #AABBC2 used only in the image field, one coral accent #CF4B3A for action and score.
Materials/textures: Frosted optical lenses, fibrous paper, fine film grain, opaque ceramic-white controls; no transparent text cards.
Text (verbatim): Brand "UNI ACCESS". Headline "모두의 웹을 더 선명하게". Descriptor "세 가지 분석 엔진으로 접근성을 한 번에 확인하세요". Input placeholder "평가할 웹사이트 주소". Button "무료로 평가하기". Score label "접근성 점수". Keep text perfectly legible in Korean sans-serif.
Dimensions: 1536x1024 landscape.
Constraints: Light headline weight around 400, no more than four hero text elements, CTA visible above the fold, one expressive media field only, strong contrast and a clear keyboard-focus treatment, score example 96 and A+.
Avoid: Glass cards, text directly on busy imagery, generic gradients, colorful blobs, cute icons, split hero, right-side boxed screenshot, people, hands, disability symbols as decoration, watermarks, illegible Korean.
'@
  },
  @{
    Name = "03-scientific-dimensional"
    Prompt = @'
Use case: ui-mockup.
Asset type: pre-code desktop landing-page concept mockup for a web accessibility diagnostics platform.
Primary request: Design a dark scientific-dimensional landing page that feels like a precision accessibility scanner rather than a cyberpunk dashboard.
Scene/backdrop: A full 1536 by 1024 browser canvas on deep graphite #0C0F10 with a single large conceptual analysis scene: three thin translucent inspection planes, contrast apertures, and rule nodes converging into one warm coral score ring.
Subject: UNI ACCESS navigation, a left-aligned restrained Korean hero headline across the top width, one short descriptor, one bright URL input bar, and a full-width product result stage integrated with the dimensional scanning scene. Beneath it, show a sparse technical evidence strip for rule, language, and visual analysis weights.
Style/medium: DeepMind-inspired scientific dimensionality mixed with Korean public-service clarity, premium 3D information sculpture, sober high-trust interface, not gaming or hacker aesthetics.
Composition/framing: Straight-on full browser viewport. Headline spans seven columns near the upper left; the analysis visual sits behind and below as a stage rather than inside a card. Real functional controls are opaque. Deliberate asymmetric void on the upper right.
Lighting/mood: Controlled museum lighting from upper left, quiet concentration, subtle edge reflections, no neon.
Color palette: graphite #0C0F10, raised charcoal #171B1D, warm white #F3F4EF, steel #9AA4A7, one coral-orange accent #E35A42. No other saturated hue.
Materials/textures: Smoked glass used only for decorative scanning planes, anodized metal, matte black paper, fine laser-etched lines.
Text (verbatim): Brand "UNI ACCESS". Headline "보이지 않던 접근성 문제까지". Descriptor "규칙·한국어 문장·시각 명암비를 함께 분석합니다". Input placeholder "https://example.kr". Button "접근성 평가 시작". Score "96" and grade "A+". Korean sans-serif for UI, compact monospaced numerals only for metrics.
Dimensions: 1536x1024 landscape.
Constraints: WCAG-conscious contrast, one coral accent, one dominant CTA, no decorative scroll cue, no glowing card borders, implementable with a generated background asset plus real HTML UI.
Avoid: Matrix green, cyan neon, purple, terminal styling, gradient soup, outer glows, fake code, three equal cards, tiny labels, people, robots, mascots, watermarks.
'@
  },
  @{
    Name = "04-bauhaus-civic"
    Prompt = @'
Use case: ui-mockup.
Asset type: pre-code desktop landing-page concept mockup for a Korean web accessibility service.
Primary request: Explore a restrained Bauhaus civic-utility direction that turns the three analysis engines and one total score into a memorable geometric system without becoming playful.
Scene/backdrop: A full 1536 by 1024 browser page on clean mineral white #F4F3EF with bold black rules and a few large flat geometric forms representing rule, language, vision, and combined score.
Subject: UNI ACCESS header, asymmetric hero headline, one compact explanation, URL evaluation form, and a full-width geometric data stage. A circle carries the total score, a rectangle represents rule inspection, a horizontal ribbon represents language, and two overlapping apertures represent contrast. The next section begins as an uneven 2fr-1fr-1fr composition.
Style/medium: Bauhaus information design, Korean civic service clarity, contemporary flat editorial design, tactile silkscreen print rather than generic neobrutalism.
Composition/framing: Straight-on desktop browser viewport. Strong left margin and diagonal reading path, asymmetrical 12-column grid, large visual stage spanning the lower half. Corners mostly sharp; pill shape reserved for the URL control and buttons.
Lighting/mood: Flat studio reproduction of printed graphics, confident and direct, no shadows except one subtle paper lift under the result panel.
Color palette: mineral white #F4F3EF, ink #111313, coral red #D94F3D, one muted cobalt #2957A4 only inside the decorative visual, pale stone #D8D9D3.
Materials/textures: Thick uncoated paper, crisp silkscreen ink, subtle registration texture at low opacity.
Text (verbatim): Brand "UNI ACCESS". Headline "접근성은 감이 아니라 기준입니다". Descriptor "URL을 입력하면 세 가지 관점의 결과를 점수와 수정 순서로 보여드려요". Input placeholder "웹사이트 주소 입력". Button "지금 평가하기". Score "96" and grade "A+". Use sturdy Korean grotesque typography, not ultra-heavy.
Dimensions: 1536x1024 landscape.
Constraints: Clear 44-pixel minimum controls, visible focus, one primary action, no more than four hero text elements, visual hierarchy remains calm enough for education and public-service use.
Avoid: Cartoon shapes, cute faces, thick comic outlines, rainbow colors, three equal cards, excessive rounded corners, gradients, glassmorphism, right-side screenshot box, watermarks, illegible text.
'@
  },
  @{
    Name = "05-editorial-atlas"
    Prompt = @'
Use case: ui-mockup.
Asset type: pre-code desktop landing-page concept mockup for a Korean accessibility evaluation and reporting platform.
Primary request: Create an editorial data-atlas landing direction that presents accessibility as a legible field guide: calm, authoritative, and visually authored.
Scene/backdrop: A full 1536 by 1024 browser page on cool paper #F7F7F2, divided by one strong vertical index line and broad unboxed editorial fields.
Subject: UNI ACCESS wordmark, a mission-led Korean headline, one short service description, an inline URL evaluator, and a large atlas-like result spread containing a score ring, three weighted rows, issue priority markers, and a concise correction preview. The next-section hint uses a horizontal sequence rather than cards.
Style/medium: Contemporary magazine information design, public-interest technology annual report, Swiss grid loosened by editorial scale shifts, sans-serif Korean display with a small mono data accent.
Composition/framing: Straight-on full desktop viewport. Large headline sits in the upper-left two-thirds with intentional negative space to the right. The product result spread spans the width below and feels like a printed foldout, not a rounded dashboard card. Use one oversized numeral as a visual anchor.
Lighting/mood: Soft daylight over matte archival paper, serious but welcoming.
Color palette: paper #F7F7F2, ink #161817, graphite #4F5654, pale cool gray #E5E8E5, one brick-coral accent #C94E3E. No beige luxury palette.
Materials/textures: Archival paper, fine halftone dots in the decorative layer, hairline rules, crisp ink.
Text (verbatim): Brand "UNI ACCESS". Headline "웹 접근성을 읽기 쉬운 기준으로". Descriptor "평가 결과와 수정 우선순위를 한 화면에서 확인하세요". Input placeholder "https://example.kr". Button "무료로 진단하기". Data labels "규칙 50%", "문장 30%", "명암비 20%", score "96", grade "A+". Keep Korean text readable and concise.
Dimensions: 1536x1024 landscape.
Constraints: No serif shortcut, no traditional cards around every block, one accent hue, one CTA, result data remains real-DOM-like and implementable, excellent contrast.
Avoid: Warm beige luxury, serif headlines, gradient backgrounds, rounded cards everywhere, fake testimonials, logos, people, stock photos, mascots, UI text smaller than readable, watermarks.
'@
  }
)

$jobs = foreach ($concept in $concepts) {
  $outputPath = Join-Path $outputDir ($concept.Name + ".png")
  $normalizedPrompt = (($concept.Prompt -replace "`r?`n", " ") -replace "\s{2,}", " ").Trim()
  Start-Job -Name $concept.Name -ScriptBlock {
    param($cli, $prompt, $outPath)
    & $cli gen $prompt --provider oauth --quality low --size 1536x1024 --mode direct -o $outPath --json
    if ($LASTEXITCODE -ne 0) {
      throw "ima2 generation failed with exit code $LASTEXITCODE"
    }
  } -ArgumentList $ima2Cli, $normalizedPrompt, $outputPath
}

$jobs | Wait-Job | Out-Null

$failed = @($jobs | Where-Object { $_.State -ne "Completed" })
foreach ($job in $jobs) {
  Write-Output "[$($job.Name)] $($job.State)"
  Receive-Job -Job $job
}

if ($failed.Count -gt 0) {
  exit 1
}
