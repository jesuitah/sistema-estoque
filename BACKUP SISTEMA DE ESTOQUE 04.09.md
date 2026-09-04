# BACKUP SISTEMA DE ESTOQUE — 04.09

> **Este é o único documento de recuperação do sistema.** Se algo der errado, comece aqui.
>
> Ele existe para que o sistema possa ser reconstruído sem depender de ninguém lembrar
> de nada — nem do Matheus, nem de nenhuma conversa com o Claude.
>
> Versão marcada no GitHub: **`versao-estavel-2026-09-04`**

---

## 1. Resumo tranquilizador

**Nada insubstituível vive no PC.** Se ele queimar hoje, você reconstrói tudo em cerca
de 20 minutos num computador novo.

Os dados de verdade — estoque, preços, pedidos, promoções, fretes — estão no **Supabase**
(nuvem). O programa está no **GitHub**. O que fica só no PC é a sessão de navegador de
cada loja (refazer login: 2 min por loja) e as bibliotecas (voltam com um comando).

**Endereço do sistema publicado:** https://jesuitah.github.io/sistema-estoque/

---

## 2. Onde está cada coisa

| O quê | Onde vive | Some se o PC queimar? |
|---|---|---|
| O site (`index.html`) | GitHub · `jesuitah/sistema-estoque` | não |
| Programas do robô (`robo/`) | GitHub, mesmo repositório | não |
| Documentação (este arquivo, `PLANO-ROBO.md`) | GitHub | não |
| Banco de dados (estoque, preços, pedidos, promoções…) | Supabase, projeto `pylkufhziohxvwbbaued` | não |
| Funções de servidor (Edge Functions) | Supabase | não |
| Migrações do banco | Supabase (histórico de migrations) | não |
| Sessões do navegador (`robo/sessoes/`) | **só no PC** | **sim** — refaz com login, 2 min por loja |
| Bibliotecas (`node_modules/`) | **só no PC** | **sim** — volta com `npm install` |

---

## 3. Contas e acessos — guarde fora do PC

Se perder o acesso a estes, **aí sim é problema sério**. Guarde num gerenciador de senhas.

1. **GitHub** — usuário `jesuitah`, repositório `sistema-estoque`
2. **Supabase** — projeto `pylkufhziohxvwbbaued`
3. **Mercado Livre** — as três contas (KMP, ERP, LTS)
4. **App do Mercado Livre** — "SistemaEstoque13.07", Client ID `8456589547594572`
   O segredo fica nos Edge Function Secrets do Supabase (`ML_CLIENT_ID` / `ML_CLIENT_SECRET`)

### As três lojas

| conta | apelido no ML | user id |
|---|---|---|
| KMP | KARMAPECDISTRIBUIDORA | 422927430 |
| ERP | ERUPCAOAUTOPARTS | 1639940717 |
| LTS | MJLEMOSCOMERCIODEPECAS | 712625474 |

O script de login recusa sozinho se o apelido não bater — é uma trava proposital contra
logar na conta errada.

---

## 4. Reconstruir num computador novo — passo a passo

### 4.1. Instalar o Node.js
Baixe em https://nodejs.org (versão **LTS**). É o que roda o robô.

### 4.2. Baixar o projeto
```
git clone https://github.com/jesuitah/sistema-estoque.git
```
Sem git: no GitHub, botão verde **Code → Download ZIP**, e descompacte.

Para voltar exatamente a esta versão:
```
git checkout versao-estavel-2026-09-04
```

### 4.3. Instalar as bibliotecas
```
cd sistema-estoque\robo
npm install
npx playwright install chromium
```

### 4.4. Fazer login nas três lojas
```
npm run login -- KMP
npm run login -- ERP
npm run login -- LTS
```
Abre um Chrome de verdade; você loga na mão. **O robô nunca vê a senha** — ele só reusa
a sessão depois.

### 4.5. Conferir que funcionou
```
npm run testar -- KMP
```
Tem que dizer **"✅ Autenticado"**.

### 4.6. Ligar o robô automaticamente
O robô roda como **Tarefa Agendada do Windows**, chamada `RoboEstoque`, que executa
`robo\robo-invisivel.vbs` (que por sua vez roda `worker.js` sem abrir janela).

Para recriar num PC novo: Agendador de Tarefas → Criar Tarefa → ação
`wscript.exe "C:\caminho\do\projeto\robo\robo-invisivel.vbs"`, gatilho "ao fazer logon".

**Importante:** o `.vbs` tem o caminho da pasta escrito dentro dele. Se o projeto ficar
em outro lugar, abra no bloco de notas e corrija a linha `pasta = "..."`.

### 4.7. Impedir que o PC durma
```
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```
O robô só trabalha com o PC ligado. Ao sair, use **Windows + L** — nunca "Suspender".

---

## 5. Operar o robô no dia a dia

### Reiniciar o robô
**Necessário sempre que os arquivos da pasta `robo/` forem alterados** — o Node lê o
código uma vez e guarda na memória; editar o arquivo não muda o robô que já está rodando.

Pelo mouse: Agendador de Tarefas → `RoboEstoque` → botão direito → **Finalizar**, depois
botão direito → **Executar**.

Pelo terminal:
```
wmic process where "name='node.exe' and commandline like '%worker.js%'" call terminate
schtasks /run /tn "RoboEstoque"
```

### Saber se ele está vivo
A aba **Robô** no sistema mostra a batida. No banco: tabela `robo_status`, campo
`ultima_batida` — se está a menos de 2 minutos, está vivo.

### Botão de pânico
`robo_status.parar = true` faz o robô parar de pegar tarefas. Ele continua vivo, só
não trabalha.

---

## 6. Backup dos dados

### 6.1. O pacote completo (recomendado)
```
cd caminho\do\projeto\robo
node gerar-backup.js
```
Cria no Desktop a pasta `BACKUP-Sistema-Estoque-AAAA-MM-DD` com:
- `programa\` — site, robô e documentação inteiros
- `dados-AAAA-MM-DD.xlsx` — o banco todo, uma aba por tabela
- `LEIA-ME.txt` — instruções

Para gravar direto no pen drive:
```
node gerar-backup.js "E:\"
```

**Não entram de propósito:** sessões de login e chaves de acesso. Se o pen drive se
perder, quem achar não entra nas suas contas.

### 6.2. Backup rápido pelo próprio sistema
Botão **🛟 Backup** no topo do site. Baixa um Excel com as tabelas principais.

### 6.3. Backup automático do Supabase
A plataforma faz o dela. Confira em supabase.com → projeto → Database → Backups.

### 6.4. Tabelas no banco (04/09/2026)

| tabela | linhas | o que guarda |
|---|---|---|
| `precos` | ~4.970 | custo por SKU |
| `ml_promocoes_itens` | ~4.785 | promoções, preço cheio, desconto, frete e tarifa |
| `ml_anuncios` | ~3.400 | anúncios das 3 contas |
| `estoque` | ~3.080 | unidades por SKU |
| `ml_pedidos` | ~3.040 | pedidos vindos da API |
| `ml_fretes` | ~2.840 | custo de frete coletado das vendas |
| `ml_log_acoes` | ~1.730 | histórico do que o robô fez |
| `ml_frete_anuncio` | ~1.050 | frete oficial por anúncio |
| `ml_tarifas` | 380 | tabela oficial de tarifa por categoria e faixa de preço |
| `ml_tarefas_robo` | ~370 | fila de tarefas |
| `ml_patrulha_full` | ~120 | anúncios fora de venda em acompanhamento |
| `kanban_*` | — | a aba Tarefas |
| `markup_marcas` | 9 | markup por marca |
| `robo_alertas` | — | o que o robô encontrou de errado |

---

## 7. Se a conversa com o Claude se perder

Todo o conhecimento do projeto está **escrito**, não só na conversa:

- **`PLANO-ROBO.md`** — como o robô funciona, as chamadas do Mercado Livre que
  descobrimos, e as armadilhas técnicas já resolvidas (para não repetir)
- **Este arquivo** — como reconstruir e como operar
- **Comentários no código** — cada decisão não óbvia está explicada onde ela mora,
  incluindo o *porquê* e o erro que ela evita

Ao abrir uma conversa nova, aponte o Claude para estes arquivos. Ele retoma dali.

---

## 8. Perguntas rápidas

**Posso rodar o robô em dois computadores?**
Só com ajuste antes. Hoje dois robôs fariam a patrulha em duplicidade. A fila de tarefas
já é protegida contra isso, mas a patrulha não. Avise antes de instalar num segundo PC.

**Preciso deixar o site aberto pro robô funcionar?**
Não. O robô é independente. O site só enfileira pedidos.

**Se o PC ficar desligado, perco alguma coisa?**
Não. As tarefas esperam na fila e a patrulha retoma quando ligar. Perde-se só o tempo
em que ficou parado.

**A sessão do navegador expira?**
Sim, eventualmente. Quando acontecer, `npm run testar -- <conta>` acusa **"DESLOGADA"**
e basta refazer o login (2 minutos).

**Por que só existe este arquivo de recuperação?**
Porque ter dois documentos parecidos é pior do que ter um: sempre sobra a dúvida de qual
está certo. Em 04/09/2026 o `RECUPERACAO.md` e a cópia dele no Desktop foram apagados de
propósito, e tudo o que eles tinham está aqui.

---

## 9. Pendência conhecida de segurança

O banco hoje é acessado pela **chave pública (anon key)**, sem RLS — quem tiver o
endereço do site consegue ler e escrever nas tabelas. Isso foi uma decisão consciente
para o sistema andar rápido, e **precisa ser revisto antes de entrarem dados de
clientes** (nome, conversa, financeiro).

Não é urgente hoje. Passa a ser no dia em que o sistema guardar dado de terceiro.
