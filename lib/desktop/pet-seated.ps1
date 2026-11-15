# 小尺寸坐姿状态机；与 pet-motion.js 的 seated-v2 使用相同帧序与时序。
function Get-SeatedPose([double]$t) {
  $activity = if ($script:act -eq 'idle') { $script:mood } else { $script:act }
  $quiet = (Reduced-Motion) -or $script:quiet -or $script:paused -or @('waiting','alert','paused','focus','rest','sleep') -contains $activity
  $hover = -not $script:hidden
  $key = "$($script:posture)|$($script:edge)|$activity|$quiet|$hover"
  if ($key -ne $script:spriteContext) { $script:spriteContext = $key; $script:spriteContextAt = $t; $script:spriteTouched = $t; Reset-AtlasInput }
  $desk = $script:posture -eq 'desk'
  $s = @{ sheet = $(if($desk){'typing'}else{'life'}); index = 0; pose = $(if($desk){'desk'}else{'sit'}); hand = $script:spriteHand; contact = 0.0; fingerLift = 0.0; x = 0.0; y = 0.0; tilt = 0.0; sx = 1.0; sy = 1.0; mirror = 1.0; blink = 0.0; reveal = 1.0; moving = -not $quiet; typing = $false }
  if (@('held','fall') -contains $activity) {
    Reset-AtlasInput; $s.sheet = 'life'; $s.index = 4; $s.pose = $activity
    if (-not $quiet) { $s.tilt = [Math]::Max(-1.6,[Math]::Min(1.6,$script:spriteVelocity*.16)) + [Math]::Sin(($t-$script:spriteContextAt)/260)*.4 }
    return $s
  }
  if (@('left','right') -contains $script:edge) {
    Reset-AtlasInput; $s.sheet = 'life'; $s.index = 5; $s.pose = 'edge'; $s.mirror = if($script:edge -eq 'right'){-1.0}else{1.0}; $s.y = -8.0
    if (-not $quiet -and -not $hover) {
      $age = ($t-$script:spriteContextAt)%12000
      $s.reveal = if($age -lt 400){1-$age/400*.94}elseif($age -lt 1100){.06}elseif($age -lt 1500){.06+($age-1100)/400*.69}elseif($age -lt 2500){.75}elseif($age -lt 2900){.75-($age-2500)/400*.6}else{.15}
    }
    return $s
  }
  if ($quiet) { Reset-AtlasInput; if(@('rest','sleep') -contains $activity){$s.blink=1.0}; return $s }
  if ($script:interaction) {
    Reset-AtlasInput; $g = [string]$script:interaction.gesture.id
    $s.index = if($desk){if($g -eq 'think'){4}else{5}}else{if($g -eq 'think'){3}elseif($g -eq 'sit'){0}else{2}}
    $s.pose = if($desk){'thinking'}else{'sit'}
  } elseif ($script:spriteStrokeAt -ge 0 -and $desk) {
    $age = $t-$script:spriteStrokeAt
    if($age -ge 190){if($script:spritePending -and $t-$script:spriteLastPulse -lt 145 -and $age -lt 380){$script:spriteStrokeAt=$t;$script:spriteHand=1-$script:spriteHand;$script:spritePending=$false;$age=0}else{Reset-AtlasInput;$age=190}}
    if($script:spriteStrokeAt -ge 0){$s.typing=$true;$s.pose='typing';$s.hand=$script:spriteHand;$s.fingerLift=if($age -lt 40){.3+$age/40*.7}elseif($age -lt 65){1.0}elseif($age -lt 105){1-($age-65)/40}elseif($age -lt 140){0.0}elseif($age -lt 160){($age-140)/20*.25}else{[Math]::Max(0.0,(190-$age)/30*.25)};$s.contact=[Math]::Max(0.0,1-[Math]::Abs($age-115)/25)}
  }
  if(-not $s.typing -and -not $script:interaction){
    $idle = $t-$script:spriteTouched
    if(@('idle','done') -contains $activity){
      if($idle -ge 16000 -and ($idle-16000)%31000 -lt 3200){$s.index=if($desk){4}else{3};$s.pose=if($desk){'thinking'}else{'sit'}}
      elseif($idle -ge 24000 -and ($idle-24000)%38000 -lt 2400){$s.index=if($desk){5}else{2};$s.pose=if($desk){'thinking'}else{'sit'}}
    }
    $s.sy=1+[Math]::Sin(($t-$script:spriteBorn)/1200)*.003;$s.y=-[Math]::Sin(($t-$script:spriteBorn)/1200)*.1
  }
  if(-not $script:interaction -and $s.index -eq 0){$phase=($t-$script:spriteBorn)%5100;if($phase -ge 3500 -and $phase -lt 3680){$b=$phase-3500;$s.blink=if($b -lt 50){$b/50}elseif($b -lt 100){1.0}else{(180-$b)/80}}}
  return $s
}
function New-AtlasPatch($p) {
  $a = if($p.sheet -eq 'base'){$script:spriteArt.atlas}else{$script:spriteArt.animations.($p.sheet)}
  $cache = $script:spriteFrames[[string]$a.file]; $src = $p.source; $unit = $cache.cell/512.0
  $crop = [Windows.Media.Imaging.CroppedBitmap]::new($cache.frames[[int]$p.frame],[Windows.Int32Rect]::new([int]($src[0]*$unit),[int]($src[1]*$unit),[int]($src[2]*$unit),[int]($src[3]*$unit)))
  $crop.Freeze(); return $crop
}
function Place-AtlasPatch($image,$p) {
  $unit=$PetSize/512.0;$dst=$p.target
  [Windows.Controls.Canvas]::SetLeft($image,$dst[0]*$unit);[Windows.Controls.Canvas]::SetTop($image,$dst[1]*$unit)
  $image.Width=$dst[2]*$unit;$image.Height=$dst[3]*$unit
}
function Update-SeatedFingers($s) {
  foreach($hand in @('left','right')){
    $image=if($hand -eq 'left'){$ui.AtlasFingerL}else{$ui.AtlasFingerR}
    $p=$script:spriteArt.animations.fingers.$hand
    $image.Opacity=if($p -and $s.typing -and $s.hand -eq $(if($hand -eq 'left'){0}else{1})){$s.fingerLift}else{0.0}
    $key=if($hand -eq 'left'){$ui.AtlasKeyL}else{$ui.AtlasKeyR}
    $key.Opacity=if($p.keycap -and $s.typing -and $s.hand -eq $(if($hand -eq 'left'){0}else{1})){$s.contact*.75}else{0.0}
    if($p.keycap){Place-AtlasPatch $key @{target=$p.keycap}}
    if($p){$image.Source=$script:spriteFingerPatches[$hand];Place-AtlasPatch $image $p}
  }
}

function Test-SeatedShots([string]$dir,$character) {
  $script:edge='ground';$script:hidden=$false;Set-Act 'idle';Set-Posture 'desk';Reset-Input
  $t=Now-Ms;$script:spriteBorn=$t;Update-AtlasFrame $t
  if($PetSize -gt 128 -or $ui.SpriteView.Width -ne $PetSize){throw 'compact size mismatch'}
  Capture-AtlasMotion $dir 'desk'
  $script:spriteBorn=$t-3560;Update-AtlasFrame $t
  if($ui.AtlasBlink.Opacity -lt .99){throw 'desk blink missing'};Capture-AtlasMotion $dir 'blink'
  $script:spriteBorn=$t;$script:lastInputAt=0;$script:spriteHand=1;Pulse-Input;$start=$script:spriteStrokeAt
  if($start -lt 0 -or $script:spriteIndex -ne 0){throw 'finger response not immediate'}
  $master=$ui.SpriteView.Source;Update-AtlasFrame ($start+60)
  if($ui.AtlasFingerL.Opacity -lt .99 -or -not [object]::ReferenceEquals($master,$ui.SpriteView.Source) -or $ui.AtlasRot.Angle -ne 0 -or $ui.AtlasScale.ScaleY -ne 1){throw 'typing must keep torso/keyboard fixed'}
  Capture-AtlasMotion $dir 'finger-left'
  Update-AtlasFrame ($start+115);if($ui.AtlasKeyL.Opacity -lt .7 -or $ui.AtlasFingerL.Opacity -gt 0){throw 'finger press must land before key feedback'};Capture-AtlasMotion $dir 'contact';Push-AtlasInput ($start+120);Update-AtlasFrame ($start+190);Update-AtlasFrame ($start+250)
  if($ui.AtlasFingerR.Opacity -lt .99 -or $script:spriteIndex -ne 0){throw 'right fingertip response missing'};Capture-AtlasMotion $dir 'finger-right'
  Update-AtlasFrame ($start+400)
  if($script:typing -or $ui.AtlasFingerL.Opacity -ne 0 -or $ui.AtlasFingerR.Opacity -ne 0){throw 'finger animation did not settle'}
  $t=Now-Ms;$script:spriteTouched=$t-16500;Update-AtlasFrame $t;Capture-AtlasMotion $dir 'think'
  Set-Act 'held';Update-AtlasFrame $t
  if($script:spriteIndex -ne 4 -or [Math]::Abs($ui.AtlasRot.Angle) -gt 2.1){throw 'held motion too large'};Capture-AtlasMotion $dir 'held'
  Set-Act 'idle'
  foreach($side in @('left','right')){
    $script:edge=$side;$script:hidden=$false;Update-AtlasFrame $t
    if($script:spriteIndex -ne 5 -or [Math]::Sign($ui.AtlasScale.ScaleX) -ne $(if($side -eq 'right'){-1}else{1})){throw 'peek pose not facing inward'}
    Capture-AtlasMotion $dir "edge-$side"
    $script:hidden=$true;Update-AtlasFrame $t;Update-AtlasFrame ($t+450)
    if($script:spriteMotion.reveal -gt .1){throw 'peek did not hide'};Capture-AtlasMotion $dir "hidden-$side"
    Update-AtlasFrame ($t+1700);if($script:spriteMotion.reveal -lt .7){throw 'peek did not return'}
    $script:hidden=$false;Update-AtlasFrame ($t+1800);if($script:spriteMotion.reveal -ne 1){throw 'hover should reveal face'}
  }
  $script:edge='ground';$script:hidden=$false;Set-Posture 'classic';$t=Now-Ms;$script:spriteBorn=$t;Update-AtlasFrame $t
  if(-not $script:spriteSeated -or $script:spriteIndex -ne 0){throw 'classic must sit immediately'};Capture-AtlasMotion $dir 'sit'
  $script:spriteBorn=$t-3560;Update-AtlasFrame $t;Capture-AtlasMotion $dir 'sit-blink'
  $script:spriteBorn=$t;$script:spriteTouched=$t-16500;Update-AtlasFrame $t
  if($script:spriteIndex -ne 3 -or $ui.AtlasBlink.Opacity -ne 0){throw 'chin rest must use its own face'};Capture-AtlasMotion $dir 'sit-think'
  $script:spriteTouched=$t-24500;Update-AtlasFrame $t
  if($script:spriteIndex -ne 2){throw 'personality idle missing'};Capture-AtlasMotion $dir 'personality'
  $script:motionPreference='reduced';Update-AtlasFrame $t
  if($ui.AtlasRot.Angle -ne 0 -or $ui.AtlasScale.ScaleY -ne 1 -or $script:spriteIndex -ne 0){throw 'reduced motion must sit calmly'}
  foreach($height in @(0,16,32,48,80)){
    $layout=Get-AtlasSeatLayout 128 ([double]$character.animations.seatY) $height
    if($height -lt 20){if($layout.offset -ne 0){throw 'autohide taskbar offset'};continue}
    foreach($bottom in @(720,1080,-100)){$feet=$bottom-6+$layout.offset;$hip=$feet-128*(1-[double]$character.animations.seatY)*$layout.scale;if($feet -gt $bottom+$height-4+.01 -or [Math]::Abs($hip-$bottom) -gt .01){throw 'taskbar seat clipping'}}
  }
  $script:motionPreference='auto';Set-Posture 'desk';Reset-Input;$script:spriteBorn=Now-Ms;$script:spriteTouched=$script:spriteBorn
}
