@echo off
REM Liga o robo do Sistema de Estoque. Dois cliques e pronto.
REM Usa caminho absoluto de proposito: assim o atalho funciona mesmo
REM copiado pra Area de Trabalho ou pra barra de tarefas.
title Robo do Sistema de Estoque
cd /d "C:\Users\Dell\Downloads\sistema-estoque-real\robo"
if not exist worker.js (
  echo Nao encontrei o robo em:
  echo   C:\Users\Dell\Downloads\sistema-estoque-real\robo
  echo A pasta do projeto foi movida? Avise o Claude.
  pause
  exit /b 1
)
node worker.js
echo.
echo O robo parou. Pode fechar esta janela.
pause
