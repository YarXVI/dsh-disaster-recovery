' DSH 外部看门狗隐藏启动器（无控制台窗口）。
' 计划任务调用：wscript.exe //nologo "<本文件>"；本脚本用隐藏窗口+同步等待运行 watchdog.mjs。
Option Explicit

Dim shell, fso, scriptDir, nodeExe, scriptPath, configPath, cmd, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(scriptDir, "watchdog.mjs")
configPath = fso.BuildPath(scriptDir, "config.json")

' 优先固定安装路径，找不到再交给 PATH（Shell.Run 会解析 node.exe）。
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(nodeExe) Then
  nodeExe = shell.ExpandEnvironmentStrings("%ProgramW6432%\nodejs\node.exe")
End If
If Not fso.FileExists(nodeExe) Then
  nodeExe = "node.exe"
End If

If Not fso.FileExists(scriptPath) Then
  WScript.Quit 3
End If
If Not fso.FileExists(configPath) Then
  configPath = ""
End If

shell.CurrentDirectory = scriptDir
If configPath <> "" Then
  cmd = """" & nodeExe & """ """ & scriptPath & """ --once --config """ & configPath & """"
Else
  cmd = """" & nodeExe & """ """ & scriptPath & """ --once"
End If

On Error Resume Next
exitCode = shell.Run(cmd, 0, True)
If Err.Number <> 0 Then
  exitCode = 4
  Err.Clear
End If
On Error GoTo 0

WScript.Quit exitCode
