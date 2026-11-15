# 桌边姿态、即时输入与快捷面板。输入回调只收到一个脉冲，不收到按键内容。
$script:posture = 'desk'
$script:followInput = $true
$script:keysStatsOn = $false
$script:inputLAt = 0.0; $script:inputRAt = 0.0; $script:lastInputAt = 0.0; $script:inputSide = 0
$script:panelTab = 'today'; $script:syncingCompanion = $false
$script:lookDraft = $false

function Mix-Color($a, $b, [double]$amount) {
  [Windows.Media.Color]::FromRgb([byte]($a.R * $amount + $b.R * (1 - $amount)), [byte]($a.G * $amount + $b.G * (1 - $amount)), [byte]($a.B * $amount + $b.B * (1 - $amount)))
}
function Desk-BodyBrush { [Windows.Media.SolidColorBrush]::new((Mix-Color $ui.Top.Color ([Windows.Media.ColorConverter]::ConvertFromString('#FFFCF7')) 0.28)) }
function Desk-CreamBrush { [Windows.Media.SolidColorBrush]::new((Mix-Color $ui.Top.Color ([Windows.Media.ColorConverter]::ConvertFromString('#FFFCF7')) 0.06)) }
function Desk-InkBrush { [Windows.Media.SolidColorBrush]::new((Mix-Color $ui.Bottom.Color ([Windows.Media.ColorConverter]::ConvertFromString('#626172')) 0.10)) }
function Companion-Skin {
  if($script:lineArt){return (Desk-CreamBrush)}
  $brush = New-Object Windows.Media.LinearGradientBrush
  $brush.StartPoint = [Windows.Point]::new(0, 0); $brush.EndPoint = [Windows.Point]::new(0.2, 1)
  $brush.GradientStops.Add([Windows.Media.GradientStop]::new((Desk-CreamBrush).Color, 0))
  $brush.GradientStops.Add([Windows.Media.GradientStop]::new((Desk-BodyBrush).Color, 1))
  $brush
}
function Update-Posture {
  $desk = $script:posture -eq 'desk'
  $ui.Body.Visibility = if ($desk) { 'Collapsed' } else { 'Visible' }
  $ui.DeskBody.Visibility = if ($desk) { 'Visible' } else { 'Collapsed' }
  $ui.Shine.Visibility = if($script:lineArt){'Collapsed'}else{'Visible'}
  $ui.FootL.Visibility = $ui.FootR.Visibility = if ($desk) { 'Collapsed' } else { 'Visible' }
  $ui.PostureScale.ScaleX = 1; $ui.PostureScale.ScaleY = 1
  $face = Desk-InkBrush; $skin = Companion-Skin
  foreach ($key in @('EyeL', 'EyeR')) { $ui[$key].Fill = $face }
  foreach ($key in @('EyeLX', 'EyeRX', 'EyeLO', 'EyeRO', 'Mouth')) { $ui[$key].Stroke = $face }
  $ui.DeskBody.Fill = $skin; $ui.DeskBody.Stroke = $face
  $ui.Body.Background = $skin; $ui.Body.BorderBrush = $face; $ui.Body.BorderThickness = [Windows.Thickness]::new(1.3)
  $ui.Body.Width = 50; $ui.Body.Height = if($script:lineArt){43}else{47};[Windows.Controls.Canvas]::SetTop($ui.Body,$(if($script:lineArt){12}else{10})); [Windows.Controls.Canvas]::SetLeft($ui.Body, 3)
  $ui.Ahoge.Stroke = $face
  foreach ($key in @('FootL', 'FootR')) { $ui[$key].Fill = Desk-BodyBrush; $ui[$key].Stroke = $face; $ui[$key].StrokeThickness = 1.2; $ui[$key].Width = 16; $ui[$key].Height = 9 }
  foreach ($hand in @('L', 'R')) {
    $cx = if ($hand -eq 'L') { if ($desk) { 11 } elseif($script:lineArt){13}else { 3 } } else { if ($desk) { 45 } elseif($script:lineArt){43}else { 53 } }
    $cy = if ($desk) { 49 } elseif($script:lineArt){50}else { 41 }
    $key = "Arm$hand"; $ui[$key].Width = 14.4; $ui[$key].Height = if ($desk) { 12 } else { 14 }
    [Windows.Controls.Canvas]::SetLeft($ui[$key], $cx - 7.2); [Windows.Controls.Canvas]::SetTop($ui[$key], $cy - $ui[$key].Height / 2)
    $ui[$key].Fill = $skin; $ui[$key].Stroke = $face; $ui[$key].StrokeThickness = 1.2
    $ui["Arm${hand}Rot"].CenterX = $ui["Arm${hand}Scale"].CenterX = $cx
    $ui["Arm${hand}Rot"].CenterY = $ui["Arm${hand}Scale"].CenterY = $cy
    $ui["Paw$hand"].Data = Geo "M$($cx - 2),$($cy + 3) v2 M$($cx + 2),$($cy + 3) v2"; $ui["Paw$hand"].Stroke = $face
  }
  if (-not $script:typing) { $ui.InputBodyScale.ScaleY = if ($desk) { 0.94 } else { 1 } }
  $ui.Keyboard.Visibility = if (($desk -and @('sleep', 'rest', 'held', 'fall') -notcontains $script:act) -or $script:typing) { 'Visible' } else { 'Collapsed' }
  Update-AtlasFrame (Now-Ms)
}
function Set-Posture([string]$value) {
  $next = if ($value -eq 'classic') { 'classic' } else { 'desk' }
  if ($next -ne $script:posture) {
    Reset-Interaction; Reset-Input
    $script:posture = $next
    if($next -eq 'classic' -and ($script:spriteArt.animations.style -eq 'seated-v2' -or $script:lineArt) -and -not $script:artPreview){$script:edge='ground';$script:hidden=$false;Set-Act 'idle';Update-Layout;$window.Top=Ground-Top;Save-Position}
    if ($next -eq 'desk' -and $script:act -eq 'walk') { Set-Act 'idle'; Update-Layout; Save-Position }
  }
  Update-Posture
}
function Reset-Input {
  Reset-AtlasInput
  $script:inputLAt = 0.0; $script:inputRAt = 0.0
  if (-not $script:interaction) { $ui.ArmLMove.X = 0; $ui.ArmRMove.X = 0; $ui.ArmLMove.Y = 0; $ui.ArmRMove.Y = 0 }
  foreach ($hand in @('L', 'R')) {
    $ui["Arm${hand}Scale"].ScaleX = 1; $ui["Arm${hand}Scale"].ScaleY = 1
    if (-not $script:interaction) { $ui["Arm${hand}Rot"].Angle = 0 }
    $ui["Keys${hand}Move"].Y = 0; $ui["KeyLight$hand"].Opacity = 0; $ui["Impact$hand"].Opacity = 0
  }
  $ui.InputBodyMove.Y = 0; $ui.InputBodyRot.Angle = 0; $ui.InputBodyScale.ScaleX = 1
  $ui.InputBodyScale.ScaleY = if ($script:posture -eq 'desk') { 0.94 } else { 1 }
  Set-Typing $false
  Update-AtlasFrame (Now-Ms)
}
function Input-Allowed {
  $script:followInput -and -not (Reduced-Motion) -and -not $script:paused -and -not $script:quiet -and -not $script:hidden -and $script:act -eq 'idle' -and -not $script:interaction -and $script:chewN -eq 0 -and @('waiting', 'alert') -notcontains $script:mood -and (-not $script:spriteArt.animations -or ($script:posture -eq 'desk' -and $script:edge -eq 'ground'))
}
function Pulse-Input {
  $t = Now-Ms
  if (-not (Input-Allowed) -or $t - $script:lastInputAt -lt 65) { return }
  $script:lastInputAt = $t; $script:inputSide = 1 - $script:inputSide
  if ($script:inputSide) { $script:inputLAt = $t } else { $script:inputRAt = $t }
  Push-AtlasInput $t
  Set-Typing $true
  $script:nextIdleAt = $t + 20000
  Tick-Input $t
  $engine.Interval = [TimeSpan]::FromMilliseconds(20)
}
function Input-Stroke([double]$age) {
  if ($age -lt 0 -or $age -ge 280) { return @{ y = 0.0; press = 0.0; reach = 0.0 } }
  $times = @(0, 45, 95, 145, 215, 280); $heights = @(-3, -13, 5, -6, 1, 0)
  $i = 1; while ($i -lt $times.Count - 1 -and $age -gt $times[$i]) { $i++ }
  $u = ($age - $times[$i - 1]) / ($times[$i] - $times[$i - 1]); $ease = $u * $u * (3 - 2 * $u)
  @{ y = $heights[$i - 1] + ($heights[$i] - $heights[$i - 1]) * $ease; press = [Math]::Max(0.0, 1 - [Math]::Abs($age - 102) / 34.0); reach = [Math]::Min(1.0, [Math]::Min(($age + 15) / 30.0, (280 - $age) / 55.0)) }
}
function Tick-Input([double]$t) {
  if (-not $script:typing) { return }
  if (-not (Input-Allowed)) { Reset-Input; return }
  if ($script:spriteArt.animations) { Update-AtlasFrame $t; return }
  $contact = 0.0; $lean = 0.0
  foreach ($hand in @('L', 'R')) {
    $at = if ($hand -eq 'L') { $script:inputLAt } else { $script:inputRAt }
    $age = $t - $at; $x = 0.0; $y = 0.0
    $stroke = @{ y = 0.0; press = 0.0; reach = 0.0 }
    if ($at -gt 0 -and $age -ge 0 -and $age -lt 280) {
      $stroke = Input-Stroke $age; $y = $stroke.y
      if ($script:posture -eq 'classic') {
        $x = $(if ($hand -eq 'L') { if($script:lineArt){-2.0}else{8.0} } else { if($script:lineArt){2.0}else{-8.0} }) * $stroke.reach
        $y = ($(if($script:lineArt){-1}else{8}) + $y) * $stroke.reach
      }
    } elseif ($hand -eq 'L') { $script:inputLAt = 0 } else { $script:inputRAt = 0 }
    $ui["Arm${hand}Move"].X = $x; $ui["Arm${hand}Move"].Y = $y
    $ui["Arm${hand}Rot"].Angle = $(if ($hand -eq 'L') { -1 } else { 1 }) * [Math]::Max(0.0, -$stroke.y) * 0.9
    $ui["Arm${hand}Scale"].ScaleX = 1 + 0.22 * $stroke.press; $ui["Arm${hand}Scale"].ScaleY = 1 - 0.22 * $stroke.press
    $ui["Keys${hand}Move"].Y = 1.5 * $stroke.press; $ui["KeyLight$hand"].Opacity = $ui["Impact$hand"].Opacity = 0.9 * $stroke.press
    $contact = [Math]::Max($contact, $stroke.press); $lean += $(if ($hand -eq 'L') { -1 } else { 1 }) * $stroke.press * 1.4
  }
  $ui.InputBodyMove.Y = $contact * 1.4; $ui.InputBodyRot.Angle = $lean; $ui.InputBodyScale.ScaleX = 1 + $contact * 0.025
  $ui.InputBodyScale.ScaleY = $(if ($script:posture -eq 'desk') { 0.94 } else { 1.0 }) - $contact * 0.035
  if (-not $script:inputLAt -and -not $script:inputRAt) { Reset-Input }
  Update-AtlasFrame $t
}
function Sync-CompanionInput {
  # 跟敲与统计独立：只有统计明确开启时，Queue-Minute 才向 Host 交次数。
  [DotPet.KeyCounter]::CountKeys = $script:keysStatsOn
  [DotPet.KeyCounter]::React = $script:followInput -and -not (Reduced-Motion) -and -not $script:quiet -and -not $script:paused
  $want = $script:keysStatsOn -or [DotPet.KeyCounter]::React
  Sync-Keys $want
  if (-not (Input-Allowed) -and $script:typing) { Reset-Input }
}
function Select-CompanionTab([string]$tab) {
  $script:panelTab = $tab
  foreach ($item in @(@('today', 'TodayPage', 'TabToday'), @('company', 'CompanyPage', 'TabCompany'), @('look', 'LookPage', 'TabLook'))) {
    $selected = $item[0] -eq $tab
    $ui[$item[1]].Visibility = if ($selected) { 'Visible' } else { 'Collapsed' }
    $ui[$item[2]].Background = New-Brush $(if ($selected) { '#EDF1FF' } else { '#00FFFFFF' })
    $ui[$item[2]].Foreground = New-Brush $(if ($selected) { '#4F68AD' } else { '#6B7280' })
  }
}
function Sync-CompanionControls($pet) {
  $script:syncingCompanion = $true
  try {
    $ui.FollowInputCheck.IsChecked = $script:followInput
    $ui.MotionCheck.IsChecked = $script:motionPreference -eq 'reduced'
    $ui.QuietCheck.IsChecked = $miQuiet.IsChecked
    $ui.PostureSelect.SelectedIndex = if ($script:posture -eq 'classic') { 1 } else { 0 }
    foreach ($item in $ui.CharacterSelect.Items) { if ([string]$item.Tag -eq $script:characterId) { $ui.CharacterSelect.SelectedItem = $item; break } }
    foreach ($item in $ui.OutfitSelect.Items) { if ([string]$item.Tag -eq $script:outfit) { $ui.OutfitSelect.SelectedItem = $item; break } }
    if (-not $script:lookDraft) {
      $ui.PetNameInput.Text = if ($pet.name) { [string]$pet.name } else { 'Dot' }
      foreach ($item in $ui.ColorSelect.Items) { if ([string]$item.Tag -eq [string]$pet.color) { $ui.ColorSelect.SelectedItem = $item; break } }
    }
  } finally { $script:syncingCompanion = $false }
}
function Companion-Options($control, $items) {
  foreach ($row in $items) { $item = New-Object Windows.Controls.ComboBoxItem; $item.Content = [string]$row[1]; $item.Tag = [string]$row[0]; [void]$control.Items.Add($item) }
}
function Initialize-CompanionPanel {
  $ui.TabToday.Add_Click({ Select-CompanionTab 'today' }); $ui.TabCompany.Add_Click({ Select-CompanionTab 'company' }); $ui.TabLook.Add_Click({ Select-CompanionTab 'look' })
  Companion-Options $ui.PostureSelect @(@('desk', '桌边跟敲'), @('classic', '任务栏坐姿'))
  Companion-Options $ui.OutfitSelect $Outfits
  Companion-Options $ui.ColorSelect @(@('blue', '点点蓝'), @('green', '薄荷绿'), @('orange', '奶杏橙'), @('purple', '丁香紫'), @('pink', '棉花粉'), @('gray', '云朵灰'))
  $ui.PostureSelect.Add_SelectionChanged({ if (-not $script:syncingCompanion -and $ui.PostureSelect.SelectedItem) { Send-Dot '/pet' @{ action = 'look'; look = @{ posture = [string]$ui.PostureSelect.SelectedItem.Tag } } 'On-ArtSaved' $null } })
  $ui.CharacterSelect.Add_SelectionChanged({ if (-not $script:syncingCompanion -and $ui.CharacterSelect.SelectedItem) { Send-Dot '/pet' @{ action = 'character'; id = [string]$ui.CharacterSelect.SelectedItem.Tag } 'On-ArtSaved' $null } })
  $ui.OutfitSelect.Add_SelectionChanged({ if (-not $script:syncingCompanion -and $ui.OutfitSelect.SelectedItem) { Send-Dot '/pet' @{ action = 'outfit'; id = [string]$ui.OutfitSelect.SelectedItem.Tag } 'On-OpDone' $null } })
  $ui.FollowInputCheck.Add_Click({ Send-Dot '/pet' @{ action = 'look'; look = @{ followInput = [bool]$ui.FollowInputCheck.IsChecked } } 'On-ArtSaved' $null })
  $ui.MotionCheck.Add_Click({ Send-Dot '/pet' @{ action = 'motion'; value = $(if ($ui.MotionCheck.IsChecked) { 'reduced' } else { 'auto' }) } 'On-ArtSaved' $null })
  $ui.QuietCheck.Add_Click({ $miQuiet.IsChecked = $ui.QuietCheck.IsChecked; $script:quiet = $script:sysQuiet -or $miQuiet.IsChecked; Reset-Input; Reset-Interaction; Sync-CompanionInput })
  $ui.PetNameInput.Add_TextChanged({ if (-not $script:syncingCompanion) { $script:lookDraft = $true } })
  $ui.ColorSelect.Add_SelectionChanged({ if (-not $script:syncingCompanion) { $script:lookDraft = $true } })
  $ui.SaveLookBtn.Add_Click({
    $look = @{ name = $ui.PetNameInput.Text }
    if ($ui.ColorSelect.SelectedItem) { $look.color = [string]$ui.ColorSelect.SelectedItem.Tag }
    Send-Dot '/pet' @{ action = 'look'; look = $look } 'On-CompanionLookSaved' $null
  })
  [DotPet.KeyCounter]::Bind($window.Dispatcher, [Action]{ try { Pulse-Input } catch { Write-PetLog "input pulse failed: $_" } })
  Select-CompanionTab 'today'
}
function On-CompanionLookSaved($r, $state) {
  if ($r.ok) { $script:lookDraft = $false }
  On-ArtSaved $r $state
}

# 只由 DOT_PET_ART_SHOTS 的隔离开发进程调用。
function Save-CompanionFrame($element, [string]$path, [double]$width, [double]$height) {
  $element.Measure([Windows.Size]::new($width, $height)); $element.Arrange([Windows.Rect]::new(0, 0, $width, $height)); $element.UpdateLayout()
  $rtb = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]($width * 2), [int]($height * 2), 192, 192, [Windows.Media.PixelFormats]::Pbgra32)
  $visual = New-Object Windows.Media.DrawingVisual; $drawing = $visual.RenderOpen()
  $drawing.DrawRectangle([Windows.Media.VisualBrush]::new($element), $null, [Windows.Rect]::new(0, 0, $width, $height)); $drawing.Close(); $rtb.Render($visual)
  $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder; $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($rtb))
  $stream = [IO.File]::Create($path); try { $encoder.Save($stream) } finally { $stream.Close() }
}
function Test-CompanionShots([string]$dir, $colors) {
  Reset-Interaction; Reset-Input; $script:motionPreference = 'auto'; $script:followInput = $true; $script:mood = 'idle'; $script:quiet = $false; $script:paused = $false; $script:hidden = $false; $script:chewN = 0
  Set-Act 'idle'
  foreach ($posture in @('desk', 'classic')) {
    Set-Posture $posture
    foreach ($character in $script:petCatalog.characters) {
      Apply-Character $character; $script:idleColors = $colors[[string]$character.color]; Apply-Colors; Base-Face
      if ($character.renderer -eq 'dot-atlas-v1') {
        $expected = if ($posture -eq 'desk') { if ($character.animations.style -eq 'seated-v2') { 0 } elseif ($character.animations) { 5 } else { 3 } } else { 0 }
        if ($script:spriteIndex -ne $expected -or $ui.SpriteView.Source.PixelWidth -ne 512 -or $ui.VectorBody.Visibility -ne 'Collapsed') { throw 'native atlas crop or posture mismatch' }
      }
      Save-CompanionFrame $ui.Stage (Join-Path $dir ("posture-$posture-$($character.id).png")) $StageW $StageH
      if ($character.animations -and $posture -eq 'desk') { Test-AtlasMotionShots $dir $character }
      if ($env:DOT_PET_INPUT_FRAMES -and -not $character.animations) {
        # 实际 WPF 渲染器逐帧导出：慢敲、连续双手和停手，便于按原尺寸检查。
        $base = Now-Ms
        for ($frame = 0; $frame -lt 48; $frame++) {
          $time = $frame * 40
          $left = @(200, 680, 920, 1160) | Where-Object { $_ -le $time } | Select-Object -Last 1
          $right = @(440, 800, 1040) | Where-Object { $_ -le $time } | Select-Object -Last 1
          $script:inputLAt = if ($null -ne $left) { $base + $left } else { 0 }
          $script:inputRAt = if ($null -ne $right) { $base + $right } else { 0 }
          Set-Typing $true; Tick-Input ($base + $time)
          Save-CompanionFrame $ui.Stage (Join-Path $dir ('typing-{0}-{1}-{2:D2}.png' -f $posture, $character.id, $frame)) $StageW $StageH
        }
        Reset-Input
      }
    }
    if ($script:spriteArt.animations) { continue }
    Reset-Interaction; Reset-Input; $script:lastInputAt = 0; $script:inputSide = 0
    Pulse-Input
    $start = $script:inputLAt
    if (-not $script:typing -or -not $start) { throw 'first input did not respond immediately' }
    Tick-Input ($start + 45)
    if ($script:spriteArt -and $script:spriteIndex -ne $(if ($posture -eq 'desk') { 4 } else { 0 })) { throw 'atlas first hand must respond immediately without changing composition' }
    if ($ui.ArmLMove.Y -ge -4) { throw 'hand lift must be visible at actual pet size' }
    Tick-Input ($start + 102)
    if ($ui.ArmLMove.Y -le 0 -or $ui.ArmRMove.Y -ne 0) { throw 'left hand did not tap independently' }
    if ($ui.KeysLMove.Y -le 1 -or $ui.ArmLScale.ScaleY -ge 0.9 -or $ui.ImpactL.Opacity -le 0.5) { throw 'key contact must press keycaps and squash paw' }
    Save-CompanionFrame $ui.Stage (Join-Path $dir ("input-$posture-left.png")) $StageW $StageH
    # 下一次脉冲换右手；不排队补播。
    $script:lastInputAt = 0; $script:inputLAt = (Now-Ms) - 70
    Pulse-Input; $start = $script:inputRAt
    Tick-Input ($start + 65)
    if ($script:spriteArt -and $script:spriteIndex -ne $(if ($posture -eq 'desk') { 5 } else { 0 })) { throw 'atlas second hand must alternate' }
    if ([Math]::Abs($ui.ArmLMove.Y) -le 0.01 -or [Math]::Abs($ui.ArmRMove.Y) -le 0.01) { throw 'alternating hand response failed' }
    Save-CompanionFrame $ui.Stage (Join-Path $dir ("input-$posture-both.png")) $StageW $StageH
    Tick-Input ($start + 320)
    if ($script:spriteArt -and $script:spriteIndex -ne $(if ($posture -eq 'desk') { 3 } else { 0 })) { throw 'atlas must settle to neutral' }
    if ($script:typing -or $ui.ArmLMove.Y -ne 0 -or $ui.ArmRMove.Y -ne 0 -or $ui.ArmLMove.X -ne 0 -or $ui.ArmRMove.X -ne 0) { throw 'input did not settle at neutral' }
    if ($ui.KeysLMove.Y -ne 0 -or $ui.KeyLightL.Opacity -ne 0 -or $ui.ImpactR.Opacity -ne 0 -or $ui.ArmLScale.ScaleY -ne 1 -or $ui.InputBodyMove.Y -ne 0) { throw 'input feedback did not reset' }
  }
  foreach ($block in @('focus', 'waiting', 'quiet', 'paused', 'reduced', 'disabled')) {
    $script:followInput = $true; $script:motionPreference = 'auto'; $script:quiet = $false; $script:paused = $false; $script:mood = 'idle'; Set-Act 'idle'; Reset-Input
    switch ($block) { 'focus' { Set-Act 'focus' } 'waiting' { $script:mood = 'waiting' } 'quiet' { $script:quiet = $true } 'paused' { $script:paused = $true } 'reduced' { $script:motionPreference = 'reduced' } 'disabled' { $script:followInput = $false } }
    $script:lastInputAt = 0; Pulse-Input
    if ($script:typing) { throw "input must stop during $block" }
  }
  $script:paused = $false; $script:quiet = $false; $script:motionPreference = 'auto'; $script:mood = 'idle'; $script:followInput = $false; Set-Act 'idle'; Set-Posture 'desk'
  foreach ($o in $Outfits) { $script:outfit = [string]$o[0]; Apply-Outfit; Save-CompanionFrame $ui.Stage (Join-Path $dir ("outfit-$($o[0]).png")) $StageW $StageH }
  $snapshot = [DotPet.Http]::Get($StatusUrl).GetAwaiter().GetResult() | ConvertFrom-Json
  On-Status $snapshot $null; Render-Cards $true
  foreach ($tab in @('today', 'company', 'look')) {
    Select-CompanionTab $tab
    $child = $ui.Panel.Child
    $child.Measure([Windows.Size]::new($PanelW + 28, [double]::PositiveInfinity))
    Save-CompanionFrame $child (Join-Path $dir ("panel-$tab.png")) ($PanelW + 28) $child.DesiredSize.Height
  }
  # 真实挂钩可建立与卸载；不注入按键，不读取或输出用户输入。
  if (-not [DotPet.KeyCounter]::Start()) { throw 'keyboard pulse hook failed to start' }
  [DotPet.KeyCounter]::React = $false; [DotPet.KeyCounter]::Stop()
  if ([DotPet.KeyCounter]::On) { throw 'keyboard pulse hook did not stop' }
  $script:followInput = $false; Reset-Input
}

function Capture-AtlasMotion([string]$dir, [string]$label) {
  $script:spriteBlendAt = -1; $ui.SpriteView.Opacity = 1; $ui.SpritePrevious.Opacity = 0
  Save-CompanionFrame $ui.Stage (Join-Path $dir ("motion-$($script:characterId)-$label.png")) $StageW $StageH
}
function Test-AtlasMotionShots([string]$dir, $character) {
  if($character.animations.style -eq 'seated-v2'){Test-SeatedShots $dir $character;return}
  foreach ($height in @(0,16,32,48,80)) {
    $layout = Get-AtlasSeatLayout 180 ([double]$character.animations.seatY) $height
    if ($height -lt 20) { if ($layout.scale -ne 1 -or $layout.offset -ne 0) { throw 'autohidden taskbar layout must keep full size' }; continue }
    foreach ($bottom in @(720,1080,-100)) {
      $feet = $bottom - 6 + $layout.offset
      $hip = $feet - 180 * (1 - [double]$character.animations.seatY) * $layout.scale
      if ($feet -gt $bottom + $height - 4 + .01) { throw 'seated feet clipped by monitor' }
      if ([Math]::Abs($hip - $bottom) -gt .01) { throw 'seat did not align with taskbar' }
    }
  }
  $script:edge = 'ground'; Set-Act 'idle'; Set-Posture 'desk'; Reset-Input
  $t = Now-Ms; Update-AtlasFrame $t; Capture-AtlasMotion $dir 'desk'
  $script:spriteBorn = $t - 3560; Update-AtlasFrame $t
  if ($ui.AtlasBlink.Opacity -lt .99) { throw 'eyelid patch did not close' }; Capture-AtlasMotion $dir 'blink'
  $script:spriteBorn = $t; $script:lastInputAt = 0; Pulse-Input; $start = $script:spriteStrokeAt
  if ($start -lt 0 -or $script:spriteIndex -ne 0) { throw 'first atlas stroke not immediate' }
  Update-AtlasFrame ($start + 50); if ($script:spriteIndex -ne 1) { throw 'mid-stroke frame missing' }
  Update-AtlasFrame ($start + 106); if ($script:spriteIndex -ne 2 -or $ui.AtlasContactL.Opacity -lt .8) { throw 'key contact missing' }
  Capture-AtlasMotion $dir 'contact'
  Push-AtlasInput ($start + 120); Update-AtlasFrame ($start + 200)
  if ($script:spriteIndex -ne 3) { throw 'recent input should continue with opposite hand' }
  Update-AtlasFrame ($start + 450)
  if ($script:typing -or $script:spriteStrokeAt -ge 0 -or $script:spriteIndex -ne 5 -or $ui.AtlasContactR.Opacity -ne 0) { throw 'atlas input backlog or reset failure' }
  $t = Now-Ms; $script:spriteTouched = $t - 17000; Update-AtlasFrame $t
  if ($script:spritePose -ne 'thinking') { throw 'desk idle thinking missing' }; Capture-AtlasMotion $dir 'think'
  Set-Act 'held'; Update-AtlasFrame $t
  if ($script:spritePose -ne 'held' -or $script:spriteIndex -ne 2) { throw 'lifted pose missing' }; Capture-AtlasMotion $dir 'held'
  Set-Act 'idle'
  foreach ($edge in @('left','right')) {
    $script:edge = $edge; Update-AtlasFrame $t
    if ($script:spritePose -ne 'edge' -or [Math]::Sign($ui.AtlasScale.ScaleX) -ne $(if ($edge -eq 'right') { -1 } else { 1 })) { throw 'edge pose should face inward' }
    Capture-AtlasMotion $dir "edge-$edge"
  }
  $script:edge = 'ground'; Set-Posture 'classic'; Update-AtlasFrame $t
  $script:spriteBorn = $t - 3560; Update-AtlasFrame $t; Capture-AtlasMotion $dir 'standing-blink'
  $script:spriteTouched = $t - 8500; Update-AtlasFrame $t
  if (-not $script:spriteSeated -or $script:spriteIndex -ne 4) { throw 'taskbar sitting missing' }; Capture-AtlasMotion $dir 'sit'
  Capture-AtlasMotion $dir 'sit-blink'
  $script:spriteTouched = $t - 17000; Update-AtlasFrame $t
  if ($script:spriteIndex -ne 5 -or -not $script:spriteSeated) { throw 'seated thinking missing' }; Capture-AtlasMotion $dir 'sit-think'
  $script:motionPreference = 'reduced'; Update-AtlasFrame $t
  if ($ui.AtlasRot.Angle -ne 0 -or $ui.AtlasScale.ScaleY -ne 1 -or $ui.AtlasBlink.Opacity -ne 0) { throw 'reduced motion must cancel ambient transforms' }
  $script:motionPreference = 'auto'; Set-Posture 'desk'; Reset-Input; $script:spriteBorn = Now-Ms
  if ($env:DOT_PET_INPUT_FRAMES) {
    $base = Now-Ms; Update-AtlasFrame $base; $script:spriteHand = 1
    for ($frame = 0; $frame -lt 60; $frame++) {
      $time = $base + $frame * 40
      if ($frame -ge 5 -and $frame -le 37 -and $frame % 3 -eq 2) { Push-AtlasInput $time; $script:typing = $true }
      Update-AtlasFrame $time
      Save-CompanionFrame $ui.Stage (Join-Path $dir ('motion-typing-{0}-{1:D2}.png' -f $character.id, $frame)) $StageW $StageH
    }
  }
  Reset-Input; $script:spriteTouched = Now-Ms; $script:spriteBorn = $script:spriteTouched; Update-AtlasFrame $script:spriteTouched
}
