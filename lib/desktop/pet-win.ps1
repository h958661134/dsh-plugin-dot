# Dot 桌面精灵（Windows）：由 Dot 的 Host 启动和看管，不单独安装、不单独运行。
# 只用系统自带的 PowerShell 5.1 + WPF：无边框、透明、始终置顶、可拖动、贴边吸附并半隐藏。
#
# 数据：GET /api/dsh-plugin-dot/status?desk=1（含 Host 算好的 desk：卡片、摘要、名字、颜色、Dot 的最新回复）。
# 动作：只调 Dot 自己的本机接口，和网页小精灵完全一样（/task /notice /say /focus）。
# 打开：先直接把 DSH 主窗口拉到前台（精灵刚被点过，系统允许它切前台），再把目标交给 /focus，
#       DSH 网页端挂着长轮询，立刻跳转。主窗口藏在托盘里时退回 dsh://open。
# 所有网络请求都是异步的，界面不会卡。父进程（DSH 运行时）退出后自己退出。
#
# 注意：事件处理里不要用 GetNewClosure()——闭包看不到脚本里定义的函数和变量。
#       需要按控件区分数据时放进控件的 Tag，处理时从 $sender.Tag 取。
param(
  [Parameter(Mandatory = $true)][string]$StatusUrl,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$StateFile,
  [string]$OpenUrl = 'dsh://open'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Net.Http

# ── 单实例：同一个状态文件只允许一个精灵 ──
$mutexName = 'Local\DotDesktopPet_' + [BitConverter]::ToString(
  [System.Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($StateFile))).Replace('-', '').Substring(0, 16)
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) { exit 0 }

Add-Type -ReferencedAssemblies System.Net.Http -TypeDefinition @'
using System;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
namespace DotPet {
  public static class Native {
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    struct RECT { public int L, T, R, B; }

    /** 某个进程最大的可见、有标题的顶层窗口。 */
    public static IntPtr MainWindowOf(int pid) {
      IntPtr best = IntPtr.Zero; long bestArea = 0;
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        uint p; GetWindowThreadProcessId(h, out p);
        if (p != (uint)pid || !IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
        RECT r; GetWindowRect(h, out r);
        long area = (long)(r.R - r.L) * (r.B - r.T);
        if (area > bestArea) { bestArea = area; best = h; }
        return true;
      }, IntPtr.Zero);
      return best;
    }

    /** 把进程的主窗口拉到前台：最小化的先还原。成功返回 true。 */
    public static bool BringToFront(int pid) {
      if (pid <= 0) return false;
      IntPtr h = MainWindowOf(pid);
      if (h == IntPtr.Zero) return false;
      if (IsIconic(h)) ShowWindow(h, 9);
      if (SetForegroundWindow(h)) return true;
      // 系统不让切前台时，按一下 Alt 解除限制再试一次
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      return SetForegroundWindow(h);
    }
  }

  public static class Http {
    static readonly HttpClient client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    public static Task<string> Get(string url) { return client.GetStringAsync(url); }
    public static async Task<string> Post(string url, string json) {
      var req = new HttpRequestMessage(HttpMethod.Post, url);
      req.Headers.Add("X-Dot-Client", "1");
      req.Content = new StringContent(json, Encoding.UTF8, "application/json");
      var res = await client.SendAsync(req).ConfigureAwait(false);
      return await res.Content.ReadAsStringAsync().ConfigureAwait(false);
    }
  }
}
'@

# 排查用的日志：和状态文件放在一起，超过 64KB 就重写
$LogFile = [IO.Path]::ChangeExtension($StateFile, '.log')
function Write-PetLog([string]$msg) {
  try {
    if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 65536) { Remove-Item -LiteralPath $LogFile -Force }
    [IO.File]::AppendAllText($LogFile, ('{0:yyyy-MM-dd HH:mm:ss} {1}{2}' -f (Get-Date), $msg, [Environment]::NewLine))
  } catch { }
}
Write-PetLog "start pid=$PID parent=$ParentPid"

$ApiBase = $StatusUrl -replace '/status(\?.*)?$', ''
# DSH 桌面版的主进程：运行时（父进程）的父进程。命令行起的 DSH 没有主窗口，找不到就退回 dsh://open
$DshMainPid = 0
try { $DshMainPid = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$ParentPid").ParentProcessId } catch { }
$FirstRun = -not (Test-Path -LiteralPath $StateFile)

$PetSize = 56          # 精灵本体（WPF 单位）
$Peek = 22             # 半隐藏时露出的宽度
$SnapDistance = 28     # 离屏幕边缘多近就吸附
$Margin = 8
$WinW = 320            # 窗口固定大小：透明部分点击会穿透，不挡桌面
$WinH = 96
$PanelW = 312
$MaxCards = 3

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        Width="$WinW" Height="$WinH" Title="Dot" FontFamily="Microsoft YaHei UI">
  <Window.Resources>
    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Background" Value="#F2F3F5"/>
      <Setter Property="Foreground" Value="#1F2937"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Padding" Value="9,3"/>
      <Setter Property="Margin" Value="0,0,6,0"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="{TemplateBinding Background}" CornerRadius="7" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Opacity" Value="0.82"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="Opacity" Value="0.65"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="B" Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Main" TargetType="Button" BasedOn="{StaticResource Btn}">
      <Setter Property="Background" Value="#4D6BFE"/>
      <Setter Property="Foreground" Value="White"/>
    </Style>
  </Window.Resources>
  <Grid x:Name="Root" HorizontalAlignment="Right" VerticalAlignment="Center" Background="Transparent" AllowDrop="True">
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width="Auto"/>
      <ColumnDefinition Width="Auto"/>
    </Grid.ColumnDefinitions>
    <Border x:Name="Bubble" Grid.Column="0" Visibility="Collapsed" Margin="0,0,8,0" Cursor="Hand"
            VerticalAlignment="Center" MaxWidth="240" CornerRadius="10" Padding="10,6"
            Background="#F7FFFFFF" BorderBrush="#22000000" BorderThickness="1">
      <Border.Effect><DropShadowEffect BlurRadius="10" ShadowDepth="1" Opacity="0.18"/></Border.Effect>
      <TextBlock x:Name="BubbleText" TextWrapping="Wrap" FontSize="12.5" Foreground="#1F2937"/>
    </Border>
    <Grid x:Name="Pet" Grid.Column="1" Width="$PetSize" Height="$PetSize" Cursor="Hand" Background="Transparent" RenderTransformOrigin="0.5,0.5">
      <Grid.RenderTransform>
        <TransformGroup>
          <ScaleTransform x:Name="PetScale" ScaleX="1" ScaleY="1"/>
          <RotateTransform x:Name="PetRot" Angle="0"/>
        </TransformGroup>
      </Grid.RenderTransform>
      <Border x:Name="Body" CornerRadius="18" Margin="4">
        <Border.Background>
          <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
            <GradientStop x:Name="Top" Color="#8AA2FF" Offset="0"/>
            <GradientStop x:Name="Bottom" Color="#4D6BFE" Offset="1"/>
          </LinearGradientBrush>
        </Border.Background>
        <Border.Effect><DropShadowEffect BlurRadius="12" ShadowDepth="2" Opacity="0.30"/></Border.Effect>
        <Canvas Width="26" Height="18" HorizontalAlignment="Center" VerticalAlignment="Center">
          <Rectangle x:Name="EyeL" Canvas.Left="4" Canvas.Top="3" Width="6" Height="12" RadiusX="3" RadiusY="3" Fill="White"/>
          <Rectangle x:Name="EyeR" Canvas.Left="16" Canvas.Top="3" Width="6" Height="12" RadiusX="3" RadiusY="3" Fill="White"/>
        </Canvas>
      </Border>
      <Border x:Name="Badge" Visibility="Collapsed" HorizontalAlignment="Right" VerticalAlignment="Top"
              MinWidth="18" Height="18" CornerRadius="9" Background="#EF4444" Padding="4,0"
              BorderBrush="White" BorderThickness="1.5">
        <TextBlock x:Name="BadgeText" FontSize="10.5" FontWeight="Bold" Foreground="White"
                   HorizontalAlignment="Center" VerticalAlignment="Center"/>
      </Border>
    </Grid>
    <Popup x:Name="Panel" PlacementTarget="{Binding ElementName=Pet}" Placement="Top" StaysOpen="False"
           AllowsTransparency="True" PopupAnimation="Fade" VerticalOffset="-6">
      <Border Width="$PanelW" Margin="10" CornerRadius="14" Background="White" BorderBrush="#1A000000" BorderThickness="1">
        <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="3" Opacity="0.22"/></Border.Effect>
        <StackPanel Margin="14,12,14,12">
          <DockPanel>
            <Button x:Name="CloseBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Background="Transparent" Margin="0" Padding="6,2" Content="✕" ToolTip="收起（Esc）"/>
            <Button x:Name="PauseBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Content="暂停" ToolTip="暂停或恢复 Dot 的定时任务和有副作用的操作"/>
            <TextBlock x:Name="NameText" Text="Dot" FontSize="15" FontWeight="Bold" Foreground="#111827" VerticalAlignment="Center"/>
          </DockPanel>
          <TextBlock x:Name="SummaryText" Margin="0,4,0,0" FontSize="12" Foreground="#6B7280" TextWrapping="Wrap"/>
          <TextBlock x:Name="HintText" Margin="0,4,0,0" FontSize="11" Foreground="#9CA3AF" TextWrapping="Wrap" Visibility="Collapsed"/>
          <StackPanel x:Name="Cards" Margin="0,8,0,0"/>
          <Border x:Name="ReplyBox" Visibility="Collapsed" Margin="0,0,0,8" CornerRadius="10" Padding="10,8" Background="#F5F7FF" BorderBrush="#DDE3FF" BorderThickness="1">
            <StackPanel>
              <DockPanel>
                <Button x:Name="ReplyOpenBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Margin="0" Padding="7,1" FontSize="11" Content="在 DSH 里看"/>
                <TextBlock x:Name="ReplyHead" Text="Dot" FontSize="11.5" FontWeight="SemiBold" Foreground="#4D6BFE" VerticalAlignment="Center"/>
              </DockPanel>
              <ScrollViewer MaxHeight="150" VerticalScrollBarVisibility="Auto" Margin="0,4,0,0">
                <TextBlock x:Name="ReplyText" FontSize="12.5" Foreground="#1F2937" TextWrapping="Wrap"/>
              </ScrollViewer>
            </StackPanel>
          </Border>
          <WrapPanel x:Name="Quick"/>
          <DockPanel Margin="0,2,0,0">
            <Button x:Name="SendBtn" DockPanel.Dock="Right" Style="{StaticResource Main}" Margin="6,0,0,0" Content="发送"/>
            <Border CornerRadius="8" BorderBrush="#D1D5DB" BorderThickness="1" Padding="6,3">
              <Grid>
                <TextBlock x:Name="Placeholder" Text="跟 Dot 说一句，或输入 /task …" Foreground="#9CA3AF" FontSize="12.5" IsHitTestVisible="False" VerticalAlignment="Center"/>
                <TextBox x:Name="Input" BorderThickness="0" Background="Transparent" FontSize="12.5" VerticalContentAlignment="Center"/>
              </Grid>
            </Border>
          </DockPanel>
          <TextBlock x:Name="OutText" Margin="0,6,0,0" FontSize="12" TextWrapping="Wrap" Visibility="Collapsed"/>
          <UniformGrid Columns="2" Margin="0,10,0,0">
            <Button x:Name="DotBtn" Style="{StaticResource Btn}" Margin="0,0,4,0" Padding="0,5" Content="打开 Dot" ToolTip="把 DSH 拉到前台，打开 Dot 会话（双击精灵也行）"/>
            <Button x:Name="SessBtn" Style="{StaticResource Btn}" Margin="4,0,0,0" Padding="0,5" Content="会话总览" ToolTip="把 DSH 拉到前台，打开会话总览"/>
          </UniformGrid>
        </StackPanel>
      </Border>
    </Popup>
  </Grid>
</Window>
"@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$ui = @{}
foreach ($n in 'Root', 'Pet', 'PetScale', 'PetRot', 'Bubble', 'BubbleText', 'Badge', 'BadgeText', 'EyeL', 'EyeR', 'Top', 'Bottom', 'Panel', 'CloseBtn', 'PauseBtn',
  'NameText', 'SummaryText', 'HintText', 'Cards', 'ReplyBox', 'ReplyHead', 'ReplyText', 'ReplyOpenBtn', 'Quick', 'SendBtn', 'Placeholder', 'Input', 'OutText', 'DotBtn', 'SessBtn') {
  $ui[$n] = $window.FindName($n)
}
function New-Brush([string]$hex) { New-Object Windows.Media.SolidColorBrush ([Windows.Media.ColorConverter]::ConvertFromString($hex)) }
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# ── 异步请求：发出去就返回，结果由 40ms 一次的定时器取回，交给指定的处理函数（按名字调用）──
$script:pending = New-Object System.Collections.ArrayList
# 精灵只会调这几个写接口（和网页小精灵一样），卡片里给别的路径一律不执行
$AllowedPosts = @('/task', '/notice', '/say', '/focus')
function Send-Dot([string]$path, $body, [string]$handler, $state) {
  if ($AllowedPosts -notcontains $path) { Write-PetLog "blocked post $path"; return }
  $json = if ($null -eq $body) { '{}' } else { ConvertTo-Json -InputObject $body -Compress -Depth 8 }
  [void]$script:pending.Add(@{ Task = [DotPet.Http]::Post($ApiBase + $path, $json); Handler = $handler; State = $state })
}
function Get-Dot([string]$url, [string]$handler) {
  [void]$script:pending.Add(@{ Task = [DotPet.Http]::Get($url); Handler = $handler; State = $null })
}
$pump = New-Object Windows.Threading.DispatcherTimer
$pump.Interval = [TimeSpan]::FromMilliseconds(40)
$pump.Add_Tick({
  if ($script:pending.Count -eq 0) { return }
  foreach ($req in @($script:pending)) {
    if (-not $req.Task.IsCompleted) { continue }
    $script:pending.Remove($req)
    $result = $null
    if ($req.Task.IsFaulted -or $req.Task.IsCanceled) {
      $result = [pscustomobject]@{ ok = $false; text = '连不上 Dot，DSH 还在运行吗？'; failed = $true }
    } else {
      try { $result = $req.Task.Result | ConvertFrom-Json } catch { $result = [pscustomobject]@{ ok = $false; text = '返回的内容看不懂'; failed = $true } }
    }
    if ($req.Handler) {
      try { & $req.Handler $result $req.State } catch { Write-PetLog "handler $($req.Handler) failed: $_" }
    }
  }
})

# ── 位置：读写状态文件；默认放在主屏右下角 ──
$script:edge = 'none'   # left / right / none
$script:hidden = $false
function Get-WorkArea([double]$x, [double]$y) {
  $src = [Windows.PresentationSource]::FromVisual($window)
  $scale = if ($src) { $src.CompositionTarget.TransformToDevice.M11 } else { 1.0 }
  $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point([int]($x * $scale), [int]($y * $scale))))
  $wa = $screen.WorkingArea
  return @{ Left = $wa.Left / $scale; Top = $wa.Top / $scale; Right = $wa.Right / $scale; Bottom = $wa.Bottom / $scale }
}
function Save-Position {
  try {
    $data = @{ left = $window.Left; top = $window.Top; edge = $script:edge } | ConvertTo-Json -Compress
    $dir = Split-Path -Parent $StateFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    [IO.File]::WriteAllText($StateFile, $data, (New-Object Text.UTF8Encoding($false)))
  } catch { }
}
function Restore-Position {
  $wa = [Windows.SystemParameters]::WorkArea
  $window.Left = $wa.Right - $WinW - $Margin - 16
  $window.Top = $wa.Bottom - $WinH - $Margin - 60
  try {
    if (Test-Path -LiteralPath $StateFile) {
      $s = [IO.File]::ReadAllText($StateFile) | ConvertFrom-Json
      $area = Get-WorkArea $s.left $s.top
      if ($s.left -ge $area.Left - $WinW -and $s.left -le $area.Right -and $s.top -ge $area.Top -and $s.top -le $area.Bottom) {
        $window.Left = [double]$s.left; $window.Top = [double]$s.top
        if ($s.edge) { $script:edge = [string]$s.edge }
      }
    }
  } catch { }
}

# 气泡放在精灵的哪一侧：贴左边时在右，其余时候在左；面板也跟着对齐
function Update-Layout {
  $ui.Root.HorizontalAlignment = if ($script:edge -eq 'left') { 'Left' } else { 'Right' }
  if ($script:edge -eq 'left') {
    [Windows.Controls.Grid]::SetColumn($ui.Bubble, 1); [Windows.Controls.Grid]::SetColumn($ui.Pet, 0)
    $ui.Bubble.Margin = '8,0,0,0'
    $ui.Panel.HorizontalOffset = -10
  } else {
    [Windows.Controls.Grid]::SetColumn($ui.Bubble, 0); [Windows.Controls.Grid]::SetColumn($ui.Pet, 1)
    $ui.Bubble.Margin = '0,0,8,0'
    $ui.Panel.HorizontalOffset = $PetSize - $PanelW - 10
  }
}

# ── 动画 ──
function New-Anim([double]$from, [double]$to, [int]$ms) {
  $a = New-Object Windows.Media.Animation.DoubleAnimation
  $a.From = $from; $a.To = $to
  $a.Duration = New-Object Windows.Duration ([TimeSpan]::FromMilliseconds($ms))
  $a.EasingFunction = New-Object Windows.Media.Animation.QuadraticEase
  return $a
}
# 滑动：先把位置定好，再从旧位置播 180ms 动画过去（动画结束后自然停在新位置）
function Move-To([double]$left) {
  $from = $window.Left
  $window.BeginAnimation([Windows.Window]::LeftProperty, $null)
  $window.Left = $left
  if ([Math]::Abs($from - $left) -lt 1) { return }
  $anim = New-Anim $from $left 180
  $anim.FillBehavior = 'Stop'
  $window.BeginAnimation([Windows.Window]::LeftProperty, $anim)
}
# 按下：缩一下；弹起：回弹
function Squash([double]$to) {
  $a = New-Anim $ui.PetScale.ScaleX $to 90
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $a)
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $a)
}
function Bounce {
  $a = New-Object Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  foreach ($kf in @(@(0, 1.0), @(110, 1.14), @(220, 0.94), @(320, 1.0))) {
    [void]$a.KeyFrames.Add((New-Object Windows.Media.Animation.EasingDoubleKeyFrame($kf[1], [Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($kf[0])))))
  }
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $a)
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $a)
}
# 有新的「需要你」：摇一摇
function Shake {
  $a = New-Object Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $t = 0
  foreach ($deg in @(0, -12, 10, -8, 6, -3, 0)) {
    [void]$a.KeyFrames.Add((New-Object Windows.Media.Animation.LinearDoubleKeyFrame($deg, [Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($t)))))
    $t += 70
  }
  $ui.PetRot.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, $a)
}

# ── 吸附与半隐藏 ──
function Snap {
  $area = Get-WorkArea ($window.Left + $WinW - $PetSize / 2) ($window.Top + $WinH / 2)
  $petLeft = if ($script:edge -eq 'left') { $window.Left } else { $window.Left + $WinW - $PetSize }
  if ($petLeft - $area.Left -lt $SnapDistance) { $script:edge = 'left'; $target = $area.Left }
  elseif ($area.Right - ($petLeft + $PetSize) -lt $SnapDistance) { $script:edge = 'right'; $target = $area.Right - $WinW }
  else { $script:edge = 'none'; $target = $petLeft - ($WinW - $PetSize) }
  if ($window.Top -lt $area.Top) { $window.Top = $area.Top }
  if ($window.Top + $WinH -gt $area.Bottom) { $window.Top = $area.Bottom - $WinH }
  Update-Layout
  Move-To $target
  Save-Position
}
function Set-Hidden([bool]$hide) {
  if ($script:edge -eq 'none' -or $script:hidden -eq $hide) { return }
  if ($hide -and ($ui.Bubble.Visibility -eq 'Visible' -or $ui.Panel.IsOpen)) { return } # 有话要说、面板开着时不藏
  $area = Get-WorkArea ($window.Left + $WinW / 2) ($window.Top + $WinH / 2)
  $script:hidden = $hide
  if ($script:edge -eq 'right') {
    $to = if ($hide) { $area.Right - $Peek - ($WinW - $PetSize) } else { $area.Right - $WinW }
  } else {
    $to = if ($hide) { $area.Left - $PetSize + $Peek } else { $area.Left }
  }
  Move-To $to
}
$hideTimer = New-Object Windows.Threading.DispatcherTimer
$hideTimer.Interval = [TimeSpan]::FromSeconds(2.5)
$hideTimer.Add_Tick({ $hideTimer.Stop(); if (-not $ui.Root.IsMouseOver) { Set-Hidden $true } })
$ui.Root.Add_MouseEnter({ $hideTimer.Stop(); Set-Hidden $false })
$ui.Root.Add_MouseLeave({ if ($script:edge -ne 'none') { $hideTimer.Stop(); $hideTimer.Start() } })

# ── 临时气泡（「正在打开 DSH…」这类即时反馈），几秒后让位给状态气泡 ──
$script:flashUntil = [DateTime]::MinValue
function Flash([string]$text, [double]$seconds = 2.5) {
  $ui.BubbleText.Text = $text
  $ui.Bubble.Visibility = 'Visible'
  $script:flashUntil = (Get-Date).AddSeconds($seconds)
  Set-Hidden $false
}

# ── 打开 DSH：直接把主窗口拉到前台，同时把要去哪告诉网页端 ──
function Show-Dsh {
  $ok = $false
  try { $ok = [DotPet.Native]::BringToFront($DshMainPid) } catch { }
  if (-not $ok) {
    # 主窗口藏在托盘里（或者是命令行起的 DSH）：让 DSH 自己来切前台
    try { [void][DotPet.Native]::AllowSetForegroundWindow(-1); Start-Process $OpenUrl } catch { }
  }
  Write-PetLog "show dsh direct=$ok"
}
function Focus-Dsh($op) {
  Close-Panel
  Flash '正在打开 DSH…' 2
  Show-Dsh
  $body = @{}
  if ($null -ne $op.open) { $body.open = $op.open }
  if ($op.nav) { $body.nav = [string]$op.nav }
  if ($body.Count) { Send-Dot '/focus' $body '' $null }
}

# ── 面板 ──
function Show-Out([string]$text, [bool]$isErr) {
  if (-not $text) { $ui.OutText.Visibility = 'Collapsed'; return }
  $ui.OutText.Text = $text
  $ui.OutText.Foreground = New-Brush $(if ($isErr) { '#DC2626' } else { '#374151' })
  $ui.OutText.Visibility = 'Visible'
}
function Open-Panel {
  $hideTimer.Stop(); Set-Hidden $false
  $ui.Bubble.Visibility = 'Collapsed'
  if (-not $script:awaiting) { Show-Out '' $false }
  Render-Cards $true
  [void]$window.Activate()
  $ui.Panel.IsOpen = $true
  [void]$ui.Input.Focus()
  Refresh
}
function Close-Panel { $ui.Panel.IsOpen = $false }
$ui.CloseBtn.Add_Click({ Close-Panel })
$ui.Panel.Add_Closed({ if ($script:edge -ne 'none' -and -not $ui.Root.IsMouseOver) { $hideTimer.Start() } })
$ui.Bubble.Add_MouseLeftButtonUp({ Open-Panel })

# 卡片按钮：先给反馈（卡片变淡、按钮禁用），打开类立刻切到 DSH，写操作异步发出
function Run-Op($tag) {
  $op = $tag.op
  if ($op.post -and $AllowedPosts -notcontains [string]$op.post) { Show-Out '这个操作桌面精灵做不了，去 Dot 窗口里处理' $true; return }
  if ($tag.box) { $tag.box.Opacity = 0.45; $tag.box.IsEnabled = $false }
  if ($null -ne $op.open -or $op.nav) {
    if ($op.post) { Send-Dot ([string]$op.post) $op.body 'On-OpDone' $null }
    Focus-Dsh $op
    return
  }
  if ($op.post) { Send-Dot ([string]$op.post) $op.body 'On-OpDone' $tag.box }
}
function On-OpDone($r, $box) {
  if ($r.text) { Show-Out ([string]$r.text) ($r.ok -eq $false) }
  if ($r.ok -eq $false -and $box) { $box.Opacity = 1; $box.IsEnabled = $true }
  $script:forceCards = $true
  Refresh
}

# ── 说话：斜杠指令在本地执行；其余交给 Dot，回复直接显示在面板里 ──
$script:history = New-Object System.Collections.ArrayList
$script:histPos = -1
$script:awaiting = $false
$script:sentAt = 0
function Say([string]$text) {
  $text = $text.Trim()
  if (-not $text) { return }
  [void]$script:history.Insert(0, $text); if ($script:history.Count -gt 20) { $script:history.RemoveAt(20) }
  $script:histPos = -1
  $ui.SendBtn.IsEnabled = $false; $ui.SendBtn.Content = '…'
  $isCmd = $text.StartsWith('/')
  if (-not $isCmd) { $script:sentAt = Now-Ms }
  Send-Dot '/say' @{ text = $text } 'On-Said' @{ cmd = $isCmd }
}
function On-Said($r, $state) {
  $ui.SendBtn.IsEnabled = $true; $ui.SendBtn.Content = '发送'
  if ($r.ok -ne $false) { $ui.Input.Text = '' }
  Show-Out ([string]$r.text) ($r.ok -eq $false)
  if (-not $state.cmd -and $r.ok -ne $false) {
    $script:awaiting = $true
    $ui.ReplyHead.Text = "$($ui.NameText.Text) 正在想…"
    $ui.ReplyText.Text = ''
    $ui.ReplyBox.Visibility = 'Visible'
  }
  $script:forceCards = $true
  Refresh
}
$ui.SendBtn.Add_Click({ Say $ui.Input.Text })
$ui.Input.Add_PreviewKeyDown({
  param($s, $e)
  # 输入法组字时回车的 Key 是 ImeProcessed，不会走到这里
  switch ($e.Key) {
    'Return' { $e.Handled = $true; Say $ui.Input.Text }
    'Escape' { $e.Handled = $true; Close-Panel }
    'Up' {
      if ($script:history.Count -and $script:histPos -lt $script:history.Count - 1) {
        $script:histPos++; $ui.Input.Text = $script:history[$script:histPos]; $ui.Input.CaretIndex = $ui.Input.Text.Length; $e.Handled = $true
      }
    }
    'Down' {
      if ($script:histPos -gt 0) { $script:histPos--; $ui.Input.Text = $script:history[$script:histPos] }
      elseif ($script:histPos -eq 0) { $script:histPos = -1; $ui.Input.Text = '' }
      $ui.Input.CaretIndex = $ui.Input.Text.Length; $e.Handled = $true
    }
  }
})
$ui.Input.Add_TextChanged({ $ui.Placeholder.Visibility = if ($ui.Input.Text) { 'Collapsed' } else { 'Visible' } })
$ui.PauseBtn.Add_Click({ Say $(if ($script:paused) { '/resume' } else { '/pause' }) })
$ui.DotBtn.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'dot' }) })
$ui.SessBtn.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'sessions' }) })
$ui.ReplyOpenBtn.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'dot' }) })
# 快捷按钮：「!」开头的直接发，其余填进输入框
foreach ($q in @(@('记一件事', '/task '), @('设个提醒', '/remind '), @('今日简报', '!/brief'), @('能做什么', '!/dot'))) {
  $b = New-Object Windows.Controls.Button
  $b.Content = $q[0]; $b.Style = $window.FindResource('Btn'); $b.Margin = '0,0,6,6'; $b.Tag = $q[1]
  $b.Add_Click({
    param($sender, $e)
    $fill = [string]$sender.Tag
    if ($fill.StartsWith('!')) { Say $fill.Substring(1) }
    else { $ui.Input.Text = $fill; [void]$ui.Input.Focus(); $ui.Input.CaretIndex = $ui.Input.Text.Length }
  })
  [void]$ui.Quick.Children.Add($b)
}

# ── 拖东西给精灵：文字或文件，变成一条待记的事 ──
$ui.Root.Add_DragEnter({ param($s, $e) $e.Effects = 'Copy'; Flash '放进来，帮你记下' 2; Bounce })
$ui.Root.Add_Drop({
  param($s, $e)
  $text = ''
  if ($e.Data.GetDataPresent([Windows.DataFormats]::FileDrop)) {
    $files = @($e.Data.GetData([Windows.DataFormats]::FileDrop))
    $text = '处理 ' + (($files | Select-Object -First 3 | ForEach-Object { [IO.Path]::GetFileName($_) }) -join '、') + $(if ($files.Count -gt 3) { " 等 $($files.Count) 个文件" } else { '' })
  } elseif ($e.Data.GetDataPresent([Windows.DataFormats]::UnicodeText)) {
    $text = ([string]$e.Data.GetData([Windows.DataFormats]::UnicodeText)).Trim() -replace '\s+', ' '
    if ($text.Length -gt 80) { $text = $text.Substring(0, 80) + '…' }
  }
  if (-not $text) { return }
  Open-Panel
  $ui.Input.Text = "/task $text"
  $ui.Input.CaretIndex = $ui.Input.Text.Length
  Show-Out '回车就记下；想设时间，在 /task 后面加，比如「/task 明天10点 …」' $false
})

# 卡片：内容变了才重建；鼠标停在卡片上时先不动（重建会吞掉点击）
$script:cardsKey = ''
$script:forceCards = $false
$script:desk = $null
$kindColors = @{ approval = '#FFF7E6'; question = '#FFF7E6'; overdue = '#FEF2F2'; failed = '#FEF2F2'; done = '#ECFDF5'; handoff = '#F5F3FF'; soon = '#FFFBEB'; suggestions = '#EEF2FF' }
$kindBorders = @{ approval = '#FCD34D'; question = '#FCD34D'; overdue = '#FCA5A5'; failed = '#FCA5A5'; done = '#86EFAC'; handoff = '#C4B5FD'; soon = '#FDE68A'; suggestions = '#C7D2FE' }
function Render-Cards([bool]$force) {
  $desk = $script:desk
  if (-not $desk) { return }
  $cards = @($desk.cards)
  $key = ($cards | ForEach-Object { "$($_.key)|$($_.body)" }) -join "`n"
  if (-not $force -and -not $script:forceCards -and $key -eq $script:cardsKey) { return }
  if (-not $force -and $ui.Cards.IsMouseOver) { return }
  $script:cardsKey = $key; $script:forceCards = $false
  $ui.Cards.Children.Clear()
  foreach ($c in ($cards | Select-Object -First $MaxCards)) {
    $box = New-Object Windows.Controls.Border
    $box.CornerRadius = 10; $box.Padding = '10,8'; $box.Margin = '0,0,0,8'; $box.BorderThickness = 1
    $bg = $kindColors[[string]$c.kind]; if (-not $bg) { $bg = '#F9FAFB' }
    $bd = $kindBorders[[string]$c.kind]; if (-not $bd) { $bd = '#E5E7EB' }
    $box.Background = New-Brush $bg; $box.BorderBrush = New-Brush $bd
    $stack = New-Object Windows.Controls.StackPanel
    $t = New-Object Windows.Controls.TextBlock
    $t.Text = [string]$c.title; $t.FontWeight = 'SemiBold'; $t.FontSize = 13; $t.TextTrimming = 'CharacterEllipsis'; $t.ToolTip = [string]$c.title
    [void]$stack.Children.Add($t)
    if ($c.body) {
      $bt = New-Object Windows.Controls.TextBlock
      $bt.Text = [string]$c.body; $bt.FontSize = 12; $bt.Foreground = New-Brush '#4B5563'; $bt.TextWrapping = 'Wrap'; $bt.MaxHeight = 34
      $bt.TextTrimming = 'CharacterEllipsis'; $bt.Margin = '0,2,0,0'; $bt.ToolTip = [string]$c.body
      [void]$stack.Children.Add($bt)
    }
    if (@($c.buttons).Count) {
      $row = New-Object Windows.Controls.WrapPanel
      $row.Margin = '0,6,0,0'
      foreach ($btn in @($c.buttons)) {
        $b = New-Object Windows.Controls.Button
        $b.Content = [string]$btn.label
        $b.Style = $window.FindResource($(if ($btn.main) { 'Main' } else { 'Btn' }))
        $b.Tag = @{ op = $btn.op; box = $box }
        $b.Add_Click({ param($sender, $e) Run-Op $sender.Tag })
        [void]$row.Children.Add($b)
      }
      [void]$stack.Children.Add($row)
    }
    $box.Child = $stack
    [void]$ui.Cards.Children.Add($box)
  }
  if ($cards.Count -gt $MaxCards) {
    $more = New-Object Windows.Controls.Button
    $more.Content = "还有 $($cards.Count - $MaxCards) 件，去 Dot 窗口看"; $more.Style = $window.FindResource('Btn')
    $more.HorizontalAlignment = 'Left'; $more.Margin = '0,0,0,8'
    $more.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'dot' }) })
    [void]$ui.Cards.Children.Add($more)
  }
  $ui.Cards.Visibility = if ($cards.Count) { 'Visible' } else { 'Collapsed' }
}

# ── 鼠标：按下缩一下；拖动吸附；单击开关面板；双击直接打开 Dot ──
$script:downAt = $null
$ui.Pet.Add_MouseLeftButtonDown({
  param($s, $e)
  if ($e.ClickCount -ge 2) { Squash 1; Focus-Dsh ([pscustomobject]@{ nav = 'dot' }); return }
  $script:downAt = @{ X = $window.Left; Y = $window.Top }
  $script:hidden = $false
  $current = $window.Left
  $window.BeginAnimation([Windows.Window]::LeftProperty, $null)
  $window.Left = $current
  Squash 0.9
  try { $window.DragMove() } catch { }
  Squash 1
  $moved = [Math]::Abs($window.Left - $script:downAt.X) + [Math]::Abs($window.Top - $script:downAt.Y)
  if ($moved -gt 3) { Snap } elseif ($ui.Panel.IsOpen) { Close-Panel } else { Bounce; Open-Panel }
})

# ── 右键菜单 ──
$menu = New-Object Windows.Controls.ContextMenu
$miOpen = New-Object Windows.Controls.MenuItem; $miOpen.Header = '打开 Dot'; $miOpen.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'dot' }) })
$miSess = New-Object Windows.Controls.MenuItem; $miSess.Header = '会话总览'; $miSess.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'sessions' }) })
$miBrief = New-Object Windows.Controls.MenuItem; $miBrief.Header = '今日简报'; $miBrief.Add_Click({ Open-Panel; Say '/brief' })
$miPause = New-Object Windows.Controls.MenuItem; $miPause.Header = '暂停 Dot'; $miPause.Add_Click({ Say $(if ($script:paused) { '/resume' } else { '/pause' }) })
$miQuiet = New-Object Windows.Controls.MenuItem; $miQuiet.Header = '不显示气泡'; $miQuiet.IsCheckable = $true
$miExit = New-Object Windows.Controls.MenuItem; $miExit.Header = '关掉桌面精灵（DSH 重启后会再出现）'; $miExit.Add_Click({ $window.Close() })
foreach ($mi in @($miOpen, $miSess, $miBrief, (New-Object Windows.Controls.Separator), $miPause, $miQuiet, (New-Object Windows.Controls.Separator), $miExit)) { [void]$menu.Items.Add($mi) }
$ui.Pet.ContextMenu = $menu

# ── 表情 ──
$moods = @{
  busy    = @('#93C5FD', '#2563EB')
  waiting = @('#FCD34D', '#F59E0B')
  done    = @('#6EE7B7', '#10B981')
  alert   = @('#FDA4AF', '#E11D48')
  paused  = @('#C9CCD3', '#8A8F99')
}
$script:mood = 'idle'
$script:idleColors = @('#8AA2FF', '#4D6BFE')
function Get-EyeHeight { switch ($script:mood) { 'paused' { 3 } 'done' { 7 } default { 12 } } }
function Set-Eyes([double]$h, [double]$dx) {
  $ui.EyeL.Height = $h; $ui.EyeR.Height = $h
  [Windows.Controls.Canvas]::SetTop($ui.EyeL, 9 - $h / 2); [Windows.Controls.Canvas]::SetTop($ui.EyeR, 9 - $h / 2)
  [Windows.Controls.Canvas]::SetLeft($ui.EyeL, 4 + $dx); [Windows.Controls.Canvas]::SetLeft($ui.EyeR, 16 + $dx)
}
function Set-Mood([string]$mood) {
  $script:mood = $mood
  $c = if ($mood -eq 'idle') { $script:idleColors } else { $moods[$mood] }
  if (-not $c) { $c = $script:idleColors }
  $ui.Top.Color = [Windows.Media.ColorConverter]::ConvertFromString($c[0])
  $ui.Bottom.Color = [Windows.Media.ColorConverter]::ConvertFromString($c[1])
  if ($script:mood -ne 'busy') { $script:look = 0 }
  Set-Eyes (Get-EyeHeight) $script:look
}
# 眨眼：3~6 秒一次；忙碌时眼睛左右看
$rand = New-Object Random
$script:look = 0
$blink = New-Object Windows.Threading.DispatcherTimer
$blink.Interval = [TimeSpan]::FromSeconds(4)
$blinkBack = New-Object Windows.Threading.DispatcherTimer
$blinkBack.Interval = [TimeSpan]::FromMilliseconds(130)
$blinkBack.Add_Tick({ $blinkBack.Stop(); Set-Eyes (Get-EyeHeight) $script:look })
$blink.Add_Tick({
  $blink.Interval = [TimeSpan]::FromMilliseconds(3000 + $rand.Next(3000))
  if ($script:mood -eq 'paused') { return }
  Set-Eyes 2 $script:look
  $blinkBack.Start()
})
$glance = New-Object Windows.Threading.DispatcherTimer
$glance.Interval = [TimeSpan]::FromMilliseconds(650)
$glance.Add_Tick({
  if ($script:mood -ne 'busy' -and -not $script:awaiting) { return }
  $script:look = if ($script:look -le 0) { 2 } else { -2 }
  Set-Eyes (Get-EyeHeight) $script:look
})

# ── 读状态：异步，空闲 2 秒一次，等回复或面板开着时 1 秒一次 ──
$script:lastBubble = ''
$script:failures = 0
$script:paused = $false
$script:statusBusy = $false
$script:seenCards = $null
function Refresh {
  if ($script:statusBusy) { return }
  $script:statusBusy = $true
  Get-Dot $StatusUrl 'On-Status'
}
function On-Status($s, $state) {
  $script:statusBusy = $false
  if ($s.failed) {
    $script:failures++
    if ($script:failures -ge 3) { Set-Mood 'paused'; $ui.Badge.Visibility = 'Collapsed'; $ui.Pet.ToolTip = 'Dot：连不上 DSH' }
    return
  }
  $script:failures = 0
  $script:paused = [bool]$s.paused
  $miPause.Header = if ($script:paused) { '恢复 Dot' } else { '暂停 Dot' }
  $desk = $s.desk
  $script:desk = $desk
  if ($desk) {
    $script:idleColors = @([string]$desk.color[0], [string]$desk.color[1])
    $ui.NameText.Text = [string]$desk.name
    $ui.SummaryText.Text = [string]$desk.summary
    $ui.HintText.Text = [string]$desk.hint
    $ui.HintText.Visibility = if ($desk.hint) { 'Visible' } else { 'Collapsed' }
  }
  $ui.PauseBtn.Content = if ($script:paused) { '恢复' } else { '暂停' }
  $mood = [string]$s.mood
  Set-Mood $mood

  # Dot 的回复：发出之后来的那一段，直接显示在面板里
  if ($script:awaiting -and $desk) {
    $reply = $desk.reply
    if ($reply -and [double]$reply.at -gt $script:sentAt) {
      $ui.ReplyText.Text = [string]$reply.text
      if (-not $desk.dotBusy) { $script:awaiting = $false; $ui.ReplyHead.Text = [string]$desk.name }
      else { $ui.ReplyHead.Text = "$($desk.name) 还在说…" }
      if (-not $ui.Panel.IsOpen) { Flash "$($desk.name) 回复了，点我看" 6; Bounce }
    } elseif ((Now-Ms) - $script:sentAt -gt 180000) {
      $script:awaiting = $false
      $ui.ReplyHead.Text = "$($desk.name) 还没回"
      $ui.ReplyText.Text = '可能在干一件大活，去 DSH 里看看进度。'
    }
  }

  # 角标：有卡片就显示张数，颜色按最急的那张；没卡片时用表情符号
  $cards = if ($desk) { @($desk.cards) } else { @() }
  $keys = @($cards | ForEach-Object { [string]$_.key })
  if ($null -ne $script:seenCards) {
    $fresh = @($cards | Where-Object { $script:seenCards -notcontains [string]$_.key })
    if ($fresh.Count) { Shake; if (-not $ui.Panel.IsOpen -and -not $miQuiet.IsChecked) { Flash ([string]$fresh[0].title) 6 } }
  }
  $script:seenCards = $keys
  $kinds = @($cards | ForEach-Object { [string]$_.kind })
  $mark = switch ($mood) { 'waiting' { '!' } 'done' { [string][char]0x2713 } 'paused' { 'z' } default { '' } }
  if ($cards.Count -gt 0) {
    $ui.BadgeText.Text = [string]$cards.Count
    $color = if ($kinds -contains 'approval' -or $kinds -contains 'question') { '#FF9F0A' } elseif ($kinds -contains 'failed' -or $kinds -contains 'overdue') { '#FF453A' } else { '#4D6BFE' }
    $ui.Badge.Background = New-Brush $color
    $ui.Badge.Visibility = 'Visible'
  } elseif ($mark) {
    $ui.BadgeText.Text = $mark; $ui.Badge.Background = New-Brush '#4D6BFE'; $ui.Badge.Visibility = 'Visible'
  } else { $ui.Badge.Visibility = 'Collapsed' }

  # 气泡：临时反馈优先；其次是状态气泡
  if ((Get-Date) -lt $script:flashUntil) {
    # 保持临时气泡
  } else {
    $text = [string]$s.bubble
    if ($text -and -not $miQuiet.IsChecked -and $mood -ne 'idle' -and -not $ui.Panel.IsOpen) {
      $ui.BubbleText.Text = $text
      if ($text -ne $script:lastBubble) { Set-Hidden $false }
      $ui.Bubble.Visibility = 'Visible'
    } else {
      $ui.Bubble.Visibility = 'Collapsed'
    }
    $script:lastBubble = $text
  }
  $name = if ($desk) { [string]$desk.name } else { 'Dot' }
  $ui.Pet.ToolTip = if ($s.bubble) { "${name}：$($s.bubble)" } else { "${name}：一切安静。单击打开面板，双击打开 Dot，拖到屏幕边缘会藏起来，Alt+Shift+D 随时叫出" }
  if ($ui.Panel.IsOpen) { Render-Cards $false }
}

$poll = New-Object Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromSeconds(2)
$script:tick = 0
$poll.Add_Tick({
  # 父进程（DSH 运行时）没了就退出
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $window.Close(); return }
  Refresh
})
# 等回复、面板开着时多看一眼（每秒），其余时候 2 秒一次
$fast = New-Object Windows.Threading.DispatcherTimer
$fast.Interval = [TimeSpan]::FromSeconds(1)
$fast.Add_Tick({ if ($script:awaiting -or $ui.Panel.IsOpen) { Refresh } })

# ── 全局快捷键 Alt+Shift+D：开关面板（被别的程序占用时注册失败，其余功能照常）──
$HotkeyId = 0xD07
$script:hotkey = $false
$window.Add_SourceInitialized({
  Restore-Position; Update-Layout
  try {
    $script:hwnd = (New-Object Windows.Interop.WindowInteropHelper($window)).Handle
    # MOD_ALT=1 | MOD_SHIFT=4 | MOD_NOREPEAT=0x4000；VK_D=0x44
    $script:hotkey = [DotPet.Native]::RegisterHotKey($script:hwnd, $HotkeyId, 0x4005, 0x44)
    $src = [Windows.Interop.HwndSource]::FromHwnd($script:hwnd)
    $src.AddHook([Windows.Interop.HwndSourceHook] {
      param([IntPtr]$h, [int]$msg, [IntPtr]$w, [IntPtr]$l, [ref]$handled)
      if ($msg -eq 0x0312 -and $w.ToInt32() -eq $HotkeyId) {
        try { if ($ui.Panel.IsOpen) { Close-Panel } else { Open-Panel } } catch { Write-PetLog "hotkey failed: $_" }
        $handled.Value = $true
      }
      return [IntPtr]::Zero
    })
    Write-PetLog "hotkey registered=$($script:hotkey) dshMain=$DshMainPid"
  } catch { $script:hotkey = $false; Write-PetLog "hotkey setup failed: $_" }
})
$window.Add_ContentRendered({
  Refresh
  if ($FirstRun) { Flash '我在这儿。单击打开面板，双击打开 Dot，拖到屏幕边上会藏起来' 8; Bounce }
  elseif ($script:edge -ne 'none') { $hideTimer.Start() }
})
$window.Add_Closed({
  $poll.Stop(); $fast.Stop(); $pump.Stop(); $blink.Stop(); $glance.Stop()
  if ($script:hotkey) { [void][DotPet.Native]::UnregisterHotKey($script:hwnd, $HotkeyId) }
  try { $mutex.ReleaseMutex() } catch { }
  [Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
})
$pump.Start(); $poll.Start(); $fast.Start(); $blink.Start(); $glance.Start()
[void]$window.Show()
[Windows.Threading.Dispatcher]::Run()
