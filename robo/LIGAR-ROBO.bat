@echo off
REM Atalho pra ligar o robo sem precisar mexer em terminal.
REM Basta dar dois cliques neste arquivo.
title Robo do Sistema de Estoque
cd /d "%~dp0"
node worker.js
echo.
echo O robo parou. Pode fechar esta janela.
pause
