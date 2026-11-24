# Colaboradores PJ: como publicar

Este guia liga o controle de colaboradores PJ da portaria e o módulo **Hora Extra PJ** do portal de gestão. Leva cerca de 20 minutos e é feito uma única vez. Não há valor real nem endereço de planilha neste arquivo: o repositório é público.

## O que existe
- **Backend:** `apps-script/ColaboradoresPJ.gs`, num Apps Script próprio, com uma planilha de controle **separada** da planilha de veículos.
- **Portaria** (`index.html`): cards com foto, entrada e saída com um toque, lançamento de socorro pelo supervisor.
- **Portal** (repositório `renovatruck_portal`): módulo Hora Extra PJ, só admin.
- A planilha do RH (RENOVA 360) **só é lida**, nunca alterada. Dela saem apenas código, nome, cargo, departamento, horário e situação. CPF, salário, CNPJ e telefone nunca saem do servidor.

## Antes de começar
1. A conta Google que vai publicar precisa **enxergar** a planilha do RH e a pasta de fotos (pelo menos como leitor). É essa conta que o script usa.
2. Confira na aba `colaboradores e PJ` do RH: quem foi desligado está como **Demitido**. Quem não estiver Ativo fica de fora da portaria sozinho.
3. Peça ao RH para atualizar na aba `valores automáticos` os três valores de socorro, que ainda podem estar com os antigos. Os valores vigentes são os do comunicado aos PJ.

## Passo a passo

### 1. Criar a planilha de controle
1. No Google Drive da empresa, crie uma planilha nova e chame de **Controle PJ Portaria**.
2. **Extensões → Apps Script**. Apague o código de exemplo e cole o conteúdo de `ColaboradoresPJ.gs`. Salve.
3. Volte à planilha e recarregue a página. Aparece o menu **Renova PJ**.

### 2. Instalar
1. **Renova PJ → Instalar / verificar**. Autorize o acesso quando o Google pedir (planilhas, Drive e acesso externo).
2. Cole o link da **planilha do RH** quando pedir.
3. Cole o link da **pasta de fotos** (pode cancelar e preencher depois na aba `Config`).
4. A janela final mostra quantos colaboradores vão para a portaria, quem ficou de fora e **a senha da portaria**. Anote a senha. Ela é a mesma para o porteiro e para o supervisor. Para trocar, edite `senha_portaria` na aba `Config`. Trocar derruba os aparelhos já logados.

A instalação cria as abas `Registros`, `Config`, `Pessoas`, `HoraExtra`, `Feriados`, `Auditoria` e `Socorros`. Pode rodar de novo quantas vezes quiser: nunca apaga registro nem sobrescreve o que foi preenchido.

### 3. Publicar como aplicativo da Web
1. No Apps Script: **Implantar → Nova implantação → App da Web**.
2. **Executar como: Eu.** **Quem tem acesso: Qualquer pessoa.** (A proteção é a senha da portaria e a sessão do portal; sem elas nenhuma ação funciona.)
3. Copie a URL que termina em `/exec`.

### 4. Ligar a portaria
1. No `index.html` da portaria, em `CONFIG`, troque o valor de `PJ_API_URL` pela URL `/exec`.
2. Publique a portaria (ver "Publicação" abaixo).

### 5. Ligar o portal de gestão
1. No repositório do portal, em `js/core.js`, preencha `PJ_API` com a mesma URL `/exec`.
2. Troque `VERSAO_PORTAL` em `js/router.js` (qualquer valor novo), senão alguém pode receber a tela nova com o script antigo.
3. Publique o portal.

### 6. Conferir
- Na portaria, entre com a senha, abra **Colaboradores PJ** e confira os cards e as fotos.
- No portal, abra **Hora Extra PJ** com um usuário administrador.
- Faça uma entrada e uma saída de teste e confira no portal. Depois, se foi só teste, cancele o registro pelo detalhe do colaborador (com motivo).

## Regras em vigor (aba `Config`)
Tudo abaixo muda na aba `Config`, sem mexer em código.

| O quê | Regra atual |
|---|---|
| Horário da unidade (Jacareí) | Segunda a sexta 08h às 17h, sábado 08h às 12h. O intervalo de 1h é presumido: o comunicado não o cita. Vale para todos da portaria (`jornada_unidade` e `jornada_unidade_prevalece`) |
| Hora extra | R$ 25/h de segunda a sábado e R$ 35/h em domingo e feriado |
| Tolerância | 10 minutos. Até aqui não conta hora extra nem atraso |
| Socorro | Atividade extra paga por atendimento, não é hora extra. A faixa vem da hora do **fim**: até as 22h, depois das 22h, domingo e feriado |
| Socorro e hora extra | Não somam: durante o atendimento só vale o socorro. A hora extra fora do atendimento continua |
| Madrugada | Socorro que termina de madrugada (até as 06h, segunda a sábado) vale a faixa da noite. **Confirmar com o RH** (`socorro_madrugada_ate`) |
| Fora da portaria por decisão da gestão | Lista em `codigos_excluidos`. Quem for marcado "Incluir" na aba `Pessoas` volta |
| Aprovação | A hora extra só entra no fechamento depois de aprovada pelo RH (`exige_aprovacao`) |

Quem fica de fora automaticamente: desligados, híbridos, CLT e códigos que começam com `PRO_` (pró-labore).

## Socorro na portaria
O supervisor usa a seção **Socorros**, no mural de Colaboradores PJ: escolhe o colaborador, o dia em que terminou, início e fim. Precisa de internet. O lançamento pode ser desfeito pela portaria nas primeiras 24 horas e pelo RH a qualquer momento, sempre com registro na aba `Auditoria`.

## Publicação da portaria
A portaria é servida pelo **Netlify**, não pelo GitHub Pages do portal. Antes do primeiro deploy, confira no painel do Netlify de qual branch ele publica. Se for a `main`, o código só vai ao ar depois que a branch `colaboradores-pj` for mesclada na `main`.

Esta versão também mudou o `Codigo.gs` (veículos): o antigo "Conjunto" vira dois registros e a mesma placa não entra duas vezes no pátio. Para valer, publique uma **nova versão** da implantação já existente do script de veículos (Implantar → Gerenciar implantações → Editar → Nova versão). A URL não muda.

## Se algo der errado
- **"O backend ainda não foi instalado":** abra a planilha de controle e rode **Renova PJ → Instalar / verificar**.
- **"Não consegui abrir a planilha do RH":** a conta que publicou o script não tem acesso a ela. Compartilhe como leitora.
- **Lista de colaboradores desatualizada:** a lista do RH fica em cache por 10 minutos. Use **Renova PJ → Reler a lista do RH e as fotos agora**.
- **Colaborador sem foto:** o nome do arquivo precisa conter o nome da pessoa (ex.: `FOTO ANA.jpeg`). Se mesmo assim não casar, informe o arquivo na coluna `foto` da aba `Pessoas`.
- **Alguém sem horário reconhecido:** o diagnóstico da instalação avisa. Ajuste o horário na aba `Pessoas`.
- **Mudou o código do `.gs`:** cole o novo código, salve e publique uma **nova versão** da implantação (Implantar → Gerenciar implantações → Editar → Nova versão). Criar "Nova implantação" gera outra URL e quebra a ligação.
- **Sessão do portal expirada na tela Hora Extra PJ:** saia do portal e entre de novo.

## Testes (para quem mexer no código)
Rode antes de qualquer mudança no backend ou nas telas:

```
node ferramentas/testar-motor-pj.js
node ferramentas/testar-backend-pj.js
node ferramentas/testar-portaria-navegador.js     (precisa do puppeteer-core, instalado fora do repositório)
```

No repositório do portal: `node ferramentas/testar-horaextra.js`.
