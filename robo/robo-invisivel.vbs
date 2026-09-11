' Liga o robô SEM janela nenhuma — não aparece na barra de tarefas.
'
' É este arquivo que vai na pasta de Inicializar do Windows, pra o robô subir
' sozinho quando o Matheus entra no computador e ficar invisível.
'
' Para PARAR o robô: use o botão "Parar robô" no sistema (aba Anúncios).
' Ele avisa o robô pelo banco de dados, sem precisar mexer aqui.
'
' O caminho da pasta NÃO fica fixo aqui: o arquivo se localiza sozinho. Assim ele
' continua funcionando se o projeto for movido, ou reinstalado noutro computador.
' Só há uma exceção: quando este .vbs é COPIADO para a pasta Inicializar, a cópia
' perde a referência — por isso ela guarda o caminho na primeira vez que roda.

' Este arquivo roda de 5 em 5 minutos (tarefa RoboEstoque), não só ao ligar o PC.
' Motivo: em 11/09/2026 o robô morreu sozinho às 09:40 e ficou fora do ar até alguém
' perceber, porque o único gatilho era o logon. Como este .vbs manda o node pro fundo
' e termina na hora, o Windows achava que a tarefa tinha dado certo e nunca reiniciava.
' Agora ele acorda sempre — e a primeira coisa que faz é conferir se já tem robô de pé.

Dim shell, fso, pasta, caminhoGuardado, arqConfig, wmi, processos, p
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Já tem um robô rodando? Então não faz nada. Dois ao mesmo tempo brigariam pelas
' sessões do navegador em robo\sessoes (o Chrome não deixa dois abrirem o mesmo perfil).
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set processos = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
For Each p In processos
  If Not IsNull(p.CommandLine) Then
    If InStr(LCase(p.CommandLine), "worker.js") > 0 Then WScript.Quit 0
  End If
Next

' 1) o robô está ao lado deste arquivo?
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(fso.BuildPath(pasta, "worker.js")) Then
  ' 2) não está — então é a cópia na pasta Inicializar. Lê o caminho guardado.
  arqConfig = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "robo-caminho.txt")
  If fso.FileExists(arqConfig) Then
    pasta = fso.OpenTextFile(arqConfig, 1).ReadLine
  Else
    ' 3) último recurso: o caminho conhecido desta instalação
    pasta = "C:\Users\Dell\Downloads\sistema-estoque-real\robo"
  End If
End If

If Not fso.FileExists(fso.BuildPath(pasta, "worker.js")) Then
  MsgBox "Não encontrei o robô em:" & vbCrLf & pasta & vbCrLf & vbCrLf & _
         "A pasta do projeto foi movida? Veja RECUPERACAO.md.", 48, "Robô do Sistema de Estoque"
  WScript.Quit 1
End If

shell.CurrentDirectory = pasta
' O 0 é o que deixa a janela invisível. O False faz não esperar o programa terminar.
shell.Run "node worker.js", 0, False
