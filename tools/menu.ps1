# Test helper: click a menu command in the MarsNav window through UI Automation (no mouse, no keyboard).
#   powershell -File tools\menu.ps1 -ProcessId 1234 -Menu "Data" -Item "Local mode*"
param([int]$ProcessId, [string]$Menu, [string]$Item)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$C = [System.Windows.Automation.PropertyCondition]
$win = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,
  (New-Object $C($A::ProcessIdProperty, $ProcessId)))
if (-not $win) { "no window for pid $ProcessId"; exit 1 }
$mi = [System.Windows.Automation.ControlType]::MenuItem
$items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object $C($A::ControlTypeProperty, $mi)))
$top = $items | Where-Object { $_.Current.Name -eq $Menu } | Select-Object -First 1
if (-not $top) { "menu '$Menu' not found; have: " + (($items | % { $_.Current.Name }) -join ' | '); exit 1 }
$top.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
Start-Sleep -Milliseconds 600
$all = $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object $C($A::ControlTypeProperty, $mi)))
$sub = $all | Where-Object { $_.Current.Name -like $Item -and $_.Current.ProcessId -eq $ProcessId } | Select-Object -First 1
if (-not $sub) { "item '$Item' not found; have: " + (($all | Where-Object { $_.Current.ProcessId -eq $ProcessId } | % { $_.Current.Name }) -join ' | '); exit 1 }
"invoking: " + $sub.Current.Name
$sub.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
