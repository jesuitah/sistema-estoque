# Como recuperar tudo — do zero, em qualquer computador

> Escrito em 2026-08-26. **Se algo der errado, comece por aqui.**
>
> Este documento existe pra que o sistema possa ser reconstruído sem depender de
> ninguém lembrar de nada — nem do Matheus, nem de nenhuma conversa anterior.

---

## Resumo tranquilizador

**Nada insubstituível vive no PC.** Se ele queimar hoje, você reconstrói tudo em
cerca de 20 minutos num computador novo. Os dados de verdade — estoque, preços,
pedidos, tarefas — estão no Supabase (nuvem). O programa está no GitHub.

O que fica no PC é só: as sessões de navegador (refazer login leva 2 min por loja)
e as bibliotecas (baixadas com um comando).

---

## Onde está cada coisa

| O quê | Onde vive | Some se o PC queimar? |
|---|---|---|
| O site (`index.html`) | GitHub · `jesuitah/sistema-estoque` | não |
| Programas do robô (`robo/`) | GitHub, mesmo repositório | não |
| Documentação (este arquivo, `PLANO-ROBO.md`) | GitHub | não |
| Banco de dados (estoque, preços, pedidos…) | Supabase, projeto `pylkufhziohxvwbbaued` | não |
| Funções de servidor (Edge Functions) | Supabase | não |
| Sessões do navegador (`robo/sessoes/`) | só no PC | **sim** — mas refaz com login, 2 min por loja |
| Bibliotecas (`node_modules/`) | só no PC | **sim** — mas volta com `npm install` |

**O endereço do site publicado:** https://jesuitah.github.io/sistema-estoque/

---

## Passo a passo: reconstruir num computador novo

### 1. Instalar o Node.js
Baixe em https://nodejs.org (versão LTS). É o que roda o robô.

### 2. Baixar o projeto
```
git clone https://github.com/jesuitah/sistema-estoque.git
```
Se preferir sem git: no GitHub, botão verde **Code → Download ZIP**, e descompacte.

### 3. Instalar as bibliotecas
```
cd sistema-estoque\robo
npm install
npx playwright install chromium
```

### 4. Fazer login nas três lojas
```
npm run login -- KMP
npm run login -- ERP
npm run login -- LTS
```
Abre um Chrome de verdade; você loga na mão. O robô **nunca vê a senha** — ele só
reusa a sessão depois. Confira o apelido que ele mostra ao final:

| conta | apelido esperado | id |
|---|---|---|
| KMP | KARMAPECDISTRIBUIDORA | 422927430 |
| ERP | ERUPCAOAUTOPARTS | 1639940717 |
| LTS | MJLEMOSCOMERCIODEPECAS | 712625474 |

Se o apelido não bater, o script recusa sozinho — é uma trava proposital.

### 5. Conferir que funcionou
```
npm run testar -- KMP
```
Tem que dizer "✅ Autenticado".

### 6. Ligar o robô automaticamente
Copie `robo\robo-invisivel.vbs` para a pasta de Inicializar do Windows:
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```
**Importante:** o arquivo tem o caminho da pasta escrito dentro dele. Se o projeto
ficar em outro lugar, abra o `.vbs` no bloco de notas e corrija a linha `pasta = "..."`.

### 7. Impedir que o PC durma
```
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```
O robô só trabalha com o PC ligado. Ao sair, use **Windows + L** (bloqueia a tela e
mantém tudo rodando) — nunca "Suspender".

---

## Contas e acessos que você precisa ter

Se perder o acesso a estes, aí sim é problema sério. Guarde as credenciais fora do PC:

1. **GitHub** — usuário `jesuitah`, repositório `sistema-estoque`
2. **Supabase** — projeto `pylkufhziohxvwbbaued`
3. **Mercado Livre** — as três contas (KMP, ERP, LTS)
4. **App do Mercado Livre** — "SistemaEstoque13.07", Client ID `8456589547594572`.
   O segredo fica nos Edge Function Secrets do Supabase (`ML_CLIENT_ID` / `ML_CLIENT_SECRET`).

---

## Backup dos dados

O banco tem hoje cerca de 14 mil linhas nas tabelas que importam:

| tabela | linhas |
|---|---|
| precos | ~4.970 |
| ml_anuncios | ~3.390 |
| estoque | ~3.080 |
| ml_pedidos | ~2.610 |

**Backup manual:** no próprio sistema, botão **🛟 Backup** no topo. Baixa um Excel
com todas as tabelas principais. Vale rodar de vez em quando e guardar fora do PC
(e-mail, Google Drive, pen-drive).

**Backup do Supabase:** o projeto também tem os backups automáticos da própria
plataforma. Confira o plano em supabase.com → projeto → Database → Backups.

---

## Se a conversa com o Claude se perder

Todo o conhecimento do projeto está escrito, não só na conversa:

- **`PLANO-ROBO.md`** — como o robô funciona, as chamadas do Mercado Livre que
  descobrimos, e as armadilhas técnicas já resolvidas (pra não repetir)
- **Este arquivo** — como reconstruir
- **Comentários no código** — cada decisão não óbvia está explicada onde ela mora

Ao abrir uma conversa nova, aponte o Claude para estes arquivos. Ele retoma dali.

---

## Perguntas rápidas

**Posso rodar o robô em dois computadores?**
Só com ajuste antes. Hoje dois robôs fariam a patrulha em duplicidade. A fila de
tarefas já é protegida contra isso, mas a patrulha não. Avise antes de instalar
num segundo PC.

**Preciso deixar o site aberto pro robô funcionar?**
Não. O robô é independente. O site só enfileira pedidos.

**Se o PC ficar desligado, perco alguma coisa?**
Não. As tarefas esperam na fila e a patrulha retoma quando ligar. Perde-se só o
tempo em que ficou parado.

**A sessão do navegador expira?**
Sim, eventualmente. Quando isso acontecer, `npm run testar -- <conta>` acusa
"DESLOGADA" e basta refazer o login (2 minutos).
