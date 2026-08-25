' Liga o robô SEM janela nenhuma — não aparece na barra de tarefas.
'
' É este arquivo que vai na pasta de Inicializar do Windows, pra o robô subir
' sozinho quando o Matheus entra no computador e ficar invisível.
'
' Para PARAR o robô: use o botão "Parar robô" no sistema (aba Anúncios).
' Ele avisa o robô pelo banco de dados, sem precisar mexer aqui.

Dim shell, pasta
pasta = "C:\Users\Dell\Downloads\sistema-estoque-real\robo"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = pasta

' O 0 é o que deixa a janela invisível. O False faz não esperar o programa terminar.
shell.Run "node worker.js", 0, False
