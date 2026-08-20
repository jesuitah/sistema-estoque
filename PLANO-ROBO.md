# Projeto Robô — automação do que a API do Mercado Livre não faz

> Documento vivo. Atualizar ao fim de cada fase.
> Criado em 2026-07-31.

## Por que existe

Algumas ações importantes não têm endpoint na API oficial do ML — a mais urgente é
**tirar um anúncio do programa Full** (necessária pra reativar anúncios Full que têm
estoque físico). Hoje isso é feito na mão, um por um, pelo site do ML.

O objetivo é ter um executor local capaz de fazer essas ações, e qualquer outra que
apareça no futuro sem API.

## Princípios inegociáveis (definidos pelo Matheus)

1. **O sistema atual não pode quebrar.** Nada do que existe hoje é modificado até o robô
   estar provado. Ponto de restauração: tag `versao-estavel-2026-07-31-antes-do-robo`.
2. **O robô nunca chuta.** Se a tela não for exatamente o esperado, ele PARA e avisa.
   Nunca clica em "algo parecido", nunca tenta de novo às cegas.
3. **Fatos, não suposições.** Toda ação é confirmada depois pela API oficial. O robô não
   diz "deu certo" — ele prova que deu.
4. **Uma fase por vez.** Só avança quando a anterior estiver funcionando de verdade.
5. **Roda no PC do Matheus.** Nada de PC da expedição, nada de nuvem.
6. **Começa com uma conta** (KMP), expande depois.

## Decisão de arquitetura: sessão emprestada, não login automatizado

O robô **nunca faz login e nunca vê a senha**.

O Matheus loga uma vez, na mão, num navegador de verdade controlado pelo Playwright.
A sessão logada (cookies + localStorage) é salva em disco. O robô reusa essa sessão
por semanas. Quando expirar, o sistema avisa e ele refaz o login manual em 2 minutos.

Isso elimina de saída:
- Senha armazenada em qualquer lugar (não existe)
- Captcha de login (quem logou foi humano)
- Detecção de login robótico (não há login robótico)

Rodando do PC do Matheus, do IP de sempre, em horário comercial, a sessão é
indistinguível de uso normal.

---

## FASE 0 — Rede de segurança ✅ CONCLUÍDA

**Objetivo:** poder voltar ao estado de hoje a qualquer momento.

- [x] Tag git `versao-estavel-2026-07-31-antes-do-robo` criada e enviada
- [x] Versões das Edge Functions registradas (abaixo)
- [x] Este documento

**Baseline das Edge Functions em 2026-07-31** (nenhuma será modificada pelo projeto do robô):

| função | versão |
|---|---|
| ml-oauth | 11 |
| ml-oauth-init | 6 |
| ml-pedidos | 13 |
| ml-etiqueta | 5 |
| ml-sincronizar-anuncios | 3 |
| ml-clonar-anuncio | 1 |
| ml-reativar-anuncios | 5 |
| ml-criar-anuncio | 6 |

**Como voltar atrás, se precisar:**
```bash
git checkout versao-estavel-2026-07-31-antes-do-robo
```
O robô vive numa pasta separada (`robo/`) e não é servido pelo GitHub Pages — apagar a
pasta já desfaz tudo do lado do site.

---

## FASE 1 — Provar que a sessão emprestada funciona (risco zero)

**A pergunta que essa fase responde:** dá pra reusar uma sessão logada, sem login
automatizado, e navegar pelo painel do ML como se fosse o Matheus?

**Por que vem primeiro:** é a única suposição realmente arriscada do projeto inteiro. Se
falhar, falha aqui, barato, sem ter mexido em nada.

**Por que é risco zero:** essa fase **não clica em nada que muda estado**. Só lê.

Passos:
1. Instalar Node + Playwright na pasta `robo/` (isolado, não mexe no site)
2. `npm run login -- KMP` → abre um Chrome de verdade, Matheus loga na mão,
   fecha o navegador, sessão fica salva em `robo/sessoes/KMP.json`
3. `npm run testar -- KMP` → abre com a sessão salva, navega até a página de estoque
   Full e **lê** os dados na tela. Não clica em nada.
4. Sucesso = os dados aparecem. Falha = descobrimos cedo e barato.

**Critério de aprovação:** rodar o passo 3 duas vezes em dias diferentes e funcionar
nas duas. Isso prova que a sessão dura.

### Situação em 2026-08-20 — primeira metade APROVADA ✅

Login manual da **KMP** concluído e sessão reutilizada com sucesso: `npm run testar -- KMP`
abriu a Central de Vendedores logada como **KARMAPEC**, com os 1.514 anúncios carregados
(print em `robo/prints/`). A premissa central do projeto — reusar sessão sem automatizar
login — **está provada**.

Falta só repetir o teste daqui a alguns dias pra confirmar que a sessão DURA. Aí a
Fase 1 fecha e vamos pra Fase 2.

Descoberta útil pra Fase 2: a área que precisamos fica em **"Gestão de estoque Full"**,
uma das abas da própria tela de Anúncios da Central de Vendedores.

### Aprendizados técnicos (medidos, não supostos) — 2026-08-04

Três armadilhas descobertas testando. Estão comentadas no código pra não voltarem:

1. **`api.mercadolibre.com/users/me` não serve pra saber quem está logado.** Com cookies
   de navegador responde `403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES` — aquele endpoint só
   aceita token OAuth. Foi o primeiro detector, estava quebrado desde o início.

2. **Status HTTP sozinho dá FALSO POSITIVO.** Deslogado, o ML redireciona pra tela de
   login, e a tela de login responde `200`. O detector dizia "autenticado" enquanto o
   navegador exibia o formulário de senha. O sinal correto é a **URL final** depois dos
   redirecionamentos (a tela de login usa o caminho `/lgz/`).

3. **Modo invisível (headless) é bloqueado pelo firewall do ML.** Devolve página vazia,
   sem redirecionar — indistinguível de erro. Também não usar `contexto.request.get()`:
   requisição crua não carrega a impressão digital do navegador e o firewall responde de
   forma inconsistente (ora 403, ora redireciona, com o mesmo estado de sessão).

4. **Logado, o ML TROCA DE DOMÍNIO.** `www.mercadolivre.com.br/anuncios/lista` redireciona
   pra `vendedores.mercadolivre.com.br/anuncios` (Central de Vendedores). Procurar pelo
   caminho `/anuncios/lista` nunca batia — o login funcionava e passava despercebido.
   O sinal positivo certo é o **domínio** `vendedores.mercadolivre.com.br`, que só é
   alcançável autenticado.

5. **Nunca abrir abas enquanto o usuário digita a senha.** A primeira versão do laço de
   espera abria uma aba de verificação a cada 2 segundos; isso rouba o foco do teclado e
   inviabiliza o login (aconteceu de verdade). Agora o script só OBSERVA a URL das abas
   existentes — zero abas novas, zero requisições, durante todo o login.

**Detector correto e validado:** navegador **visível**, navegação de verdade até
`mercadolivre.com.br/anuncios/lista`, e então:
- URL final contém `/lgz/` ou `/login` → **deslogado**
- Título vazio e sem redirecionamento → **inconclusivo** (bloqueio do firewall) — não se
  conclui nada, tenta de novo
- Caso contrário → **logado**

Vive em `robo/navegador.js`, função `verificarLogin()`, usada pelos dois scripts.

---

## FASE 2 — Primeira ação real, com você assistindo

**Objetivo:** tirar UM anúncio do Full, com o navegador visível na tela.

- Navegador abre visível (`headless: false`) — Matheus assiste tudo acontecer
- Antes de clicar: print da tela salvo
- Depois de clicar: print da tela salvo
- **Confirmação por fora:** o robô consulta a API oficial do ML e verifica que o
  `logistic_type` do anúncio realmente mudou. Só então declara sucesso.
- Se qualquer elemento esperado não existir exatamente: para, salva print, avisa.

**Modo assistido (padrão nesta fase):** o robô navega, tira o print, e **pergunta antes
de clicar**. Matheus vê o print e aprova. Só depois de confiar é que liga o automático.

**Critério de aprovação:** 3 anúncios tirados do Full com sucesso, confirmados pela API.

---

## FASE 3 — Fila de tarefas + robô trabalhador

**Objetivo:** desacoplar. O site nunca fala com o navegador — só escreve numa fila.

```
Site / Cron  →  tabela ml_tarefas_robo  →  Robô (PC do Matheus)  →  Mercado Livre
   enfileira                                  desenfileira, faz,
                                              confirma pela API
```

Tabela `ml_tarefas_robo`:
- `id`, `conta`, `tipo` (ex: `tirar_do_full`), `params` (jsonb), `status`
  (`pendente` / `rodando` / `feito` / `falhou` / `aguardando_aprovacao`)
- `resultado` (jsonb), `erro` (text), `print_antes`, `print_depois`
- `criado_em`, `executado_em`, `tentativas`

Robô:
- Roda como processo no PC do Matheus (atalho na inicialização do Windows)
- Consulta a fila a cada N segundos, pega UMA tarefa por vez
- Pausas aleatórias entre ações — ritmo humano, nunca rajada
- Só horário comercial
- Envia sinal de vida pra tabela `robo_status` a cada minuto

Site:
- Indicador 🟢/🔴 mostrando se o robô está vivo e se a sessão está válida
- Aviso grande "reconectar conta X" quando a sessão expirar
- **Botão de pânico**: flag no banco que para o robô na hora, de qualquer lugar

**Vantagem do desenho:** PC desligado não perde tarefa nenhuma — ela espera na fila e
roda quando ligar.

---

## FASE 4 — Ligar no que já existe

A sub-aba "📦 Reativar sem estoque" já mostra uma lista **"precisa ação manual"** com os
anúncios Full que têm estoque físico. Hoje cada item tem um link pro ML.

Passa a ter também um botão **"mandar pro robô"** — que só enfileira a tarefa.

O Matheus continua revisando um por um, como sempre quis. Só troca "abrir o link e
clicar" por "clicar em enfileirar".

---

## FASE 5 — Expandir o catálogo de tarefas

Com a infra pronta, tarefa nova = só um handler novo no robô. O resto do sistema nem
fica sabendo.

**Ideia pra facilitar manutenção:** em vez de eu adivinhar como é a tela, o Matheus
grava uma vez fazendo a ação na mão (`npx playwright codegen`), me manda o resultado, e
eu transformo numa tarefa do robô. Também é assim que a gente conserta rápido quando o
ML mudar a interface.

Candidatos futuros (a definir conforme necessidade):
- Devolver anúncio pro Full
- Ações de promoção / campanha
- Qualquer coisa que aparecer sem API

---

## Riscos conhecidos e como são tratados

| risco | tratamento |
|---|---|
| ML muda a interface | Robô falha alto e avisa. Nunca clica errado. Conserta com codegen. |
| Sessão expira | Sistema avisa, Matheus refaz login manual em 2 min. |
| Detecção de automação | IP de sempre, ritmo humano, volume baixo, horário comercial. |
| Ação dá errado silenciosamente | Impossível: toda ação é confirmada pela API oficial depois. |
| Robô sai do controle | Botão de pânico + uma tarefa por vez + começa com volume baixo. |

**Aceito conscientemente:** automatizar a operação da própria conta de vendedor é prática
comum, mas não é oficialmente abençoado pelo ML. No volume real da operação, do próprio
IP, o risco prático é baixo — mas existe.
