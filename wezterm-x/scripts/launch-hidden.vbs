Option Explicit

Function QuoteArg(value)
  QuoteArg = """" & Replace(CStr(value), """", """""") & """"
End Function

Dim waitForExit
waitForExit = False

Dim argIndex
argIndex = 0

If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "--wait" Then
    waitForExit = True
    argIndex = 1
  End If
End If

If argIndex >= WScript.Arguments.Count Then
  WScript.Quit 64
End If

Dim command
command = QuoteArg(WScript.Arguments(argIndex))
argIndex = argIndex + 1

Do While argIndex < WScript.Arguments.Count
  command = command & " " & QuoteArg(WScript.Arguments(argIndex))
  argIndex = argIndex + 1
Loop

Dim shell
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(command, 0, waitForExit)
