# 角色与动作适配层。只解释 Host 校验后的矢量数据，不加载外部 XAML 或脚本。
$script:petCatalog = $null
$script:catalogPending = $false
$script:characterId = 'dot'
$script:characterKey = ''
$script:artPaint = @()
$script:motionPreference = 'auto'
$script:interaction = $null
$script:interactionCool = 0
$script:hoverSince = 0
$script:hoverCool = 0
$PoseDefaults = @{ tilt = 0; lift = 0; sx = 1; sy = 1; lx = 0; ly = 0; la = 0; rx = 0; ry = 0; ra = 0 }

function Reduced-Motion { ($script:motionPreference -eq 'reduced') -or (-not $script:artPreview -and -not [Windows.SystemParameters]::ClientAreaAnimation) }
function Refresh-ArtCatalog {
  if ($script:catalogPending -or $script:petCatalog) { return }
  $script:catalogPending = $true
  Get-Dot ($ApiBase + '/pet/catalog') 'On-ArtCatalog'
}
function On-ArtCatalog($r, $state) {
  $script:catalogPending = $false
  if ($r.failed -or $r.version -ne 1) { return }
  $script:petCatalog = $r
  $miCharacters.Items.Clear()
  foreach ($c in $r.characters) {
    if ($c.renderer -ne 'dot-vector-v1') { continue }
    $mi = New-MenuItem ([string]$c.name) 0xE734 ([string]$c.description)
    $mi.Tag = [string]$c.id; $mi.IsCheckable = $true
    $mi.Add_Click({ param($sender, $e) Send-Dot '/pet' @{ action = 'character'; id = [string]$sender.Tag } 'On-ArtSaved' $null })
    [void]$miCharacters.Items.Add($mi)
  }
  $miPlay.Items.Clear()
  foreach ($g in $r.gestures) {
    $mi = New-MenuItem ([string]$g.name) 0xE899 '一个短短的小动作，不记分、不打卡'
    $mi.Tag = [string]$g.id
    $mi.Add_Click({ param($sender, $e) Play-Interaction ([string]$sender.Tag) $true })
    [void]$miPlay.Items.Add($mi)
  }
  Update-CharacterMenu
  if ($env:DOT_PET_ART_SHOTS) { Start-ArtShots }
}
function On-ArtSaved($r, $state) {
  if ($r.ok -and $r.pet) {
    $script:motionPreference = [string]$r.pet.motion
    if ($script:petCatalog) {
      $c = @($script:petCatalog.characters | Where-Object { $_.id -eq $r.pet.character })
      if ($c.Count) { Apply-Character $c[0] }
    }
    if (Reduced-Motion) { Reset-Interaction }
    Update-CharacterMenu
    Refresh
  }
  On-OpDone $r $state
}
function Update-CharacterMenu {
  foreach ($mi in $miCharacters.Items) { $mi.IsChecked = ([string]$mi.Tag -eq $script:characterId) }
  $miMotion.IsChecked = $script:motionPreference -eq 'reduced'
}
function Art-Brush([string]$paint) {
  switch ($paint) {
    'body' { New-Object Windows.Media.SolidColorBrush $ui.Bottom.Color }
    'light' { New-Object Windows.Media.SolidColorBrush $ui.Top.Color }
    'face' { New-Brush '#FFFFFF' }
    'none' { $null }
    default { New-Brush $paint }
  }
}
function Update-ArtColors {
  $ui.ArmL.Fill = New-Object Windows.Media.SolidColorBrush $ui.Bottom.Color
  $ui.ArmR.Fill = New-Object Windows.Media.SolidColorBrush $ui.Bottom.Color
  $ui.FootL.Fill = New-Object Windows.Media.SolidColorBrush $ui.Bottom.Color
  $ui.FootR.Fill = New-Object Windows.Media.SolidColorBrush $ui.Bottom.Color
  foreach ($p in $script:artPaint) {
    $p.shape.Fill = Art-Brush $p.fill
    if ($p.stroke) { $p.shape.Stroke = Art-Brush $p.stroke }
  }
}
function Apply-Character($art) {
  if (-not $art -or $art.renderer -ne 'dot-vector-v1') { $art = [pscustomobject]@{ id = 'dot'; radius = 17; ahoge = $true; back = @(); front = @() } }
  $key = $art | ConvertTo-Json -Depth 8 -Compress
  if ($key -eq $script:characterKey) { return }
  Reset-Interaction
  $script:characterKey = $key; $script:characterId = [string]$art.id
  $ui.CharacterBack.Children.Clear(); $ui.CharacterFront.Children.Clear(); $script:artPaint = @()
  try {
    $ui.Body.CornerRadius = [Windows.CornerRadius]::new([double]$art.radius)
    $ui.Ahoge.Visibility = if ($art.ahoge) { 'Visible' } else { 'Collapsed' }
    foreach ($layer in @(@($ui.CharacterBack, $art.back), @($ui.CharacterFront, $art.front))) {
      foreach ($p in @($layer[1])) {
        if (-not $p) { continue }
        $shape = New-Object Windows.Shapes.Path
        $shape.Data = Geo ([string]$p.d)
        $shape.StrokeThickness = if ($p.width) { [double]$p.width } else { 1 }
        $shape.StrokeStartLineCap = 'Round'; $shape.StrokeEndLineCap = 'Round'; $shape.StrokeLineJoin = 'Round'
        [void]$layer[0].Children.Add($shape)
        $script:artPaint += @{ shape = $shape; fill = [string]$p.fill; stroke = [string]$p.stroke }
      }
    }
    Update-ArtColors
  } catch {
    $ui.CharacterBack.Children.Clear(); $ui.CharacterFront.Children.Clear(); $script:artPaint = @()
    $ui.Body.CornerRadius = [Windows.CornerRadius]::new(17); $ui.Ahoge.Visibility = 'Visible'; $script:characterId = 'dot'
    Write-PetLog "character fallback: $_"
  }
  Update-CharacterMenu
}
function Reset-Interaction {
  $script:interaction = $null
  $ui.GestureScale.ScaleX = 1; $ui.GestureScale.ScaleY = 1; $ui.GestureRot.Angle = 0; $ui.GestureHop.Y = 0
  $ui.ArmLMove.X = 0; $ui.ArmLMove.Y = 0; $ui.ArmRMove.X = 0; $ui.ArmRMove.Y = 0
  $ui.ArmLRot.Angle = 0; $ui.ArmRRot.Angle = 0
  $script:emoteUntil = 0
}
function Play-Interaction([string]$id, [bool]$manual = $false) {
  if (-not $script:petCatalog -or $script:interaction -or (Now-Ms) -lt $script:interactionCool) { return }
  if ($script:quiet -or $script:paused -or $script:hidden -or $script:act -ne 'idle' -or $script:chewN -gt 0 -or @('waiting', 'alert', 'busy') -contains $script:mood) {
    if ($manual -and -not $script:quiet) { Flash '我在陪你盯着事情，忙完再来玩呀' 2 }
    return
  }
  if (-not $manual -and (Reduced-Motion)) { return }
  $found = @($script:petCatalog.gestures | Where-Object { $_.id -eq $id })
  if (-not $found.Count) { return }
  $g = $found[0]; $t = Now-Ms; $reduced = Reduced-Motion
  $duration = if ($reduced) { 750 } else { [double]$g.duration }
  $script:interaction = @{ gesture = $g; start = $t; duration = $duration; reduced = $reduced }
  $script:interactionCool = $t + $duration + 1000
  $script:nextIdleAt = $t + $duration + 14000
  Emote ([string]$g.eyes) ([string]$g.mouth) ([bool]$g.cheeks) ([int]$duration + 100)
  if (-not $reduced -and $g.particle -ne 'none') {
    $symbol = switch ($g.particle) { 'heart' { [string][char]0x2665 } 'note' { [string][char]0x266A } default { [string][char]0x2726 } }
    $color = if ($g.particle -eq 'heart') { '#F278A3' } else { '#E9B84D' }
    for ($i = 0; $i -lt 3; $i++) { Spawn $symbol $color (25 + $rand.Next(42)) (45 + $rand.Next(15)) (($rand.NextDouble() - 0.5) * 0.8) (-0.6 - $rand.NextDouble() * 0.5) 1400 (10 + $rand.Next(4)) }
  }
}
function Tick-Interaction([double]$t) {
  $a = $script:interaction
  if (-not $a) { return }
  if ($script:quiet -or $script:paused -or $script:hidden -or $script:act -ne 'idle' -or @('waiting', 'alert', 'busy') -contains $script:mood -or $t -ge $a.start + $a.duration) { Reset-Interaction; Base-Face; return }
  if ((Reduced-Motion) -and -not $a.reduced) { Reset-Interaction; Base-Face; return }
  if ($a.reduced) { return }
  $g = $a.gesture; $p = [Math]::Min(1.0, [Math]::Max(0.0, ($t - $a.start) / $a.duration)); $frames = $g.frames
  $i = 1; while ($i -lt $frames.Count - 1 -and $p -gt [double]$frames[$i].at) { $i++ }
  $left = $frames[$i - 1]; $right = $frames[$i]
  $u = ($p - [double]$left.at) / ([double]$right.at - [double]$left.at); $ease = $u * $u * (3 - 2 * $u)
  $pose = @{}
  foreach ($k in $PoseDefaults.Keys) { $pose[$k] = [double]$left.$k + ([double]$right.$k - [double]$left.$k) * $ease }
  $ui.GestureScale.ScaleX = $pose.sx; $ui.GestureScale.ScaleY = $pose.sy; $ui.GestureRot.Angle = $pose.tilt; $ui.GestureHop.Y = $pose.lift
  $ui.ArmLMove.X = $pose.lx; $ui.ArmLMove.Y = $pose.ly; $ui.ArmLRot.Angle = $pose.la
  $ui.ArmRMove.X = $pose.rx; $ui.ArmRMove.Y = $pose.ry; $ui.ArmRRot.Angle = $pose.ra
  if ($g.revealAt -and $p -ge [double]$g.revealAt) { Set-Face 'wink' 'smile' $true }
}

# 开发验证：把精灵自身绘制成图片，不截取桌面；结束后自动关闭隔离的测试精灵。
function Start-ArtShots {
  $dir = $env:DOT_PET_ART_SHOTS
  if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  $poll.Stop(); $fast.Stop(); $engine.Stop()
  $script:artPreview = $true
  $window.Left = -10000; $window.Top = -10000; $window.Opacity = 1
  $script:quiet = $false; $script:sysQuiet = $false; $script:paused = $false; $script:hidden = $false
  $script:mood = 'idle'; $script:motionPreference = 'auto'; $script:chewN = 0
  Set-Act 'idle'
  $colors = @{ blue = @('#8AA2FF', '#4D6BFE'); pink = @('#FFAFCE', '#ED7FAA'); orange = @('#FFD499', '#E9A15B'); green = @('#7FE0A8', '#2FB36D'); purple = @('#C4A5FF', '#8A5CF6'); gray = @('#C9CCD3', '#8A8F99') }
  $count = 0
  try {
    foreach ($character in $script:petCatalog.characters) {
      Apply-Character $character
      if ($script:characterId -ne $character.id) { throw "character failed: $($character.id)" }
      $script:idleColors = $colors[[string]$character.color]; Apply-Colors
      foreach ($g in $script:petCatalog.gestures) {
        foreach ($phase in @(0.0, 0.22, 0.45, 0.67, 0.84, 1.0)) {
          Reset-Interaction; $script:interactionCool = 0
          Play-Interaction ([string]$g.id) $true
          if (-not $script:interaction) { throw "gesture did not start: $($g.id)" }
          $t = Now-Ms; $script:interaction.start = $t - $phase * $script:interaction.duration
          Tick-Interaction $t
          if ($phase -eq 0.45 -and [Math]::Abs($ui.GestureRot.Angle) + [Math]::Abs($ui.GestureScale.ScaleY - 1) + [Math]::Abs($ui.ArmLMove.X) + [Math]::Abs($ui.ArmRMove.X) + [Math]::Abs($ui.ArmLMove.Y) + [Math]::Abs($ui.ArmRMove.Y) -lt 0.1) { throw "gesture stayed neutral: $($g.id)" }
          $ui.Fx.Children.Clear(); $script:parts.Clear()
          $ui.Stage.UpdateLayout()
          $rtb = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]($StageW * 3), [int]($StageH * 3), 288, 288, [Windows.Media.PixelFormats]::Pbgra32)
          $visual = New-Object Windows.Media.DrawingVisual
          $drawing = $visual.RenderOpen()
          $brush = [Windows.Media.VisualBrush]::new($ui.Stage)
          $drawing.DrawRectangle($brush, $null, [Windows.Rect]::new(0, 0, $StageW, $StageH))
          $drawing.Close()
          $rtb.Render($visual)
          $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
          $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($rtb))
          $file = Join-Path $dir ('{0}-{1}-{2:D2}.png' -f $character.id, $g.id, [int]($phase * 100))
          $stream = [IO.File]::Create($file)
          try { $enc.Save($stream) } finally { $stream.Close() }
          $count++
        }
      }
    }
    Reset-Interaction; $script:interactionCool = 0; Set-Act 'focus'; Play-Interaction 'wave' $true
    if ($script:interaction) { throw 'focus must block play' }
    Set-Act 'idle'; $script:mood = 'waiting'; Play-Interaction 'wave' $true
    if ($script:interaction) { throw 'waiting must block play' }
    $script:mood = 'idle'; $script:quiet = $true; Play-Interaction 'wave' $true
    if ($script:interaction) { throw 'quiet must block play' }
    $script:quiet = $false; $script:motionPreference = 'reduced'; $script:parts.Clear(); $ui.Fx.Children.Clear(); Play-Interaction 'wave' $true
    if (-not $script:interaction.reduced -or $script:parts.Count) { throw 'reduced motion must be a static expression without particles' }
    Tick-Interaction ((Now-Ms) + 300)
    if ($ui.GestureRot.Angle -ne 0 -or $ui.ArmRMove.Y -ne 0) { throw 'reduced motion moved the body' }
    Tick-Interaction ((Now-Ms) + 1000)
    if ($script:interaction) { throw 'gesture must release after finishing' }
    Apply-Character ([pscustomobject]@{ renderer = 'future-renderer' })
    if ($script:characterId -ne 'dot') { throw 'unknown renderer did not fall back' }
    @{ ok = $true; frames = $count; characters = $script:petCatalog.characters.Count; gestures = $script:petCatalog.gestures.Count; checks = @('focus', 'waiting', 'quiet', 'reduced-motion', 'neutral-reset', 'renderer-fallback') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir 'result.json') -Encoding UTF8
  } catch {
    @{ ok = $false; frames = $count; error = [string]$_; stack = $_.ScriptStackTrace } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir 'result.json') -Encoding UTF8
    Write-PetLog "art preview failed: $_"
  } finally { $window.Close() }
}
