# 本地图集与人物动作。输入只有节奏脉冲；所有图片在安装包内加载、裁切并缓存。
$script:spriteArt = $null; $script:spriteFrames = @{}; $script:spriteIndex = -1
$script:atlasSized = $false; $script:spriteSeated = $false; $script:spriteSeatScale = 1.0; $script:spriteGroundOffset = 0.0
$script:spriteKey = ''; $script:spriteBlendAt = -1.0; $script:spritePose = 'standing'
$script:spriteStrokeAt = -1.0; $script:spritePending = $false; $script:spriteHand = 1; $script:spriteLastPulse = -1000.0
$script:spriteBorn = 0.0; $script:spriteTouched = 0.0; $script:spriteContextAt = 0.0; $script:spriteContext = ''
$script:spriteLastX = 0.0; $script:spriteVelocity = 0.0

function Reset-AtlasInput { $script:spriteStrokeAt = -1.0; $script:spritePending = $false }
function Set-AtlasSize([bool]$human) {
  if ($script:atlasSized -eq $human) { return }
  $center = Stage-Center; $bottom = $window.Top + $WinH
  $script:atlasSized = $human
  $script:PetSize = if ($human) { 128 } else { 56 }
  $script:StageW = if ($human) { 172 } else { 96 }; $script:StageH = if ($human) { 172 } else { 132 }
  $script:WinH = $StageH; $script:PadX = ($StageW - $PetSize) / 2; $script:WinW = if ($human) { 444 } else { 360 }
  $script:Peek = if ($human) { 40 } else { 22 }
  $ui.Stage.Width = $StageW; $ui.Stage.Height = $StageH; $ui.Pet.Width = $PetSize; $ui.Pet.Height = if ($human) { 128 } else { 66 }
  foreach($key in @('SpriteRig','SpritePrevious','SpriteView','AtlasParts')){$ui[$key].Width=$PetSize;$ui[$key].Height=$PetSize}
  $window.Height = $WinH; $window.Width = $WinW
  $ui.RingBox.Width = $ui.RingBox.Height = if ($human) { 140 } else { 76 }
  $ui.Ring.RenderTransform = [Windows.Media.ScaleTransform]::new(($ui.RingBox.Width / 76), ($ui.RingBox.Height / 76))
  if (-not $script:artPreview) {
    Set-StageLeft ($center - $StageW / 2); $window.Top = $bottom - $WinH
    if ($script:edge -eq 'ground') { $window.Top = Ground-Top }; Update-Layout
  }
}
function Load-Atlas($a) {
  if (-not $a -or [string]$a.file -notmatch '^[a-z][a-z0-9-]{0,60}\.png$' -or $a.columns -ne 3 -or $a.rows -ne 2) { throw 'Unsupported local character atlas' }
  if ($script:spriteFrames.ContainsKey([string]$a.file)) { return }
  $file = Join-Path (Join-Path $PSScriptRoot '..\pets\assets') ([string]$a.file)
  $bitmap = New-Object Windows.Media.Imaging.BitmapImage
  $bitmap.BeginInit(); $bitmap.CacheOption = 'OnLoad'; $bitmap.UriSource = [Uri]::new([IO.Path]::GetFullPath($file)); $bitmap.EndInit(); $bitmap.Freeze()
  if ($bitmap.PixelWidth -ne $a.width -or $bitmap.PixelHeight -ne $a.height -or $bitmap.PixelWidth / 3 -ne $bitmap.PixelHeight / 2) { throw 'Character atlas dimensions do not match manifest' }
  $cell = [int]($bitmap.PixelWidth / 3); $frames = @()
  for ($i = 0; $i -lt 6; $i++) {
    $crop = [Windows.Media.Imaging.CroppedBitmap]::new($bitmap, [Windows.Int32Rect]::new(($i % 3) * $cell, [Math]::Floor($i / 3) * $cell, $cell, $cell)); $crop.Freeze(); $frames += $crop
  }
  $face = [Windows.Media.Imaging.CroppedBitmap]::new($bitmap, [Windows.Int32Rect]::new([int]($cell * .25), $cell + [int]($cell * .08), [int]($cell * .5), [int]($cell * .5))); $face.Freeze()
  $script:spriteFrames[[string]$a.file] = @{ frames = $frames; face = $face; cell = $cell }
}
function Apply-Atlas($art) {
  Load-Atlas $art.atlas
  if ($art.animations) { Load-Atlas $art.animations.typing; Load-Atlas $art.animations.life }
  $script:spriteArt = $art; $script:spriteIndex = -1; $script:spriteKey = ''; $script:spriteBlendAt = -1
  $script:spriteBorn = Now-Ms; $script:spriteTouched = $script:spriteBorn; $script:spriteContextAt = $script:spriteBorn; $script:spriteContext = ''
  $script:spriteLastX = $window.Left; $script:spriteVelocity = 0; $script:spriteHand = 1; Reset-AtlasInput
  $script:spriteBlinkPatches = @{}
  if ($art.animations.blink) {
    foreach ($pose in @('desk', 'standing', 'sit')) {
      $b = $art.animations.blink.$pose; if (-not $b) { continue }
      $a = if ($b.sheet -eq 'base') { $art.atlas } else { $art.animations.($b.sheet) }
      $cache = $script:spriteFrames[[string]$a.file]; $s = $b.source; $unit = $cache.cell / 512.0
      $patch = [Windows.Media.Imaging.CroppedBitmap]::new($cache.frames[[int]$b.frame], [Windows.Int32Rect]::new([int]($s[0] * $unit), [int]($s[1] * $unit), [int]($s[2] * $unit), [int]($s[3] * $unit))); $patch.Freeze()
      $script:spriteBlinkPatches[$pose] = $patch
    }
  }
  $script:spriteFingerPatches=@{}
  if($art.animations.fingers){foreach($hand in @('left','right')){$script:spriteFingerPatches[$hand]=New-AtlasPatch $art.animations.fingers.$hand}}
  $ui.AtlasFingerL.Opacity=0;$ui.AtlasFingerR.Opacity=0
  Set-AtlasSize $true
  $ui.VectorBody.Visibility = 'Collapsed'; $ui.SpriteRig.Visibility = 'Visible'; $ui.Shadow.Visibility = 'Collapsed'; $ui.PetFlip.ScaleX = 1
  $ui.AvatarLegacy.Visibility = 'Collapsed'; $ui.AvatarPortrait.Visibility = 'Visible'; $ui.AvatarPortrait.Source = $script:spriteFrames[[string]$art.atlas.file].face
  $ui.OutfitSelect.IsEnabled = $false; $ui.ColorSelect.IsEnabled = $false; $ui.OutfitRow.Visibility = 'Collapsed'; $ui.ColorRow.Visibility = 'Collapsed'; $ui.SaveLookBtn.Content = '保存名字'
  Update-AtlasFrame (Now-Ms)
}
function Clear-Atlas {
  $script:spriteArt = $null; $script:spriteIndex = -1; $script:spriteSeated = $false; $script:spriteGroundOffset = 0; Reset-AtlasInput
  Set-AtlasSize $false
  $ui.SpriteRig.Visibility = 'Collapsed'; $ui.VectorBody.Visibility = 'Visible'; $ui.Shadow.Visibility = 'Visible'
  $ui.AvatarLegacy.Visibility = 'Visible'; $ui.AvatarPortrait.Visibility = 'Collapsed'
  $ui.OutfitSelect.IsEnabled = $true; $ui.ColorSelect.IsEnabled = $true; $ui.OutfitRow.Visibility = 'Visible'; $ui.ColorRow.Visibility = 'Visible'; $ui.SaveLookBtn.Content = '保存名字和颜色'
}
function Push-AtlasInput([double]$t) {
  if (-not $script:spriteArt.animations -or $script:posture -ne 'desk') { return }
  [void](Get-AtlasPose $t)
  $script:spriteLastPulse = $t; $script:spriteTouched = $t
  if ($script:spriteStrokeAt -lt 0) { $script:spriteHand = 1 - $script:spriteHand; $script:spriteStrokeAt = $t } else { $script:spritePending = $true }
}
function Get-AtlasPose([double]$t) {
  if($script:spriteArt.animations.style -eq 'seated-v2'){return Get-SeatedPose $t}
  $activity = if ($script:act -eq 'idle') { $script:mood } else { $script:act }
  $reduced = Reduced-Motion
  $key = "$($script:posture)|$($script:edge)|$activity|$reduced|$($script:hidden)|$($script:quiet)|$($script:paused)"
  if ($key -ne $script:spriteContext) { $script:spriteContext = $key; $script:spriteContextAt = $t; $script:spriteTouched = $t; Reset-AtlasInput }
  $desk = $script:posture -eq 'desk'
  $stop = $reduced -or $script:hidden -or $script:quiet -or $script:paused -or @('waiting','alert','paused','focus','rest','sleep') -contains $activity
  $s = @{ sheet = $(if ($desk) { 'typing' } else { 'base' }); index = $(if ($desk) { 5 } else { 0 }); pose = $(if ($desk) { 'desk' } else { 'standing' }); hand = $script:spriteHand; contact = 0.0; x = 0.0; y = 0.0; tilt = 0.0; sx = 1.0; sy = 1.0; mirror = 1.0; blink = 0.0; moving = -not $stop; typing = $false }
  if (@('held','fall') -contains $activity) {
    Reset-AtlasInput; $s.sheet = 'life'; $s.index = 2; $s.pose = $activity
    if (-not $stop) { $s.tilt = $script:spriteVelocity + [Math]::Sin(($t - $script:spriteContextAt) / 220) * 1.8; $s.y = [Math]::Sin($t / 350) * .5 }
    return $s
  }
  if (@('left','right') -contains $script:edge) {
    Reset-AtlasInput; $s.sheet = 'life'; $s.index = 3; $s.pose = 'edge'; $s.mirror = if ($script:edge -eq 'right') { -1.0 } else { 1.0 }
    if (-not $stop) { $elapsed = $t - $script:spriteContextAt; $s.x = $s.mirror * [Math]::Cos($elapsed / 75) * [Math]::Exp(-$elapsed / 210) * 3; $s.tilt = [Math]::Sin($t / 2600) * .5 }
    return $s
  }
  if ($stop) { Reset-AtlasInput; if (@('sleep','rest') -contains $activity) { $s.blink = 1.0 }; return $s }
  if ($script:interaction) {
    Reset-AtlasInput; $g = [string]$script:interaction.gesture.id
    if (@('think','sit') -contains $g) { $s.sheet = 'life'; $s.index = if ($desk) { 1 } elseif ($g -eq 'think') { 5 } else { 4 }; $s.pose = if ($desk) { 'thinking' } else { 'sit' } }
    elseif (-not $desk) { $s.sheet = 'base'; $s.index = if ($g -eq 'wave') { 1 } else { 2 } }
  } elseif ($script:spriteStrokeAt -ge 0 -and $desk) {
    $age = $t - $script:spriteStrokeAt
    if ($age -ge 200) {
      if ($script:spritePending -and $t - $script:spriteLastPulse -lt 145 -and $age -lt 400) { $script:spriteStrokeAt = $t; $script:spriteHand = 1 - $script:spriteHand; $script:spritePending = $false; $age = 0 }
      else { Reset-AtlasInput; $age = 200 }
    }
    if ($script:spriteStrokeAt -ge 0) {
      $s.typing = $true; $s.pose = 'typing'; $s.hand = $script:spriteHand
      $phase = if ($age -lt 44) { 0 } elseif ($age -lt 84) { 1 } elseif ($age -lt 132) { 2 } elseif ($age -lt 165) { 1 } else { 2 }
      $s.index = $script:spriteHand * 3 + $phase
      $s.contact = [Math]::Max(0.0, 1 - [Math]::Abs($age - 106) / 27); $s.y = $s.contact * .75; $s.sy = 1 - .012 * $s.contact; $s.sx = 1 + .006 * $s.contact; $s.tilt = $(if ($s.hand) { 1 } else { -1 }) * $s.contact * .6
    }
  }
  if (-not $s.typing -and -not $script:interaction) {
    $idle = $t - $script:spriteTouched
    if (-not $desk -and $script:edge -eq 'ground' -and $idle -ge 8000) { $s.sheet = 'life'; $s.index = 4; $s.pose = 'sit' }
    if ($idle -ge 16000 -and ($idle - 16000) % 26000 -lt 3400) {
      if ($desk) { $s.sheet = 'life'; $s.index = 1; $s.pose = 'thinking' }
      elseif ($script:edge -eq 'ground') { $s.sheet = 'life'; $s.index = 5; $s.pose = 'sit' }
      else { $s.sheet = 'base'; $s.index = 1 }
    }
    $breath = [Math]::Sin(($t - $script:spriteBorn) / 950)
    $s.sy *= 1 + $breath * .006; $s.sx *= 1 - $breath * .0025; $s.y -= $breath * .3; $s.tilt += [Math]::Sin(($t - $script:spriteBorn) / 2500) * .45
  }
  if (-not $script:interaction -and -not ($s.sheet -eq 'life' -and $s.index -eq 5) -and @('desk','standing','sit','typing') -contains $s.pose) {
    $phase = ($t - $script:spriteBorn) % 4700
    if ($phase -ge 3500 -and $phase -lt 3680) { $b = $phase - 3500; $s.blink = if ($b -lt 50) { $b / 50 } elseif ($b -lt 100) { 1.0 } else { (180 - $b) / 80 } }
  }
  return $s
}
function Get-AtlasSeatLayout([double]$size, [double]$seatY, [double]$available) {
  if ($available -lt 20) { return @{ scale = 1.0; offset = 0.0 } }
  $leg = $size * (1 - $seatY)
  $scale = [Math]::Min(1.0, ($available - 4) / $leg)
  return @{ scale = $scale; offset = 6 + $leg * $scale }
}
function Set-AtlasSeat([bool]$seated) {
  $changed = $script:spriteSeated -ne $seated; $oldOffset = $script:spriteGroundOffset
  $script:spriteSeated = $seated; $script:spriteSeatScale = 1.0; $script:spriteGroundOffset = 0.0
  if ($seated -and $script:edge -eq 'ground' -and -not $script:artPreview) {
    $area = Here-Area; $available = [Math]::Max(0.0, $area.ScreenBottom - $area.Bottom)
    $layout = Get-AtlasSeatLayout $PetSize ([double]$script:spriteArt.animations.seatY) $available
    $script:spriteSeatScale = $layout.scale; $script:spriteGroundOffset = $layout.offset
  }
  $changed = $changed -or [Math]::Abs($oldOffset - $script:spriteGroundOffset) -gt .01
  if ($changed -and -not $script:artPreview -and $script:edge -eq 'ground' -and @('held','fall') -notcontains $script:act) {
    $from = $window.Top; $to = Ground-Top; $window.Top = $to
    if (-not (Reduced-Motion)) { $anim = New-Anim $from $to 180; $anim.FillBehavior = 'Stop'; $window.BeginAnimation([Windows.Window]::TopProperty, $anim) }
  }
}
function Show-AtlasFrame([string]$sheet, [int]$index, [double]$t, [double]$duration) {
  $a = if ($sheet -eq 'base') { $script:spriteArt.atlas } else { $script:spriteArt.animations.$sheet }
  $key = "$($a.file):$index"
  if ($key -ne $script:spriteKey) {
    $ui.SpritePrevious.Source = $ui.SpriteView.Source
    $script:spriteBlendAt = if ($script:spriteKey -and -not (Reduced-Motion)) { $t } else { -1 }
    $script:spriteBlendMs = $duration; $script:spriteKey = $key; $script:spriteIndex = $index
    $ui.SpriteView.Source = $script:spriteFrames[[string]$a.file].frames[$index]
  }
  $alpha = if ($script:spriteBlendAt -lt 0) { 1.0 } else { [Math]::Min(1.0, ($t - $script:spriteBlendAt) / $script:spriteBlendMs) }
  $ui.SpriteView.Opacity = $alpha; $ui.SpritePrevious.Opacity = if ($alpha -lt 1) { 1.0 } else { 0.0 }
}
function Update-AtlasFrame([double]$t) {
  if (-not $script:spriteArt) { return }
  if (-not $script:spriteArt.animations) {
    $index = if ($script:posture -eq 'desk') { 3 } else { 0 }
    if ($script:posture -eq 'classic' -and @('sleep','rest') -contains $script:act) { $index = 2 }
    if ($script:interaction -and $script:posture -eq 'classic') { $index = if ($script:interaction.gesture.id -eq 'wave') { 1 } else { 2 } }
    $latest = [Math]::Max($script:inputLAt, $script:inputRAt)
    if ($script:posture -eq 'desk' -and $script:typing -and (Input-Allowed) -and $latest -gt 0 -and $t - $latest -lt 180) { $index = if ($script:inputLAt -ge $script:inputRAt) { 4 } else { 5 } }
    Show-AtlasFrame 'base' $index $t 32; return
  }
  $delta = $window.Left - $script:spriteLastX; $script:spriteLastX = $window.Left
  $script:spriteVelocity = $script:spriteVelocity * .75 + [Math]::Max(-10.0, [Math]::Min(10.0, $delta * .35)) * .25
  $s = Get-AtlasPose $t; $script:spritePose = $s.pose; $script:spriteMotion = $s
  if (-not $s.typing -and $script:spriteStrokeAt -lt 0 -and $script:posture -eq 'desk') { $script:typing = $false; $script:inputLAt = 0; $script:inputRAt = 0 }
  Show-AtlasFrame $s.sheet $s.index $t $(if ($s.typing) { 32 } else { 95 })
  Set-AtlasSeat ($s.pose -eq 'sit')
  $micro=$script:spriteArt.animations.style -eq 'seated-v2'
  $scale = if($s.pose -eq 'edge' -and $micro){[double]$script:spriteArt.animations.peekScale} elseif ($s.pose -eq 'sit') { $script:spriteSeatScale } else { 1.0 }; $edgeShift = if ($s.pose -eq 'edge') { -$s.mirror * $PetSize * $(if($micro){[double]$script:spriteArt.animations.edgeX*$scale+(1-$scale)*.5+(1-$s.reveal)*.18}else{[double]$script:spriteArt.animations.edgeX}) } else { 0.0 }
  $ui.AtlasScale.ScaleX = $s.sx * $s.mirror * $scale; $ui.AtlasScale.ScaleY = $s.sy * $scale; $ui.AtlasRot.Angle = $s.tilt
  $ui.AtlasMove.X = $s.x * $PetSize / 80 + $edgeShift; $ui.AtlasMove.Y = $s.y * $PetSize / 80
  $ui.PetBreath.ScaleX = 1; $ui.PetBreath.ScaleY = 1
  $pose = if ($s.pose -eq 'typing') { 'desk' } else { $s.pose }; $b = $script:spriteArt.animations.blink.$pose
  $ui.AtlasBlink.Opacity = if ($b) { $s.blink } else { 0.0 }
  if ($b) {
    $ui.AtlasBlink.Source = $script:spriteBlinkPatches[$pose]; $dst = $b.target; $unit = $PetSize / 512.0
    [Windows.Controls.Canvas]::SetLeft($ui.AtlasBlink, $dst[0] * $unit); [Windows.Controls.Canvas]::SetTop($ui.AtlasBlink, $dst[1] * $unit)
    $ui.AtlasBlink.Width = $dst[2] * $unit; $ui.AtlasBlink.Height = $dst[3] * $unit
  }
  Update-SeatedFingers $s
  $ui.AtlasContactL.Opacity = if (-not $micro -and $s.hand -eq 0) { $s.contact * .85 } else { 0.0 }; $ui.AtlasContactR.Opacity = if (-not $micro -and $s.hand -eq 1) { $s.contact * .85 } else { 0.0 }
}

. (Join-Path $PSScriptRoot 'pet-seated.ps1')
