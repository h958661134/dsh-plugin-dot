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

  /** 系统输入：最后一次输入时间（算工作时长用，不需要钩子）、全屏 / 演示检测。 */
  public static class Input {
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    public static uint LastInputTick() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return i.dwTime; }
    public static uint IdleMs() { unchecked { return (uint)Environment.TickCount - LastInputTick(); } }
    /** 全屏应用、演示模式、系统忙：2 忙碌，3 全屏 D3D，4 演示 */
    public static bool Quiet() {
      int s = 0;
      try { if (SHQueryUserNotificationState(out s) != 0) return false; } catch { return false; }
      return s == 2 || s == 3 || s == 4;
    }
  }

  /**
   * 按键计数：低级键盘钩子，回调里只把次数 +1，不读键值、不看是哪个程序。
   * 只在用户打开「数按键」时安装，关掉立即卸载。
   */
  public static class KeyCounter {
    delegate IntPtr Proc(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Proc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    static IntPtr hook = IntPtr.Zero;
    static Proc proc;
    static long count;
    public static long Count { get { return System.Threading.Interlocked.Read(ref count); } }
    public static bool On { get { return hook != IntPtr.Zero; } }
    static IntPtr Cb(int code, IntPtr w, IntPtr l) {
      if (code >= 0) {
        long m = w.ToInt64();
        if (m == 0x100 || m == 0x104) System.Threading.Interlocked.Increment(ref count); // WM_KEYDOWN / WM_SYSKEYDOWN
      }
      return CallNextHookEx(hook, code, w, l);
    }
    public static bool Start() {
      if (hook != IntPtr.Zero) return true;
      proc = Cb;
      hook = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0); // WH_KEYBOARD_LL
      return hook != IntPtr.Zero;
    }
    public static void Stop() { if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; } }
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
$StageW = 96           # 精灵所在的舞台：留出跳跃、装扮、粒子的空间
$StageH = 132
$PadX = ($StageW - $PetSize) / 2
$Peek = 22             # 半隐藏时露出的宽度
$SnapDistance = 28     # 离屏幕边缘多近就吸附
$Margin = 8
$WinW = 360            # 窗口固定大小：透明部分点击会穿透，不挡桌面
$WinH = $StageH
$WalkRange = 240       # 在任务栏上溜达，离「家」最远多少
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
  <Grid x:Name="Root" HorizontalAlignment="Right" VerticalAlignment="Bottom" Background="Transparent" AllowDrop="True">
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width="Auto"/>
      <ColumnDefinition Width="Auto"/>
    </Grid.ColumnDefinitions>
    <Border x:Name="Bubble" Grid.Column="0" Visibility="Collapsed" Margin="0,0,0,50" Cursor="Hand"
            VerticalAlignment="Bottom" MaxWidth="240" CornerRadius="10" Padding="10,6"
            Background="#F7FFFFFF" BorderBrush="#22000000" BorderThickness="1">
      <Border.Effect><DropShadowEffect BlurRadius="10" ShadowDepth="1" Opacity="0.18"/></Border.Effect>
      <TextBlock x:Name="BubbleText" TextWrapping="Wrap" FontSize="12.5" Foreground="#1F2937"/>
    </Border>
    <Grid x:Name="Stage" Grid.Column="1" Width="$StageW" Height="$StageH" Background="Transparent">
      <Ellipse x:Name="Shadow" Width="40" Height="7" Fill="#2A000000" VerticalAlignment="Bottom" HorizontalAlignment="Center" Margin="0,0,0,3" IsHitTestVisible="False"/>
      <Grid x:Name="RingBox" Width="76" Height="76" VerticalAlignment="Bottom" HorizontalAlignment="Center" Margin="0,0,0,1" IsHitTestVisible="False" Visibility="Collapsed">
        <Ellipse Stroke="#221D9E75" StrokeThickness="3"/>
        <Path x:Name="Ring" Stroke="#1D9E75" StrokeThickness="3" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
      </Grid>
      <Grid x:Name="Pet" Width="$PetSize" Height="66" VerticalAlignment="Bottom" HorizontalAlignment="Center" Margin="0,0,0,6" Cursor="Hand" Background="Transparent" RenderTransformOrigin="0.5,1">
        <Grid.RenderTransform>
          <TransformGroup>
            <ScaleTransform x:Name="PetFlip" ScaleX="1" ScaleY="1"/>
            <ScaleTransform x:Name="PetScale" ScaleX="1" ScaleY="1"/>
            <ScaleTransform x:Name="PetBreath" ScaleX="1" ScaleY="1"/>
            <RotateTransform x:Name="PetRot" Angle="0"/>
            <TranslateTransform x:Name="PetHop" Y="0"/>
            <TranslateTransform x:Name="PetBob" Y="0"/>
          </TransformGroup>
        </Grid.RenderTransform>
        <Canvas Width="56" Height="66">
          <Ellipse x:Name="FootL" Canvas.Left="12" Canvas.Top="54" Width="13" Height="8" Fill="#3A4A8C"/>
          <Ellipse x:Name="FootR" Canvas.Left="31" Canvas.Top="54" Width="13" Height="8" Fill="#3A4A8C"/>
          <Path x:Name="Ahoge" Data="M28,12 C27,5 31,1 35,3" Stroke="#4D6BFE" StrokeThickness="2.4" StrokeStartLineCap="Round" StrokeEndLineCap="Round">
            <Path.RenderTransform><RotateTransform x:Name="AhogeRot" CenterX="28" CenterY="12" Angle="0"/></Path.RenderTransform>
          </Path>
          <Border x:Name="Body" Canvas.Left="4" Canvas.Top="10" Width="48" Height="46" CornerRadius="17">
            <Border.Background>
              <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
                <GradientStop x:Name="Top" Color="#8AA2FF" Offset="0"/>
                <GradientStop x:Name="Bottom" Color="#4D6BFE" Offset="1"/>
              </LinearGradientBrush>
            </Border.Background>
            <Border.Effect><DropShadowEffect BlurRadius="8" ShadowDepth="1.5" Opacity="0.25"/></Border.Effect>
          </Border>
          <Ellipse x:Name="Shine" Canvas.Left="11" Canvas.Top="15" Width="10" Height="6" Fill="#55FFFFFF"/>
          <Ellipse x:Name="CheekL" Canvas.Left="9" Canvas.Top="35" Width="9" Height="5" Fill="#88FF7FA8" Visibility="Collapsed"/>
          <Ellipse x:Name="CheekR" Canvas.Left="38" Canvas.Top="35" Width="9" Height="5" Fill="#88FF7FA8" Visibility="Collapsed"/>
          <Rectangle x:Name="EyeL" Canvas.Left="17" Canvas.Top="22" Width="6" Height="12" RadiusX="3" RadiusY="3" Fill="White"/>
          <Rectangle x:Name="EyeR" Canvas.Left="33" Canvas.Top="22" Width="6" Height="12" RadiusX="3" RadiusY="3" Fill="White"/>
          <Path x:Name="EyeLX" Canvas.Left="16" Canvas.Top="25" Data="M0,6 L4,1 L8,6" Stroke="White" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" Visibility="Collapsed"/>
          <Path x:Name="EyeRX" Canvas.Left="32" Canvas.Top="25" Data="M0,6 L4,1 L8,6" Stroke="White" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" Visibility="Collapsed"/>
          <Path x:Name="EyeLO" Canvas.Left="16" Canvas.Top="24" Data="M0.5,4 A3.5,3.5 0 1 1 7.5,4 A3.5,3.5 0 1 1 0.5,4 M2.8,4 A1.2,1.2 0 1 1 5.2,4" Stroke="White" StrokeThickness="1.4" Visibility="Collapsed"/>
          <Path x:Name="EyeRO" Canvas.Left="32" Canvas.Top="24" Data="M0.5,4 A3.5,3.5 0 1 1 7.5,4 A3.5,3.5 0 1 1 0.5,4 M2.8,4 A1.2,1.2 0 1 1 5.2,4" Stroke="White" StrokeThickness="1.4" Visibility="Collapsed"/>
          <Path x:Name="Mouth" Canvas.Left="23" Canvas.Top="37" Stroke="White" StrokeThickness="1.8" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/>
          <Path x:Name="Sweat" Canvas.Left="45" Canvas.Top="12" Data="M3,0 Q6,5 6,7 A3,3 0 1 1 0,7 Q0,5 3,0 Z" Fill="#B5DCFF" Stroke="#7FB8F0" StrokeThickness="0.8" Visibility="Collapsed"/>
          <Canvas x:Name="OScarf" Visibility="Collapsed">
            <Path Data="M6,44 Q28,52 50,44 L50,49 Q28,57 6,49 Z" Fill="#EF5B5B"/>
            <Path Data="M36,48 L41,60 L35,59 L32,50 Z" Fill="#D94848"/>
          </Canvas>
          <Canvas x:Name="OLeaf" Visibility="Collapsed">
            <Path Data="M28,11 Q22,0 31,-3 Q36,5 28,11 Z" Fill="#4CC38A" Stroke="#2E9E68" StrokeThickness="0.8"/>
            <Path Data="M28,11 Q29,3 31,-2" Stroke="#2E9E68" StrokeThickness="0.8"/>
          </Canvas>
          <Canvas x:Name="OCap" Visibility="Collapsed">
            <Path Data="M9,18 Q10,4 28,4 Q46,4 47,18 Z" Fill="#2F3A56"/>
            <Path Data="M28,18 L56,18 Q56,22 50,22 L28,21 Z" Fill="#2F3A56"/>
            <Ellipse Canvas.Left="25" Canvas.Top="2" Width="6" Height="4" Fill="#F5A524"/>
          </Canvas>
          <Canvas x:Name="OHeadphones" Visibility="Collapsed">
            <Path Data="M5,30 Q5,4 28,4 Q51,4 51,30" Stroke="#374151" StrokeThickness="3.2"/>
            <Rectangle Canvas.Left="0" Canvas.Top="24" Width="9" Height="14" RadiusX="4" RadiusY="4" Fill="#F5A524"/>
            <Rectangle Canvas.Left="47" Canvas.Top="24" Width="9" Height="14" RadiusX="4" RadiusY="4" Fill="#F5A524"/>
          </Canvas>
          <Canvas x:Name="OBow" Visibility="Collapsed">
            <Path Data="M40,12 L32,6 L33,17 Z M40,12 L48,6 L47,17 Z" Fill="#FF7FA8" Stroke="#E85C8C" StrokeThickness="0.8"/>
            <Ellipse Canvas.Left="37.5" Canvas.Top="9.5" Width="5" Height="5" Fill="#E85C8C"/>
          </Canvas>
          <Canvas x:Name="OCrown" Visibility="Collapsed">
            <Path Data="M17,13 L19,2 L24,8 L28,0 L32,8 L37,2 L39,13 Z" Fill="#FFC83D" Stroke="#E0A20F" StrokeThickness="0.8" StrokeLineJoin="Round"/>
            <Ellipse Canvas.Left="26.5" Canvas.Top="7" Width="3" Height="3" Fill="#EF5B5B"/>
          </Canvas>
          <Border x:Name="Keyboard" Canvas.Left="8" Canvas.Top="57" Width="40" Height="8" CornerRadius="2" Background="#E5E7EB" BorderBrush="#9CA3AF" BorderThickness="0.8" Visibility="Collapsed"/>
        </Canvas>
        <Border x:Name="Carry" Visibility="Collapsed" HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,-6,-18,0"
                MinWidth="22" Height="20" CornerRadius="4" Background="#F5A524" Padding="5,0" BorderBrush="White" BorderThickness="1.5">
          <Border.RenderTransform><RotateTransform x:Name="CarryRot" Angle="8" CenterX="11" CenterY="10"/></Border.RenderTransform>
          <TextBlock x:Name="CarryText" FontSize="11" FontWeight="Bold" Foreground="White" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
      </Grid>
      <Canvas x:Name="Fx" IsHitTestVisible="False"/>
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
          <TextBlock x:Name="StatsText" Margin="0,2,0,0" FontSize="11.5" Foreground="#9CA3AF" TextWrapping="Wrap" Cursor="Hand" ToolTip="点开看今天按小时的统计"/>
          <Border x:Name="StatsBox" Visibility="Collapsed" Margin="0,8,0,0" CornerRadius="10" Padding="10,8" Background="#F8FAFC" BorderBrush="#E5E7EB" BorderThickness="1">
            <StackPanel>
              <DockPanel>
                <Button x:Name="KeysBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Margin="0" Padding="7,1" FontSize="11"/>
                <TextBlock Text="今天" FontSize="12" FontWeight="SemiBold" Foreground="#374151" VerticalAlignment="Center"/>
              </DockPanel>
              <Canvas x:Name="StatsBars" Height="46" Margin="0,8,0,0"/>
              <Grid Margin="0,2,0,0">
                <TextBlock Text="0" FontSize="10" Foreground="#9CA3AF" HorizontalAlignment="Left"/>
                <TextBlock Text="12" FontSize="10" Foreground="#9CA3AF" HorizontalAlignment="Center"/>
                <TextBlock Text="24 时" FontSize="10" Foreground="#9CA3AF" HorizontalAlignment="Right"/>
              </Grid>
              <TextBlock x:Name="StatsNote" Margin="0,6,0,0" FontSize="11" Foreground="#6B7280" TextWrapping="Wrap"/>
            </StackPanel>
          </Border>
          <DockPanel x:Name="FocusRow" Visibility="Collapsed" Margin="0,8,0,0">
            <Button x:Name="FocusStopBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Margin="6,0,0,0" Padding="8,1" FontSize="11.5" Content="停止"/>
            <TextBlock x:Name="FocusText" FontSize="12" Foreground="#0F6E56" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
          </DockPanel>
          <TextBlock x:Name="HintText" Margin="0,4,0,0" FontSize="11" Foreground="#9CA3AF" TextWrapping="Wrap" Visibility="Collapsed"/>
          <StackPanel x:Name="Cards" Margin="0,8,0,0"/>
          <StackPanel x:Name="TodoBox" Margin="0,0,0,10">
            <DockPanel>
              <Button x:Name="TodoAllBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Background="Transparent" Margin="0" Padding="4,0" FontSize="11.5" Foreground="#6B7280" Content="全部待办 ›" ToolTip="把 DSH 拉到前台，打开 Dot 窗口看全部待办"/>
              <TextBlock x:Name="TodoHead" Text="今天" FontSize="12" FontWeight="SemiBold" Foreground="#6B7280" VerticalAlignment="Center"/>
            </DockPanel>
            <StackPanel x:Name="TodoList" Margin="0,2,0,0"/>
            <Border CornerRadius="8" Background="#F6F7F9" Padding="8,4" Margin="0,4,0,0">
              <Grid>
                <TextBlock x:Name="TodoPh" Text="＋ 记一件（明天9点 交周报 / 每周一9点 周会）" Foreground="#9CA3AF" FontSize="12" IsHitTestVisible="False" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
                <TextBox x:Name="TodoInput" BorderThickness="0" Background="Transparent" FontSize="12" VerticalContentAlignment="Center" ToolTip="回车记下。没写时间的放进今天；用「；」分出小步骤"/>
              </Grid>
            </Border>
          </StackPanel>
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
                <TextBlock x:Name="Placeholder" Text="跟 Dot 说一句，让它去办…" Foreground="#9CA3AF" FontSize="12.5" IsHitTestVisible="False" VerticalAlignment="Center"/>
                <TextBox x:Name="Input" BorderThickness="0" Background="Transparent" FontSize="12.5" VerticalContentAlignment="Center"/>
              </Grid>
            </Border>
          </DockPanel>
          <DockPanel x:Name="OutRow" Margin="0,6,0,0" Visibility="Collapsed">
            <Button x:Name="UndoBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Margin="6,0,0,0" Padding="8,1" FontSize="11.5" Content="撤销" Visibility="Collapsed" VerticalAlignment="Top"/>
            <TextBlock x:Name="OutText" FontSize="12" TextWrapping="Wrap" VerticalAlignment="Center"/>
          </DockPanel>
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
foreach ($n in 'Root', 'Stage', 'Pet', 'PetFlip', 'PetScale', 'PetBreath', 'PetRot', 'PetHop', 'PetBob', 'Bubble', 'BubbleText', 'EyeL', 'EyeR', 'EyeLX', 'EyeRX', 'EyeLO', 'EyeRO',
  'Mouth', 'CheekL', 'CheekR', 'Sweat', 'Shine', 'FootL', 'FootR', 'Ahoge', 'AhogeRot', 'Body', 'Shadow', 'RingBox', 'Ring', 'Carry', 'CarryRot', 'CarryText', 'Fx', 'Keyboard',
  'OScarf', 'OLeaf', 'OCap', 'OHeadphones', 'OBow', 'OCrown', 'StatsText', 'StatsBox', 'KeysBtn', 'StatsBars', 'StatsNote', 'FocusRow', 'FocusStopBtn', 'FocusText',
  'Top', 'Bottom', 'Panel', 'CloseBtn', 'PauseBtn',
  'NameText', 'SummaryText', 'HintText', 'Cards', 'ReplyBox', 'ReplyHead', 'ReplyText', 'ReplyOpenBtn', 'Quick', 'SendBtn', 'Placeholder', 'Input', 'OutText', 'DotBtn', 'SessBtn',
  'TodoBox', 'TodoHead', 'TodoList', 'TodoAllBtn', 'TodoPh', 'TodoInput', 'OutRow', 'UndoBtn') {
  $ui[$n] = $window.FindName($n)
}
function New-Brush([string]$hex) { New-Object Windows.Media.SolidColorBrush ([Windows.Media.ColorConverter]::ConvertFromString($hex)) }
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# ── 异步请求：发出去就返回，结果由 40ms 一次的定时器取回，交给指定的处理函数（按名字调用）──
$script:pending = New-Object System.Collections.ArrayList
# 精灵只会调这几个写接口（和网页小精灵一样），卡片里给别的路径一律不执行
$AllowedPosts = @('/task', '/notice', '/say', '/focus', '/pet')
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

# ── 位置：默认住在任务栏上（ground）；拖到左 / 右边缘就贴边（可半隐藏）──
$script:edge = 'ground'   # ground / left / right
$script:hidden = $false
$script:side = 'left'     # 气泡在精灵的哪一边
$script:homeX = $null     # 在任务栏上的「家」（舞台中心的屏幕横坐标），溜达不离开它太远
$script:scale = 1.0
function Get-WorkArea([double]$x, [double]$y) {
  $src = [Windows.PresentationSource]::FromVisual($window)
  $scale = if ($src) { $src.CompositionTarget.TransformToDevice.M11 } else { 1.0 }
  $script:scale = $scale
  $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point([int]($x * $scale), [int]($y * $scale))))
  $wa = $screen.WorkingArea
  return @{ Left = $wa.Left / $scale; Top = $wa.Top / $scale; Right = $wa.Right / $scale; Bottom = $wa.Bottom / $scale }
}
# 舞台（精灵那一列）在屏幕上的左边；窗口里另一列是气泡
function Stage-Left { if ($script:side -eq 'right') { $window.Left } else { $window.Left + $WinW - $StageW } }
function Stage-Center { (Stage-Left) + $StageW / 2 }
function Set-StageLeft([double]$x) {
  $window.BeginAnimation([Windows.Window]::LeftProperty, $null)
  $window.Left = if ($script:side -eq 'right') { $x } else { $x - ($WinW - $StageW) }
}
function Here-Area { Get-WorkArea (Stage-Center) ($window.Top + $WinH / 2) }
function Ground-Top { (Here-Area).Bottom - $WinH }
# 气泡换边：精灵在屏幕上的位置不变
function Set-Side([string]$side) {
  if ($script:side -eq $side) { return }
  $sl = Stage-Left
  $script:side = $side
  if ($side -eq 'right') {
    [Windows.Controls.Grid]::SetColumn($ui.Bubble, 1); [Windows.Controls.Grid]::SetColumn($ui.Stage, 0)
    $ui.Bubble.Margin = '4,0,0,50'; $ui.Root.HorizontalAlignment = 'Left'
    $ui.Panel.HorizontalOffset = -10
  } else {
    [Windows.Controls.Grid]::SetColumn($ui.Bubble, 0); [Windows.Controls.Grid]::SetColumn($ui.Stage, 1)
    $ui.Bubble.Margin = '0,0,4,50'; $ui.Root.HorizontalAlignment = 'Right'
    $ui.Panel.HorizontalOffset = $PetSize - $PanelW - 10
  }
  Set-StageLeft $sl
}
# 贴左边、或者在任务栏上离左边太近时，气泡放右边；其余放左边
function Update-Layout {
  if ($script:edge -eq 'left') { Set-Side 'right'; return }
  if ($script:edge -eq 'right') { Set-Side 'left'; return }
  $a = Here-Area
  Set-Side $(if ((Stage-Left) - $a.Left -lt 250) { 'right' } else { 'left' })
}
function Save-Position {
  try {
    $data = @{ left = (Stage-Left); top = $window.Top; edge = $script:edge; home = $script:homeX; v = 2 } | ConvertTo-Json -Compress
    $dir = Split-Path -Parent $StateFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    [IO.File]::WriteAllText($StateFile, $data, (New-Object Text.UTF8Encoding($false)))
  } catch { }
}
function Restore-Position {
  $ui.Panel.HorizontalOffset = $PetSize - $PanelW - 10
  $wa = [Windows.SystemParameters]::WorkArea
  $sl = $wa.Right - $StageW - 60
  $top = $wa.Bottom - $WinH
  $edge = 'ground'
  try {
    if (Test-Path -LiteralPath $StateFile) {
      $s = [IO.File]::ReadAllText($StateFile) | ConvertFrom-Json
      # 旧版存的是窗口左边（窗口 320 宽、精灵在右边），换算成舞台左边
      $left = if ($s.v -eq 2) { [double]$s.left } else { [double]$s.left + 320 - 56 - $PadX }
      $area = Get-WorkArea $left ([double]$s.top)
      if ($left -ge $area.Left - $StageW -and $left -le $area.Right -and $s.top -ge $area.Top - $WinH -and $s.top -le $area.Bottom) {
        $sl = $left; $top = [double]$s.top
        if ($s.edge -eq 'left' -or $s.edge -eq 'right') { $edge = [string]$s.edge }
        if ($null -ne $s.home) { $script:homeX = [double]$s.home }
      }
    }
  } catch { }
  $script:edge = $edge
  $window.Top = $top
  Set-StageLeft $sl
  Update-Layout
  if ($edge -eq 'ground') { $window.Top = Ground-Top }
  if ($null -eq $script:homeX) { $script:homeX = Stage-Center }
}

# ── 动画 ──
function New-Anim([double]$from, [double]$to, [int]$ms) {
  $a = New-Object Windows.Media.Animation.DoubleAnimation
  $a.From = $from; $a.To = $to
  $a.Duration = New-Object Windows.Duration ([TimeSpan]::FromMilliseconds($ms))
  $a.EasingFunction = New-Object Windows.Media.Animation.QuadraticEase
  return $a
}
function New-Keys($frames, [bool]$ease = $true) {
  $a = New-Object Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  foreach ($kf in $frames) {
    $kt = [Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($kf[0]))
    if ($ease) { [void]$a.KeyFrames.Add((New-Object Windows.Media.Animation.EasingDoubleKeyFrame($kf[1], $kt))) }
    else { [void]$a.KeyFrames.Add((New-Object Windows.Media.Animation.LinearDoubleKeyFrame($kf[1], $kt))) }
  }
  return $a
}
# 滑到舞台左边 = $x：先把位置定好，再从旧位置播 180ms 动画过去
function Move-StageTo([double]$x) {
  $from = $window.Left
  Set-StageLeft $x
  $to = $window.Left
  if ([Math]::Abs($from - $to) -lt 1) { return }
  $anim = New-Anim $from $to 180
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
  $a = New-Keys @(@(0, 1.0), @(110, 1.14), @(220, 0.94), @(320, 1.0))
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $a)
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $a)
}
# 落地：压扁再弹回
function Land-Squish {
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, (New-Keys @(@(0, 0.78), @(140, 1.08), @(260, 1.0))))
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, (New-Keys @(@(0, 1.2), @(140, 0.95), @(260, 1.0))))
}
# 伸懒腰：拉长、再缩回
function Stretch {
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, (New-Keys @(@(0, 1.0), @(380, 1.16), @(700, 1.16), @(900, 0.94), @(1050, 1.0))))
  $ui.PetScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, (New-Keys @(@(0, 1.0), @(380, 0.9), @(700, 0.9), @(900, 1.06), @(1050, 1.0))))
  Emote 'line' 'open' $false 1000
}
# 跳一下
function Hop([double]$h = 12, [int]$ms = 360) {
  $ui.PetHop.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, (New-Keys @(@(0, 0), @([int]($ms * 0.45), -$h), @($ms, 0))))
}
# 有新的「需要你」：摇一摇
function Shake {
  $ui.PetRot.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, (New-Keys @(@(0, 0), @(70, -12), @(140, 10), @(210, -8), @(280, 6), @(350, -3), @(420, 0)) $false))
}
# 轻轻扭一扭（被摸、无聊时）
function Wiggle {
  $ui.PetRot.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, (New-Keys @(@(0, 0), @(120, 6), @(240, -6), @(360, 4), @(480, 0))))
}

# ── 贴边与半隐藏 ──
function Snap-Edge([string]$edge) {
  $script:edge = $edge
  Update-Layout
  $a = Here-Area
  $target = if ($edge -eq 'left') { $a.Left - $PadX } else { $a.Right - $PetSize - $PadX }
  if ($window.Top -lt $a.Top - 40) { $window.Top = $a.Top - 40 }
  if ($window.Top + $WinH -gt $a.Bottom) { $window.Top = $a.Bottom - $WinH }
  Move-StageTo $target
  Save-Position
}
function Set-Hidden([bool]$hide) {
  if (($script:edge -ne 'left' -and $script:edge -ne 'right') -or $script:hidden -eq $hide) { return }
  if ($hide -and ($ui.Bubble.Visibility -eq 'Visible' -or $ui.Panel.IsOpen)) { return } # 有话要说、面板开着时不藏
  $a = Here-Area
  $script:hidden = $hide
  if ($script:edge -eq 'right') {
    $to = if ($hide) { $a.Right - $Peek - $PadX } else { $a.Right - $PetSize - $PadX }
  } else {
    $to = if ($hide) { $a.Left + $Peek - $PetSize - $PadX } else { $a.Left - $PadX }
  }
  Move-StageTo $to
}
$hideTimer = New-Object Windows.Threading.DispatcherTimer
$hideTimer.Interval = [TimeSpan]::FromSeconds(2.5)
$hideTimer.Add_Tick({ $hideTimer.Stop(); if (-not $ui.Root.IsMouseOver) { Set-Hidden $true } })
$ui.Root.Add_MouseEnter({ $hideTimer.Stop(); Set-Hidden $false })
$ui.Root.Add_MouseLeave({ if ($script:edge -ne 'ground') { $hideTimer.Stop(); $hideTimer.Start() } })

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
# 一行回执；能撤销的操作（完成、推迟）旁边带「撤销」
function Show-Out([string]$text, [bool]$isErr, $undo = $null) {
  if (-not $text) { $ui.OutRow.Visibility = 'Collapsed'; $ui.UndoBtn.Tag = $null; return }
  $ui.OutText.Text = $text
  $ui.OutText.Foreground = New-Brush $(if ($isErr) { '#DC2626' } else { '#374151' })
  $ui.UndoBtn.Tag = $undo
  $ui.UndoBtn.Visibility = if ($undo -and $undo.post) { 'Visible' } else { 'Collapsed' }
  $ui.OutRow.Visibility = 'Visible'
}
$ui.UndoBtn.Add_Click({
  $u = $ui.UndoBtn.Tag
  if (-not $u -or -not $u.post) { return }
  $ui.UndoBtn.Visibility = 'Collapsed'
  Send-Dot ([string]$u.post) $u.body 'On-OpDone' $null
})
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
$ui.Panel.Add_Closed({ if ($script:edge -ne 'ground' -and -not $ui.Root.IsMouseOver) { $hideTimer.Start() } })
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
  if ($r.text) { Show-Out ([string]$r.text) ($r.ok -eq $false) $r.undo }
  if ($r.ok -eq $false -and $box) { $box.Opacity = 1; $box.IsEnabled = $true }
  $script:forceCards = $true
  Refresh
}

# ── 今天的待办：勾掉、推到明天、一句话记一件（不调模型）──
$script:todosKey = ''
function Render-Todos([bool]$force) {
  $desk = $script:desk
  if (-not $desk) { return }
  $todos = @($desk.todos)
  $more = [int]$desk.todoMore
  $inbox = [int]$desk.inbox
  $key = (($todos | ForEach-Object { "$($_.id)|$($_.title)|$($_.sub)" }) -join "`n") + "|$more|$inbox"
  if (-not $force -and -not $script:forceCards -and $key -eq $script:todosKey) { return }
  if (-not $force -and $ui.TodoList.IsMouseOver) { return }
  $script:todosKey = $key
  $ui.TodoHead.Text = if ($todos.Count -or $more) { "今天 · $($todos.Count + $more) 件" + $(if ($inbox) { "　收件箱 $inbox" } else { '' }) } else { '今天' + $(if ($inbox) { " · 收件箱还有 $inbox 件没定时间" } else { '' }) }
  $ui.TodoList.Children.Clear()
  foreach ($t in $todos) {
    $row = New-Object Windows.Controls.DockPanel
    $row.Margin = '0,3,0,0'; $row.Background = New-Brush '#00FFFFFF'
    # 提醒我 / 改时间（悬停时显示）：点开一个小菜单，一下选好
    $later = New-Object Windows.Controls.Button
    $later.Content = [string][char]0x23F0; $later.Style = $window.FindResource('Btn'); $later.Background = New-Brush '#00FFFFFF'
    $later.Margin = '4,0,0,0'; $later.Padding = '4,0'; $later.Foreground = New-Brush '#9CA3AF'; $later.Opacity = 0
    $later.ToolTip = if ($t.sub) { '改时间' } else { '提醒我' }
    $menu = New-Object Windows.Controls.ContextMenu
    foreach ($p in @(@('30m', '半小时后'), @('1h', '1 小时后'), @('offwork', '下班前'), @('tonight', '今晚 8 点'), @('tomorrow', '明早 9 点'), @('weekend', '周末'))) {
      $mi = New-Object Windows.Controls.MenuItem
      $mi.Header = $p[1]
      $mi.Tag = @{ op = @{ post = '/task'; body = @{ id = [string]$t.id; action = 'snooze'; to = $p[0] } }; box = $row }
      $mi.Add_Click({ param($sender, $e) Run-Op $sender.Tag })
      [void]$menu.Items.Add($mi)
    }
    $later.ContextMenu = $menu
    $later.Add_Click({ param($sender, $e) $sender.ContextMenu.PlacementTarget = $sender; $sender.ContextMenu.IsOpen = $true })
    [Windows.Controls.DockPanel]::SetDock($later, 'Right')
    [void]$row.Children.Add($later)
    # 专注：我戴上耳机陪你 25 分钟
    $fb = New-Object Windows.Controls.Button
    $fb.Content = [string][char]::ConvertFromUtf32(0x1F3A7); $fb.Style = $window.FindResource('Btn'); $fb.Background = New-Brush '#00FFFFFF'
    $fb.Margin = '4,0,0,0'; $fb.Padding = '4,0'; $fb.Foreground = New-Brush '#9CA3AF'; $fb.Opacity = 0; $fb.ToolTip = '陪我专注 25 分钟'
    $fb.Tag = [string]$t.id
    $fb.Add_Click({ param($sender, $e) Send-Dot '/pet' @{ action = 'focus'; id = [string]$sender.Tag } 'On-OpDone' $null })
    [Windows.Controls.DockPanel]::SetDock($fb, 'Right')
    [void]$row.Children.Add($fb)
    $row.Tag = @($later, $fb)
    $row.Add_MouseEnter({ param($sender, $e) foreach ($x in $sender.Tag) { $x.Opacity = 1 } })
    $row.Add_MouseLeave({ param($sender, $e) foreach ($x in $sender.Tag) { $x.Opacity = 0 } })
    # 圆圈：点了就划掉
    $check = New-Object Windows.Controls.Button
    $check.Style = $window.FindResource('Btn'); $check.Background = New-Brush '#00FFFFFF'; $check.Padding = '0'; $check.Margin = '0,1,8,0'
    $check.VerticalAlignment = 'Top'; $check.ToolTip = '完成（可撤销）'
    $ring = New-Object Windows.Controls.Border
    $ring.Width = 15; $ring.Height = 15; $ring.CornerRadius = 8; $ring.BorderThickness = 1.6
    $ring.BorderBrush = New-Brush $(if ($t.overdue) { '#EF4444' } elseif ($t.high) { '#F59E0B' } else { '#9CA3AF' })
    $check.Content = $ring
    [Windows.Controls.DockPanel]::SetDock($check, 'Left')
    [void]$row.Children.Add($check)
    $text = New-Object Windows.Controls.StackPanel
    $title = New-Object Windows.Controls.TextBlock
    $title.Text = [string]$t.title; $title.FontSize = 12.5; $title.TextTrimming = 'CharacterEllipsis'; $title.ToolTip = [string]$t.title
    $title.Foreground = New-Brush $(if ($t.high) { '#B45309' } else { '#111827' })
    [void]$text.Children.Add($title)
    if ($t.sub) {
      $sub = New-Object Windows.Controls.TextBlock
      $sub.Text = [string]$t.sub; $sub.FontSize = 11; $sub.Foreground = New-Brush $(if ($t.overdue) { '#DC2626' } else { '#9CA3AF' })
      [void]$text.Children.Add($sub)
    }
    [void]$row.Children.Add($text)
    $check.Tag = @{ id = [string]$t.id; ring = $ring; title = $title; row = $row }
    $check.Add_Click({ param($sender, $e) Check-Todo $sender.Tag })
    [void]$ui.TodoList.Children.Add($row)
  }
  if ($more -gt 0) {
    $m = New-Object Windows.Controls.TextBlock
    $m.Text = "还有 $more 件，点「全部待办」看"; $m.FontSize = 11; $m.Foreground = New-Brush '#9CA3AF'; $m.Margin = '23,3,0,0'
    [void]$ui.TodoList.Children.Add($m)
  }
  if (-not $todos.Count -and -not $more) {
    $e = New-Object Windows.Controls.TextBlock
    $e.Text = '今天没有排上的事。在下面记一件，或者把文字拖到我身上。'; $e.FontSize = 11.5; $e.Foreground = New-Brush '#9CA3AF'; $e.TextWrapping = 'Wrap'; $e.Margin = '0,2,0,0'
    [void]$ui.TodoList.Children.Add($e)
  }
}
function Check-Todo($tag) {
  # 先在界面上划掉（圆圈变绿、标题加删除线），再提交；失败了 On-OpDone 会恢复
  $tag.ring.Background = New-Brush '#22C55E'; $tag.ring.BorderBrush = New-Brush '#22C55E'
  $tag.title.TextDecorations = [Windows.TextDecorations]::Strikethrough
  $tag.title.Foreground = New-Brush '#9CA3AF'
  $tag.row.IsEnabled = $false
  Squash 1
  Send-Dot '/task' @{ id = $tag.id; action = 'done' } 'On-OpDone' $tag.row
}
function Add-Todo {
  $text = $ui.TodoInput.Text.Trim()
  if (-not $text) { return }
  $ui.TodoInput.IsEnabled = $false
  Send-Dot '/task' @{ action = 'add'; text = $text; today = $true } 'On-TodoAdded' $null
}
function On-TodoAdded($r, $state) {
  $ui.TodoInput.IsEnabled = $true
  if ($r.ok -ne $false) { $ui.TodoInput.Text = ''; Bounce }
  Show-Out ([string]$r.text) ($r.ok -eq $false)
  [void]$ui.TodoInput.Focus()
  $script:forceCards = $true
  Refresh
}
$ui.TodoInput.Add_PreviewKeyDown({
  param($s, $e)
  if ($e.Key -eq 'Return') { $e.Handled = $true; Add-Todo }
  elseif ($e.Key -eq 'Escape') { $e.Handled = $true; Close-Panel }
})
$ui.TodoInput.Add_TextChanged({ $ui.TodoPh.Visibility = if ($ui.TodoInput.Text) { 'Collapsed' } else { 'Visible' } })
$ui.TodoAllBtn.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'tasks' }) })

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
foreach ($q in @(@('设个提醒', '/remind '), @('今日简报', '!/brief'), @('整理会话名', '!帮我整理一下会话的名字：用 dot_sessions list 找出名字待整理的，读一下在做什么，起好名字用 rename 提给我确认'), @('能做什么', '!/dot'))) {
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
$ui.Root.Add_DragEnter({ param($s, $e) $e.Effects = 'Copy'; Flash '放进来，帮你记下' 2; Emote 'happy' 'open' $false 1500; Bounce })
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
  $ui.TodoInput.Text = $text
  [void]$ui.TodoInput.Focus()
  $ui.TodoInput.CaretIndex = $ui.TodoInput.Text.Length
  Show-Out '回车就记成今天的待办；想设时间，在前面加，比如「明天10点 …」' $false
})

# 卡片：内容变了才重建；鼠标停在卡片上时先不动（重建会吞掉点击）
$script:cardsKey = ''
$script:forceCards = $false
$script:desk = $null
$kindColors = @{ focus = '#ECFDF5'; break = '#EFF6FF'; evening = '#F5F3FF'; approval = '#FFF7E6'; question = '#FFF7E6'; overdue = '#FEF2F2'; failed = '#FEF2F2'; done = '#ECFDF5'; handoff = '#F5F3FF'; soon = '#FFFBEB'; suggestions = '#EEF2FF' }
$kindBorders = @{ focus = '#86EFAC'; break = '#BFDBFE'; evening = '#C4B5FD'; approval = '#FCD34D'; question = '#FCD34D'; overdue = '#FCA5A5'; failed = '#FCA5A5'; done = '#86EFAC'; handoff = '#C4B5FD'; soon = '#FDE68A'; suggestions = '#C7D2FE' }
function Render-Cards([bool]$force) {
  $desk = $script:desk
  if (-not $desk) { return }
  Render-Todos $force
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

# ── 鼠标：按下缩一下；拖着走；松手掉回任务栏（甩一下会被扔出去）；拖到左右边缘就贴边 ──
# 单击开关面板，双击打开 Dot；在它身上来回蹭是摸摸
$script:drag = $null
$window.Add_LocationChanged({
  if ($null -eq $script:drag) { return }
  [void]$script:drag.Add(@{ t = (Now-Ms); x = $window.Left; y = $window.Top })
  if ($script:drag.Count -gt 12) { $script:drag.RemoveAt(0) }
})
$ui.Pet.Add_MouseLeftButtonDown({
  param($s, $e)
  if ($e.ClickCount -ge 2) { Squash 1; Focus-Dsh ([pscustomobject]@{ nav = 'dot' }); return }
  $startX = $window.Left; $startY = $window.Top
  $script:hidden = $false
  $window.BeginAnimation([Windows.Window]::LeftProperty, $null)
  $window.Left = $startX
  $prev = $script:act
  if ($prev -eq 'walk' -or $prev -eq 'fall') { $prev = 'idle' }
  Set-Act 'held'
  Squash 0.9
  $script:drag = New-Object System.Collections.ArrayList
  try { $window.DragMove() } catch { }
  $samples = $script:drag
  $script:drag = $null
  Squash 1
  $moved = [Math]::Abs($window.Left - $startX) + [Math]::Abs($window.Top - $startY)
  if ($moved -gt 3) { Release-Pet $samples; return }
  if ($prev -eq 'sleep') { Set-Act 'idle'; Wake-Up; return }
  Set-Act $prev
  if ($ui.Panel.IsOpen) { Close-Panel } else { Bounce; Open-Panel }
})
# 松手：快速甩出去就按速度飞；靠近左右边缘就贴边；其余掉回任务栏
function Release-Pet($samples) {
  $vx = 0.0; $vy = 0.0
  $n = if ($samples) { $samples.Count } else { 0 }
  if ($n -ge 2) {
    $last = $samples[$n - 1]
    $i = $n - 2
    while ($i -gt 0 -and $last.t - $samples[$i].t -lt 80) { $i-- }
    $dt = [Math]::Max(1, $last.t - $samples[$i].t)
    if ((Now-Ms) - $last.t -lt 120) {
      $vx = ($last.x - $samples[$i].x) / $dt * 33
      $vy = ($last.y - $samples[$i].y) / $dt * 33
    }
  }
  $a = Here-Area
  $petL = (Stage-Left) + $PadX
  $fast = ([Math]::Abs($vx) + [Math]::Abs($vy)) -gt 18
  if (-not $fast -and $petL - $a.Left -lt $SnapDistance) { Snap-Edge 'left'; Set-Act 'idle'; return }
  if (-not $fast -and $a.Right - ($petL + $PetSize) -lt $SnapDistance) { Snap-Edge 'right'; Set-Act 'idle'; return }
  $script:edge = 'ground'
  $script:vx = [Math]::Max(-40, [Math]::Min(40, $vx))
  $script:vy = [Math]::Max(-40, [Math]::Min(40, $vy))
  $script:maxFall = 0
  Set-Act 'fall'
}
# 摸摸：鼠标在它身上来回换方向 4 次（1.4 秒内）
$script:strokeX = $null
$script:strokeDir = 0
$script:strokeTimes = New-Object System.Collections.ArrayList
$script:strokeCool = 0
$ui.Pet.Add_MouseMove({
  param($s, $e)
  if ($e.LeftButton -eq 'Pressed') { return }
  $x = $e.GetPosition($ui.Pet).X
  $now = Now-Ms
  if ($null -eq $script:strokeX) { $script:strokeX = $x; return }
  $dx = $x - $script:strokeX
  if ([Math]::Abs($dx) -lt 3) { return }
  $dir = [Math]::Sign($dx)
  if ($script:strokeDir -ne 0 -and $dir -ne $script:strokeDir) { [void]$script:strokeTimes.Add($now) }
  $script:strokeDir = $dir; $script:strokeX = $x
  while ($script:strokeTimes.Count -and $now - $script:strokeTimes[0] -gt 1400) { $script:strokeTimes.RemoveAt(0) }
  if ($script:strokeTimes.Count -ge 4 -and $now -gt $script:strokeCool) {
    $script:strokeTimes.Clear(); $script:strokeCool = $now + 2500
    Pet-Stroked
  }
})
$ui.Pet.Add_MouseLeave({ $script:strokeX = $null; $script:strokeDir = 0 })
function Pet-Stroked {
  if ($script:act -eq 'sleep') { Set-Act 'idle'; Wake-Up; return }
  if ($script:act -ne 'idle' -and $script:act -ne 'focus') { return }
  Emote 'happy' 'smile' $true 1600
  for ($i = 0; $i -lt 3; $i++) {
    Spawn ([string][char]0x2665) '#FF6B9A' (28 + $rand.Next(36)) 66 (($rand.NextDouble() - 0.5) * 1.2) (-1.0 - $rand.NextDouble()) 1100 (11 + $rand.Next(5))
  }
  Wiggle
}

# ── 右键菜单 ──
$menu = New-Object Windows.Controls.ContextMenu
$miOpen = New-Object Windows.Controls.MenuItem; $miOpen.Header = '打开 Dot'; $miOpen.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'dot' }) })
$miSess = New-Object Windows.Controls.MenuItem; $miSess.Header = '会话总览'; $miSess.Add_Click({ Focus-Dsh ([pscustomobject]@{ nav = 'sessions' }) })
$miBrief = New-Object Windows.Controls.MenuItem; $miBrief.Header = '今日简报'; $miBrief.Add_Click({ Open-Panel; Say '/brief' })
$miStats = New-Object Windows.Controls.MenuItem; $miStats.Header = '今日统计'; $miStats.Add_Click({ Open-Panel; Show-Stats $true })
$miFocus = New-Object Windows.Controls.MenuItem; $miFocus.Header = '专注…（在面板的待办上点 🎧）'; $miFocus.Add_Click({ Open-Panel; Show-Out '在下面「今天」的待办上点 🎧，我陪你专注 25 分钟' $false })
# 换装：一开始全部可选
$miOutfit = New-Object Windows.Controls.MenuItem; $miOutfit.Header = '换装'
$Outfits = @(@('none', '不戴'), @('scarf', '小围巾'), @('leaf', '头顶小叶子'), @('cap', '鸭舌帽'), @('headphones', '耳机'), @('bow', '蝴蝶结'), @('crown', '小皇冠'))
foreach ($o in $Outfits) {
  $mi = New-Object Windows.Controls.MenuItem
  $mi.Header = $o[1]; $mi.Tag = $o[0]; $mi.IsCheckable = $true; $mi.IsChecked = ($o[0] -eq 'none')
  $mi.Add_Click({ param($sender, $e) Send-Dot '/pet' @{ action = 'outfit'; id = [string]$sender.Tag } 'On-OpDone' $null; $script:outfit = [string]$sender.Tag; Apply-Outfit; Update-OutfitMenu; Bounce })
  [void]$miOutfit.Items.Add($mi)
}
function Update-OutfitMenu { foreach ($mi in $miOutfit.Items) { $mi.IsChecked = ([string]$mi.Tag -eq $script:outfit) } }
$miGround = New-Object Windows.Controls.MenuItem; $miGround.Header = '回到任务栏上'
$miGround.Add_Click({ $script:edge = 'ground'; $script:hidden = $false; Update-Layout; $script:vx = 0.0; $script:vy = 0.0; $script:maxFall = 0; Set-Act 'fall' })
$miPause = New-Object Windows.Controls.MenuItem; $miPause.Header = '暂停 Dot'; $miPause.Add_Click({ Say $(if ($script:paused) { '/resume' } else { '/pause' }) })
$miQuiet = New-Object Windows.Controls.MenuItem; $miQuiet.Header = '安静模式（不走动、不冒气泡）'; $miQuiet.IsCheckable = $true
$miExit = New-Object Windows.Controls.MenuItem; $miExit.Header = '关掉桌面精灵（DSH 重启后会再出现）'; $miExit.Add_Click({ $window.Close() })
foreach ($mi in @($miOpen, $miSess, $miBrief, $miStats, (New-Object Windows.Controls.Separator), $miFocus, $miOutfit, $miGround, (New-Object Windows.Controls.Separator), $miPause, $miQuiet, (New-Object Windows.Controls.Separator), $miExit)) { [void]$menu.Items.Add($mi) }
$menu.Add_Opened({ $miGround.Visibility = if ($script:edge -eq 'ground') { 'Collapsed' } else { 'Visible' } })
$ui.Pet.ContextMenu = $menu

# ── 桌宠的身体：颜色、表情、装扮、手里的东西、粒子 ──
# 每个姿态都对应一个管理信号，见 docs/DESK-BUDDY.md「身体语言」
$moods = @{
  busy    = @('#93C5FD', '#2563EB')
  waiting = @('#FCD34D', '#F59E0B')
  done    = @('#6EE7B7', '#10B981')
  alert   = @('#FDA4AF', '#E11D48')
  paused  = @('#C9CCD3', '#8A8F99')
}
$script:mood = 'idle'
$script:idleColors = @('#8AA2FF', '#4D6BFE')
$rand = New-Object Random
function Apply-Colors {
  $c = if ($script:mood -eq 'idle') { $script:idleColors } else { $moods[$script:mood] }
  if (-not $c) { $c = $script:idleColors }
  $ui.Top.Color = [Windows.Media.ColorConverter]::ConvertFromString($c[0])
  $ui.Bottom.Color = [Windows.Media.ColorConverter]::ConvertFromString($c[1])
  $ui.Ahoge.Stroke = New-Brush $c[1]
}

# 表情：眼睛（normal 竖条 / half 半闭 / line 闭眼 / dot 圆点 / wink 眨一只 / happy ^^ / dizzy 转圈）+ 嘴 + 腮红 + 汗
$geoCache = @{}
function Geo([string]$d) { if (-not $geoCache.ContainsKey($d)) { $geoCache[$d] = [Windows.Media.Geometry]::Parse($d) }; return $geoCache[$d] }
$MouthShapes = @{
  w     = 'M0,1 Q2.5,4.5 5,1 Q7.5,4.5 10,1'
  open  = 'M1,0 L9,0 Q9,7 5,7 Q1,7 1,0 Z'
  o     = 'M5,0.5 A2.6,2.6 0 1 1 4.99,0.5 Z'
  flat  = 'M2,2 L8,2'
  wave  = 'M0,2 Q2.5,0 5,2 Q7.5,4 10,2'
  smile = 'M1,0.5 Q5,6.5 9,0.5'
}
$script:eyes = 'normal'; $script:mouth = ''; $script:eyeH = 12
$script:lookX = 0.0; $script:lookY = 0.0
$script:emoteUntil = 0
function Apply-Eyes {
  $e = $script:eyes
  $bar = @('normal', 'half', 'line', 'wink', 'dot') -contains $e
  $v = if ($bar) { 'Visible' } else { 'Collapsed' }
  $ui.EyeL.Visibility = $v; $ui.EyeR.Visibility = $v
  $v = if ($e -eq 'happy') { 'Visible' } else { 'Collapsed' }
  $ui.EyeLX.Visibility = $v; $ui.EyeRX.Visibility = $v
  $v = if ($e -eq 'dizzy') { 'Visible' } else { 'Collapsed' }
  $ui.EyeLO.Visibility = $v; $ui.EyeRO.Visibility = $v
  if (-not $bar) { return }
  $h = switch ($e) { 'half' { 5 } 'line' { 2 } 'dot' { 6 } default { $script:eyeH } }
  $hr = if ($e -eq 'wink') { 2 } else { $h }
  $ui.EyeL.Height = $h; $ui.EyeR.Height = $hr
  $ui.EyeL.Width = 6; $ui.EyeR.Width = 6
  [Windows.Controls.Canvas]::SetLeft($ui.EyeL, 17 + $script:lookX); [Windows.Controls.Canvas]::SetLeft($ui.EyeR, 33 + $script:lookX)
  [Windows.Controls.Canvas]::SetTop($ui.EyeL, 28 - $h / 2 + $script:lookY); [Windows.Controls.Canvas]::SetTop($ui.EyeR, 28 - $hr / 2 + $script:lookY)
}
function Set-Face([string]$eyes, [string]$mouth, [bool]$cheeks = $false, [bool]$sweat = $false) {
  $script:eyes = $eyes
  if ($mouth -ne $script:mouth) {
    $script:mouth = $mouth
    $ui.Mouth.Data = Geo $MouthShapes[$mouth]
    $ui.Mouth.Fill = if ($mouth -eq 'open' -or $mouth -eq 'o') { New-Brush '#40203070' } else { $null }
  }
  $v = if ($cheeks) { 'Visible' } else { 'Collapsed' }
  $ui.CheekL.Visibility = $v; $ui.CheekR.Visibility = $v
  $ui.Sweat.Visibility = if ($sweat) { 'Visible' } else { 'Collapsed' }
  Apply-Eyes
}
# 一个持续 ms 毫秒的表情，过后回到由状态决定的表情
function Emote([string]$eyes, [string]$mouth, [bool]$cheeks, [int]$ms) {
  $script:emoteUntil = (Now-Ms) + $ms
  Set-Face $eyes $mouth $cheeks $false
}
function Base-Face {
  if ((Now-Ms) -lt $script:emoteUntil) { return }
  switch ($script:act) {
    'sleep' { Set-Face 'line' 'o'; return }
    'rest' { Set-Face 'line' 'o'; return }
    'fall' { Set-Face 'dot' 'o'; return }
    'held' { Set-Face 'dot' 'o'; return }
    'dizzy' { Set-Face 'dizzy' 'wave'; return }
    'focus' { Set-Face 'normal' 'flat'; return }
  }
  $tired = $script:stats -and [int]$script:stats.continuousMin -ge 90
  switch ($script:mood) {
    'busy' { Set-Face 'normal' 'flat' }
    'waiting' { Set-Face 'normal' 'o' $false $script:carryUrgent }
    'done' { Set-Face 'happy' 'smile' $true }
    'alert' { Set-Face 'normal' 'wave' $false $true }
    'paused' { Set-Face 'line' 'flat' }
    default { if ($tired) { Set-Face 'half' 'wave' } else { Set-Face 'normal' 'w' } }
  }
}

# 装扮：专注时自动戴耳机；戴帽子、耳机、皇冠时把呆毛藏起来
$OutfitParts = @{ scarf = 'OScarf'; leaf = 'OLeaf'; cap = 'OCap'; headphones = 'OHeadphones'; bow = 'OBow'; crown = 'OCrown' }
$script:outfit = 'none'
function Apply-Outfit {
  $want = if ($script:act -eq 'focus') { 'headphones' } else { $script:outfit }
  foreach ($k in $OutfitParts.Keys) { $ui[$OutfitParts[$k]].Visibility = if ($k -eq $want) { 'Visible' } else { 'Collapsed' } }
  $ui.Ahoge.Visibility = if (@('cap', 'headphones', 'crown') -contains $want) { 'Collapsed' } else { 'Visible' }
}

# 手里的东西：包裹（N 件事需要你；急事是红的）、信封（会话跑完了）
$script:carryUrgent = $false
function Set-Carry($cards) {
  $cards = @($cards)
  if (-not $cards.Count) { $ui.Carry.Visibility = 'Collapsed'; $script:carryUrgent = $false; return }
  $kinds = @($cards | ForEach-Object { [string]$_.kind })
  $urgent = @($kinds | Where-Object { @('approval', 'question', 'failed', 'overdue') -contains $_ }).Count -gt 0
  $letters = @($kinds | Where-Object { $_ -eq 'done' -or $_ -eq 'handoff' }).Count
  $script:carryUrgent = $urgent
  if (-not $urgent -and $letters -eq $cards.Count) {
    $ui.CarryText.Text = [string][char]0x2709 + $(if ($cards.Count -gt 1) { " $($cards.Count)" } else { '' })
    $ui.Carry.Background = New-Brush '#2BB59A'
  } else {
    $ui.CarryText.Text = [string]$cards.Count
    $ui.Carry.Background = New-Brush $(if ($urgent) { '#EF4444' } else { '#F5A524' })
  }
  $ui.CarryRot.Angle = if ($urgent) { -6 } else { 8 }
  $ui.Carry.Visibility = 'Visible'
}

# 粒子：爱心、星星、z、火花。坐标是舞台坐标（96×132，精灵的嘴大约在 48,99）
$script:parts = New-Object System.Collections.ArrayList
function Spawn([string]$text, [string]$color, [double]$x, [double]$y, [double]$vx, [double]$vy, [int]$ms, [double]$size = 12, $target = $null) {
  $tb = New-Object Windows.Controls.TextBlock
  $tb.Text = $text; $tb.FontSize = $size; $tb.Foreground = New-Brush $color; $tb.FontWeight = 'Bold'
  [Windows.Controls.Canvas]::SetLeft($tb, $x); [Windows.Controls.Canvas]::SetTop($tb, $y)
  [void]$ui.Fx.Children.Add($tb)
  [void]$script:parts.Add(@{ el = $tb; x = $x; y = $y; x0 = $x; y0 = $y; vx = $vx; vy = $vy; born = (Now-Ms); ms = $ms; target = $target })
}
function Tick-Parts([double]$t) {
  foreach ($p in @($script:parts)) {
    $age = $t - $p.born
    if ($age -ge $p.ms) { $ui.Fx.Children.Remove($p.el); $script:parts.Remove($p); continue }
    if ($p.target) {
      $k = $age / $p.ms; $k = $k * $k
      $p.x = $p.x0 + ($p.target[0] - $p.x0) * $k; $p.y = $p.y0 + ($p.target[1] - $p.y0) * $k
    } else { $p.x += $p.vx; $p.y += $p.vy }
    [Windows.Controls.Canvas]::SetLeft($p.el, $p.x); [Windows.Controls.Canvas]::SetTop($p.el, $p.y)
    $p.el.Opacity = if ($p.target) { 1 } elseif ($age -gt $p.ms * 0.6) { 1 - ($age - $p.ms * 0.6) / ($p.ms * 0.4) } else { 1 }
  }
}

# ── 动作：idle 待着 / walk 溜达 / fall 掉落或被甩 / held 被拎着 / dizzy 晕 / sleep 睡觉 / rest 陪你休息 / focus 陪你专注 ──
$script:act = 'idle'
$script:breathBase = 1.0
$script:vx = 0.0; $script:vy = 0.0; $script:maxFall = 0
$script:walkTo = 0.0
$script:dizzyUntil = 0
$script:nextIdleAt = (Now-Ms) + 6000
$script:blinkAt = (Now-Ms) + 3000; $script:unblinkAt = 0
$script:chewN = 0; $script:chewAt = 0
$script:typing = $false
$script:quiet = $false; $script:sysQuiet = $false
$script:stats = $null
$script:focusInfo = $null; $script:restInfo = $null
function Set-Act([string]$a) {
  $script:act = $a
  if ($a -ne 'walk') {
    [Windows.Controls.Canvas]::SetTop($ui.FootL, 54); [Windows.Controls.Canvas]::SetTop($ui.FootR, 54)
    $ui.PetBob.Y = 0
  }
  $script:breathBase = if ($a -eq 'focus') { 0.93 } elseif ($a -eq 'sleep' -or $a -eq 'rest') { 0.9 } else { 1.0 }
  if (@('fall', 'held', 'dizzy', 'sleep', 'rest', 'focus') -contains $a) { $script:emoteUntil = 0; Set-Typing $false }
  $ui.Shadow.Opacity = if ($a -eq 'fall' -or $a -eq 'held') { 0 } else { 1 }
  if ($a -eq 'focus') { $ui.Ring.Stroke = New-Brush '#1D9E75'; $ui.RingBox.Visibility = 'Visible' }
  elseif ($a -eq 'rest') { $ui.Ring.Stroke = New-Brush '#7FB8F0'; $ui.RingBox.Visibility = 'Visible' }
  else { $ui.RingBox.Visibility = 'Collapsed' }
  Apply-Outfit
  Base-Face
}
function Go-Sleep { Set-Act 'sleep' }
function Wake-Up {
  if ($script:act -eq 'sleep' -or $script:act -eq 'rest') { Set-Act 'idle' }
  Stretch
  Hop 10 340
  $script:nextIdleAt = (Now-Ms) + 8000
}
function Set-Typing([bool]$on) {
  if ($on -eq $script:typing) { return }
  $script:typing = $on
  $ui.Keyboard.Visibility = if ($on) { 'Visible' } else { 'Collapsed' }
  if (-not $on) { [Windows.Controls.Canvas]::SetTop($ui.FootL, 54); [Windows.Controls.Canvas]::SetTop($ui.FootR, 54) }
}
# 勾掉一件待办：一颗星星飞进嘴里，嚼一嚼，开心一下
function Feed {
  Spawn ([string][char]0x2605) '#FFC83D' 74 28 0 0 520 17 @(41, 90)
  $script:chewAt = (Now-Ms) + 480; $script:chewN = 6
}
function Trip {
  Set-Act 'idle'
  $ui.PetRot.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, (New-Keys @(@(0, 0), @(120, -22), @(520, -22), @(760, 0))))
  Emote 'dot' 'o' $false 900
  Save-Position
}
function Start-Walk {
  $hx = if ($null -ne $script:homeX) { [double]$script:homeX } else { Stage-Center }
  $a = Here-Area
  $target = $hx + ($rand.NextDouble() * 2 - 1) * $WalkRange
  $target = [Math]::Max($a.Left + $StageW / 2 + 10, [Math]::Min($a.Right - $StageW / 2 - 10, $target))
  if ([Math]::Abs($target - (Stage-Center)) -lt 30) { return }
  $script:walkTo = $target
  Set-Act 'walk'
}
function Step-Walk([double]$t) {
  $cx = Stage-Center
  $d = $script:walkTo - $cx
  if ([Math]::Abs($d) -lt 1.5 -or $script:quiet -or $ui.Panel.IsOpen) { Set-Act 'idle'; Update-Layout; Save-Position; return }
  Set-StageLeft ((Stage-Left) + [Math]::Sign($d) * 1.3)
  $ph = $t / 140.0
  $ui.PetBob.Y = -[Math]::Abs([Math]::Sin($ph)) * 2.5
  [Windows.Controls.Canvas]::SetTop($ui.FootL, 54 - [Math]::Max(0, [Math]::Sin($ph)) * 3)
  [Windows.Controls.Canvas]::SetTop($ui.FootR, 54 - [Math]::Max(0, -[Math]::Sin($ph)) * 3)
  if ($rand.Next(1200) -eq 0) { Trip }
}
function Step-Fall([double]$t) {
  $a = Here-Area
  $script:vy += 1.6
  $script:vx *= 0.995
  $nx = (Stage-Left) + $script:vx
  $ny = $window.Top + $script:vy
  $minX = $a.Left - $PadX; $maxX = $a.Right - $PadX - $PetSize
  if ($nx -lt $minX) { $nx = $minX; $script:vx = -$script:vx * 0.6; Land-Squish }
  if ($nx -gt $maxX) { $nx = $maxX; $script:vx = -$script:vx * 0.6; Land-Squish }
  if ($ny -lt $a.Top - 60) { $ny = $a.Top - 60; $script:vy = [Math]::Abs($script:vy) * 0.5 }
  $script:maxFall = [Math]::Max($script:maxFall, $script:vy)
  $ground = $a.Bottom - $WinH
  $landed = $false
  if ($ny -ge $ground) {
    $ny = $ground
    if ($script:vy -gt 9) { $script:vy = -$script:vy * 0.38; $script:vx *= 0.7; Land-Squish }
    else { $landed = $true }
  }
  $window.Top = $ny
  Set-StageLeft $nx
  if ($landed) {
    $script:homeX = Stage-Center
    Update-Layout
    if ($script:maxFall -gt 24) {
      Set-Act 'dizzy'; $script:dizzyUntil = $t + 1300
      for ($i = 0; $i -lt 3; $i++) { Spawn ([string][char]0x2726) '#FFC83D' (30 + $i * 14) 60 0 -0.3 1200 10 }
    } else { Set-Act 'idle'; Land-Squish }
    Save-Position
  }
}
function Update-Ring([double]$t) {
  $total = 0.0; $left = 0.0
  if ($script:act -eq 'focus' -and $script:focusInfo) {
    $total = [double]$script:focusInfo.minutes * 60; $left = [double]$script:focusInfo.leftSec - ($t - $script:infoAt) / 1000
  } elseif ($script:act -eq 'rest' -and $script:restInfo) {
    $total = 300.0; $left = [double]$script:restInfo.leftSec - ($t - $script:infoAt) / 1000
  }
  if ($total -le 0) { return }
  $p = [Math]::Max(0.0, [Math]::Min(1.0, 1 - $left / $total))
  $inv = [Globalization.CultureInfo]::InvariantCulture
  if ($p -ge 0.999) { $ui.Ring.Data = Geo 'M38,3 A35,35 0 1 1 37.99,3'; return }
  if ($p -le 0.001) { $ui.Ring.Data = $null; return }
  $ang = 360 * $p
  $rad = ($ang - 90) * [Math]::PI / 180
  $x = (38 + 35 * [Math]::Cos($rad)).ToString('F2', $inv); $y = (38 + 35 * [Math]::Sin($rad)).ToString('F2', $inv)
  $large = if ($ang -gt 180) { 1 } else { 0 }
  $ui.Ring.Data = [Windows.Media.Geometry]::Parse("M38,3 A35,35 0 $large 1 $x,$y")
}
# 眼睛：眨眼；溜达时看前面；打字时看键盘；在忙时左右看；其余时候看着你的鼠标
function Look-Around([double]$t) {
  if ($t -ge $script:blinkAt) {
    $script:blinkAt = $t + 2800 + $rand.Next(3500)
    if ($script:eyes -eq 'normal') { $script:eyeH = 2; Apply-Eyes; $script:unblinkAt = $t + 130 }
  }
  if ($script:unblinkAt -and $t -ge $script:unblinkAt) { $script:unblinkAt = 0; $script:eyeH = 12; Apply-Eyes }
  if (@('sleep', 'rest', 'fall', 'held', 'dizzy') -contains $script:act) { return }
  $lx = 0.0; $ly = 0.0
  if ($script:act -eq 'walk') { $lx = 2.5 * [Math]::Sign($script:walkTo - (Stage-Center)) }
  elseif ($script:typing) { $ly = 2 }
  elseif ($script:mood -eq 'busy' -or $script:awaiting) { $lx = if ((($t / 650) % 2) -lt 1) { -2.5 } else { 2.5 } }
  else {
    $c = [System.Windows.Forms.Cursor]::Position
    $dx = $c.X / $script:scale - (Stage-Center)
    $dy = $c.Y / $script:scale - ($window.Top + $StageH - 40)
    if ([Math]::Abs($dx) + [Math]::Abs($dy) -lt 700) {
      $lx = [Math]::Round([Math]::Max(-2.5, [Math]::Min(2.5, $dx / 60)), 1)
      $ly = [Math]::Round([Math]::Max(-1.5, [Math]::Min(1.5, $dy / 80)), 1)
    }
  }
  if ($lx -ne $script:lookX -or $ly -ne $script:lookY) { $script:lookX = $lx; $script:lookY = $ly; Apply-Eyes }
}
# 空闲时的小动作，8~30 秒一次；安静、面板开着、鼠标在它身上时不做
function Idle-Behavior([double]$t) {
  $script:nextIdleAt = $t + 8000 + $rand.Next(22000)
  if ($script:quiet -or $ui.Panel.IsOpen -or $ui.Root.IsMouseOver) { return }
  if ($script:mood -ne 'idle' -and $script:mood -ne 'done') { return }
  $r = $rand.Next(100)
  if ($script:edge -eq 'ground' -and $r -lt 45 -and -not $script:typing) { Start-Walk; return }
  if ($r -lt 58) { Hop 12 360; return }
  if ($r -lt 70) { Stretch; return }
  if ($r -lt 80) { Emote 'wink' 'w' $false 700; return }
  $late = (Get-Date).Hour -ge 22 -or ($script:stats -and [int]$script:stats.continuousMin -ge 90)
  if ($r -lt 90 -and $late) { Emote 'half' 'open' $false 1400; return }
  Wiggle
}

# ── 工作时长和按键：每秒看一眼系统「最后一次输入」，每分钟交给 Host 一次（只有次数，没有键值）──
$script:lastInputTick = [DotPet.Input]::LastInputTick()
$script:minuteActive = $false
$script:curMinute = [Math]::Floor((Now-Ms) / 60000)
$script:minuteKeys0 = [DotPet.KeyCounter]::Count
$script:lastKeyCount = [DotPet.KeyCounter]::Count
$script:keyHist = New-Object System.Collections.ArrayList
$script:actQueue = New-Object System.Collections.ArrayList
$script:actSending = $false
function Queue-Minute {
  $kc = [DotPet.KeyCounter]::Count
  $keys = if ([DotPet.KeyCounter]::On) { [int]($kc - $script:minuteKeys0) } else { 0 }
  $script:minuteKeys0 = $kc
  if ($script:minuteActive -or $keys -gt 0) {
    [void]$script:actQueue.Add(@{ at = [int64]($script:curMinute * 60000); active = $script:minuteActive; keys = $keys })
  }
  $script:minuteActive = $false
  while ($script:actQueue.Count -gt 120) { $script:actQueue.RemoveAt(0) }
  if ($script:actSending -or -not $script:actQueue.Count) { return }
  $script:actSending = $true
  $batch = @($script:actQueue)
  Send-Dot '/pet' @{ action = 'activity'; minutes = $batch } 'On-ActivitySent' $batch.Count
}
function On-ActivitySent($r, $n) {
  $script:actSending = $false
  if ($r.ok -ne $false -and -not $r.failed) { for ($i = 0; $i -lt $n -and $script:actQueue.Count; $i++) { $script:actQueue.RemoveAt(0) } }
}
function Sync-Keys([bool]$want) {
  if ($want -and -not [DotPet.KeyCounter]::On) {
    if ([DotPet.KeyCounter]::Start()) { $script:minuteKeys0 = [DotPet.KeyCounter]::Count; $script:lastKeyCount = $script:minuteKeys0; Write-PetLog 'key counter on' }
    else { Write-PetLog 'key counter failed to start' }
  } elseif (-not $want -and [DotPet.KeyCounter]::On) { [DotPet.KeyCounter]::Stop(); Set-Typing $false; Write-PetLog 'key counter off' }
}

# ── 心跳：30 帧动画；每秒一次的作息 ──
$script:tickN = 0
$script:secN = 0
$script:lastLook = 0
$script:lastSec = 0
$script:infoAt = Now-Ms
function Second-Tick([double]$t) {
  $script:secN++
  if ($script:secN % 5 -eq 0) { $script:sysQuiet = try { [DotPet.Input]::Quiet() } catch { $false } }
  $script:quiet = $script:sysQuiet -or $miQuiet.IsChecked
  $idle = [double][DotPet.Input]::IdleMs()
  $li = [DotPet.Input]::LastInputTick()
  if ($li -ne $script:lastInputTick) { $script:lastInputTick = $li; if ($idle -lt 2500) { $script:minuteActive = $true } }
  # 打字节奏：最近 3 秒按了 8 下以上，就跟着一起敲
  $typing = $false
  if ([DotPet.KeyCounter]::On) {
    $kc = [DotPet.KeyCounter]::Count
    [void]$script:keyHist.Add($kc - $script:lastKeyCount); $script:lastKeyCount = $kc
    while ($script:keyHist.Count -gt 3) { $script:keyHist.RemoveAt(0) }
    $sum = 0; foreach ($k in $script:keyHist) { $sum += $k }
    $typing = $sum -ge 8
  }
  Set-Typing ($typing -and $script:act -eq 'idle' -and -not $script:quiet)
  $minute = [Math]::Floor($t / 60000)
  if ($minute -ne $script:curMinute) { Queue-Minute; $script:curMinute = $minute }
  # 睡觉：你离开 5 分钟；夜里（23 点到 7 点）离开 1 分钟。有输入就醒
  $hour = (Get-Date).Hour
  $night = $hour -ge 23 -or $hour -lt 7
  if ($script:act -eq 'sleep') { if ($idle -lt 1500) { Wake-Up } }
  elseif (($script:act -eq 'idle' -or $script:act -eq 'walk') -and ($idle -gt 300000 -or ($night -and $idle -gt 60000))) { Go-Sleep }
  if ($script:act -eq 'sleep' -or $script:act -eq 'rest') {
    if ($script:secN % 2 -eq 0) { Spawn 'z' '#94A3B8' 60 62 0.35 -0.45 2000 (10 + $rand.Next(4)) }
  }
  if ($script:act -eq 'dizzy' -and $t -ge $script:dizzyUntil) { Set-Act 'idle'; Emote 'happy' 'smile' $false 700 }
  if ($script:act -eq 'idle' -and $t -ge $script:nextIdleAt) { Idle-Behavior $t }
  # 急事：举着包裹跳一跳
  if ($script:carryUrgent -and $script:act -eq 'idle' -and -not $script:quiet -and ($script:secN % 4 -eq 0)) { Hop 10 300 }
  if ($script:act -eq 'focus' -or $script:act -eq 'rest') { Update-Ring $t }
  Base-Face
}
function Engine-Tick {
  $t = [double](Now-Ms)
  $script:tickN++
  if ($script:parts.Count) { Tick-Parts $t }
  if ($script:act -eq 'fall') { Step-Fall $t }
  elseif ($script:act -eq 'walk') { Step-Walk $t }
  # 呼吸、呆毛（贴边藏起来时看不见，不动它们，免得白白重绘透明窗口）
  if (-not $script:hidden) {
  $amp = if ($script:act -eq 'sleep' -or $script:act -eq 'rest') { 0.035 } else { 0.018 }
  $br = $script:breathBase + [Math]::Sin($t / 650.0) * $amp
  $ui.PetBreath.ScaleY = $br; $ui.PetBreath.ScaleX = 1 + (1 - $br) * 0.5
  $ui.AhogeRot.Angle = [Math]::Sin($t / 420.0) * $(if ($script:act -eq 'walk') { 14 } else { 5 })
  }
  # 嚼星星
  if ($script:chewN -gt 0 -and $t -ge $script:chewAt) {
    $script:chewN--
    $script:chewAt = $t + 130
    if ($script:chewN -eq 0) {
      Emote 'happy' 'smile' $true 1300
      for ($i = 0; $i -lt 3; $i++) { Spawn ([string][char]0x2726) '#FFC83D' (34 + $rand.Next(30)) 70 (($rand.NextDouble() - 0.5) * 1.5) (-0.8 - $rand.NextDouble()) 800 9 }
      Hop 8 300
    } else { Emote 'happy' $(if ($script:chewN % 2) { 'open' } else { 'w' }) $true 400 }
  }
  # 跟着打字：两只脚轮流点
  if ($script:typing) {
    $up = if ((($t / 110) % 2) -lt 1) { 2.5 } else { 0 }
    [Windows.Controls.Canvas]::SetTop($ui.FootL, 54 - $up); [Windows.Controls.Canvas]::SetTop($ui.FootR, 51.5 + $up)
  }
  if ($t - $script:lastLook -ge 160) { $script:lastLook = $t; Look-Around $t }
  if ($t - $script:lastSec -ge 1000) { $script:lastSec = $t; Second-Tick $t }
  # 省电：透明窗口是软件渲染的，每动一下就要重画整个窗口。走路、掉落、粒子、嚼东西、打字时 30 帧；
  # 平时 10 帧；睡觉 8 帧；贴边藏起来时 4 帧且不做呼吸动画
  $sleepy = $script:act -eq 'sleep' -or $script:act -eq 'rest'
  $busy = ($script:parts.Count -and -not $sleepy) -or $script:chewN -or $script:typing -or $script:act -eq 'walk' -or $script:act -eq 'fall'
  $ms = if ($busy) { 33 } elseif ($script:hidden) { 250 } elseif ($sleepy) { 125 } else { 100 }
  if ($engine.Interval.TotalMilliseconds -ne $ms) { $engine.Interval = [TimeSpan]::FromMilliseconds($ms) }
}
$engine = New-Object Windows.Threading.DispatcherTimer
$engine.Interval = [TimeSpan]::FromMilliseconds(33)
$engine.Add_Tick({ try { Engine-Tick } catch { Write-PetLog "engine failed: $_" } })

# 今日统计：按小时的小柱子
function Fmt-Min([double]$m) { $m = [Math]::Round($m); if ($m -lt 60) { "$m 分钟" } else { "$([Math]::Floor($m / 60)) 小时" + $(if ($m % 60) { " $($m % 60) 分" } else { '' }) } }
function Show-Stats([bool]$on) {
  $ui.StatsBox.Visibility = if ($on) { 'Visible' } else { 'Collapsed' }
  if ($on) { Render-Stats }
}
function Render-Stats {
  $st = $script:stats
  if (-not $st) { return }
  $ui.StatsBars.Children.Clear()
  $w = $PanelW - 28 - 24
  $bw = $w / 24
  $keysOn = [bool]$st.keysOn
  for ($h = 0; $h -lt 24; $h++) {
    $v = [double]@($st.activeByHour)[$h]
    $k = [double]@($st.keysByHour)[$h]
    $r = New-Object Windows.Shapes.Rectangle
    $r.Width = [Math]::Max(2, $bw - 2); $r.Height = [Math]::Max(1.5, 44 * [Math]::Min(60, $v) / 60)
    $r.RadiusX = 1.5; $r.RadiusY = 1.5
    $r.Fill = New-Brush $(if ($v -gt 0) { '#4D6BFE' } else { '#E5E7EB' })
    $r.ToolTip = "$h 点：工作 $(Fmt-Min $v)" + $(if ($keysOn) { "，敲了 $k 下" } else { '' })
    [Windows.Controls.Canvas]::SetLeft($r, $h * $bw); [Windows.Controls.Canvas]::SetTop($r, 46 - $r.Height)
    [void]$ui.StatsBars.Children.Add($r)
  }
  $line = "工作 $(Fmt-Min ([double]$st.activeMin))"
  if ([int]$st.continuousMin -gt 0) { $line += "（这一段连续 $(Fmt-Min ([double]$st.continuousMin))）" }
  if ($keysOn) { $line += "，敲了 $($st.keys) 下" }
  $ui.StatsNote.Text = $line + "`n只看有没有在用电脑" + $(if ($keysOn) { '、按了几下键' } else { '' }) + '，不记按了什么、在哪个程序里。数据只在本机，保留 30 天。'
  $ui.KeysBtn.Content = if ($keysOn) { '⌨ 不数按键了' } else { '⌨ 数按键' }
  $ui.KeysBtn.ToolTip = if ($keysOn) { '停止数按键（立即卸载键盘钩子）' } else { '只数按了几下，不记按了什么。部分杀毒软件可能会提示键盘钩子' }
}
$ui.StatsText.Add_MouseLeftButtonUp({ Show-Stats ($ui.StatsBox.Visibility -ne 'Visible') })
$ui.KeysBtn.Add_Click({ Send-Dot '/pet' @{ action = 'keys'; on = -not [bool]$script:stats.keysOn } 'On-OpDone' $null })
$ui.FocusStopBtn.Add_Click({ Send-Dot '/pet' @{ action = 'focus-stop' } 'On-OpDone' $null })


# ── 桌宠的生活（Host 算好的 desk.life / stats / greeting）──
$script:lastFed = $null
$script:greeted = ''
function Apply-Life($desk) {
  $life = $desk.life
  if ($life) {
    if ([string]$life.outfit -and [string]$life.outfit -ne $script:outfit) { $script:outfit = [string]$life.outfit; Apply-Outfit; Update-OutfitMenu }
    # 勾掉了一件待办：喂一颗星星
    $fed = [string]$life.lastFed
    if ($null -ne $script:lastFed -and $fed -and $fed -ne $script:lastFed) { if ($script:act -eq 'sleep') { Set-Act 'idle' }; Feed }
    $script:lastFed = $fed
    $script:infoAt = Now-Ms
    # 专注
    $script:focusInfo = $life.focus
    if ($life.focus) {
      if (@('focus', 'held', 'fall') -notcontains $script:act) { Set-Act 'focus'; Hop 8 300 }
      $ui.FocusText.Text = [string][char]::ConvertFromUtf32(0x1F3A7) + " 专注中：$($life.focus.title) · 还剩 $([Math]::Ceiling([double]$life.focus.leftSec / 60)) 分"
      $ui.FocusRow.Visibility = 'Visible'
    } else {
      if ($script:act -eq 'focus') { Set-Act 'idle'; Emote 'happy' 'smile' $true 1500; Hop 14 380 }
      $ui.FocusRow.Visibility = 'Collapsed'
    }
    # 陪你休息
    $script:restInfo = $life.rest
    if ($life.rest -and @('rest', 'focus', 'held', 'fall') -notcontains $script:act) { Set-Act 'rest' }
    elseif (-not $life.rest -and $script:act -eq 'rest') { Wake-Up; Flash '休息好了，接着干！' 4 }
  }
  # 统计
  $st = $desk.stats
  $script:stats = $st
  if ($st) {
    Sync-Keys ([bool]$st.keysOn)
    $ui.StatsText.Text = "今天$($st.line)" + $(if ($st.keysOn) { ' · ⌨ 在数按键' } else { '' }) + ' ›'
    if ($ui.StatsBox.Visibility -eq 'Visible') { Render-Stats }
  }
  # 早上的问候：一天一次
  $today = (Get-Date).ToString('yyyy-MM-dd')
  if ($desk.greeting -and $script:greeted -ne $today -and @('sleep', 'rest', 'held', 'fall') -notcontains $script:act -and -not $script:quiet) {
    $script:greeted = $today
    Flash ([string]$desk.greeting) 9
    Emote 'happy' 'smile' $true 1600
    Hop 14 380
    Send-Dot '/pet' @{ action = 'greeted' } '' $null
  }
}

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
    if ($script:failures -ge 3) { $script:mood = 'paused'; Apply-Colors; Base-Face; $ui.Carry.Visibility = 'Collapsed'; $ui.Pet.ToolTip = 'Dot：连不上 DSH' }
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
  $script:mood = $mood
  Apply-Colors
  if ($desk) { Apply-Life $desk }
  Base-Face

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
    if ($fresh.Count -and $script:act -ne 'focus' -and $script:act -ne 'sleep') {
      Shake; Emote 'dot' 'o' $false 700
      if (-not $ui.Panel.IsOpen -and -not $script:quiet) { Flash ([string]$fresh[0].title) 6 }
    }
  }
  $script:seenCards = $keys
  Set-Carry $cards

  # 气泡：临时反馈优先；其次是状态气泡
  if ((Get-Date) -lt $script:flashUntil) {
    # 保持临时气泡
  } else {
    $text = [string]$s.bubble
    if ($text -and -not $script:quiet -and $mood -ne 'idle' -and -not $ui.Panel.IsOpen -and @('focus', 'sleep', 'rest') -notcontains $script:act) {
      $ui.BubbleText.Text = $text
      if ($text -ne $script:lastBubble) { Set-Hidden $false }
      $ui.Bubble.Visibility = 'Visible'
    } else {
      $ui.Bubble.Visibility = 'Collapsed'
    }
    $script:lastBubble = $text
  }
  $name = if ($desk) { [string]$desk.name } else { 'Dot' }
  $ui.Pet.ToolTip = if ($script:act -eq 'focus' -and $script:focusInfo) { "${name}：陪你专注「$($script:focusInfo.title)」，还剩 $([Math]::Ceiling([double]$script:focusInfo.leftSec / 60)) 分钟" }
    elseif ($s.bubble) { "${name}：$($s.bubble)" }
    else { "${name}：一切安静。单击打开面板，双击打开 Dot，摸摸我、把文字拖给我；拖到屏幕边缘会藏起来，Alt+Shift+D 随时叫出" }
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

# ── 开发用：录动图。只有设置了环境变量 DOT_PET_FRAMES（一个已存在的目录）才启用 ──
# 每 100ms 把精灵自己画成一张透明 PNG（不截屏，不会录到桌面上的其他东西），文件名带窗口位置：序号_左_上.png
$FrameDir = $env:DOT_PET_FRAMES
$rec = $null
if ($FrameDir -and (Test-Path -LiteralPath $FrameDir)) {
  $script:frameN = 0
  $rec = New-Object Windows.Threading.DispatcherTimer
  $rec.Interval = [TimeSpan]::FromMilliseconds(100)
  $rec.Add_Tick({
    try {
      $k = [double]$script:scale
      $rtb = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]($WinW * $k), [int]($WinH * $k), [double](96 * $k), [double](96 * $k), [Windows.Media.PixelFormats]::Pbgra32)
      $rtb.Render($window)
      $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
      $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($rtb))
      $name = '{0:D5}_{1}_{2}.png' -f $script:frameN, [int]$window.Left, [int]$window.Top
      $fs = [IO.File]::Create((Join-Path $FrameDir $name)); $enc.Save($fs); $fs.Close()
      $script:frameN++
    } catch { if (-not $script:recErr) { $script:recErr = $true; Write-PetLog "recording failed: $_" } }
  })
  Write-PetLog "recording frames to $FrameDir"
}

# ── 全局快捷键 Alt+Shift+D：开关面板（被别的程序占用时注册失败，其余功能照常）──
$HotkeyId = 0xD07
$script:hotkey = $false
$window.Add_SourceInitialized({
  Restore-Position
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
  if ($script:edge -ne 'ground') { Snap-Edge $script:edge }
  if ($FirstRun) { Flash '我住在任务栏上啦。单击打开面板，双击打开 Dot；摸摸我、把文字拖给我；拖到屏幕边上我会藏起来' 9; Hop 16 420 }
  elseif ($script:edge -ne 'ground') { $hideTimer.Start() }
})
$window.Add_Closed({
  $poll.Stop(); $fast.Stop(); $pump.Stop(); $engine.Stop(); if ($rec) { $rec.Stop() }
  try { [DotPet.KeyCounter]::Stop() } catch { }
  if ($script:hotkey) { [void][DotPet.Native]::UnregisterHotKey($script:hwnd, $HotkeyId) }
  try { $mutex.ReleaseMutex() } catch { }
  [Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
})
Set-Act 'idle'; Apply-Colors; Apply-Outfit
$pump.Start(); $poll.Start(); $fast.Start(); $engine.Start()
if ($rec) { $rec.Start() }
[void]$window.Show()
[Windows.Threading.Dispatcher]::Run()
