@echo off
chcp 65001 >nul
title Ideia Cubica - Sistema de Gestao
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e execute novamente.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install
  if errorlevel 1 (
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)

echo Iniciando em http://localhost:5173  (feche esta janela ou pressione Ctrl+C para parar)
call npm run dev
pause
