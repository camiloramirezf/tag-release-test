@echo off
cls

call npm i

if [%1]==[] (call npm run test) else (call npm run %1)