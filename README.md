# Anbelo Ponto

Sistema de controle de ponto para a Anbelo, baseado em Next.js + Supabase.

## Requisitos

- Node.js 20+
- npm ou pnpm
- Conta no Supabase

## Instalação

1. Copie .env.example para .env.local
2. Configure as variáveis do Supabase
3. Instale as dependências

```bash
npm install
```

4. Inicie o ambiente

```bash
npm run dev
```

## Estrutura principal

- app/: páginas do Next.js
- components/: componentes visuais
- lib/: clientes e utilitários
- supabase/schema.sql: esquema do banco

## Variáveis de ambiente

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

> Em projetos mais recentes do Supabase, a chave pública pode aparecer como `publishable key`. O app aceita tanto `NEXT_PUBLIC_SUPABASE_ANON_KEY` quanto `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

## Configuração do banco

No Supabase, abra **SQL Editor → New query** e execute primeiro `supabase/schema.sql`.
Em seguida, execute `supabase/secure_rls.sql` para instalar as políticas de acesso por empresa, as funções de marcação/revisão e a criação segura de funcionários com conta vinculada.
Se já executou `secure_rls.sql` antes, execute-o novamente após atualizar o arquivo para instalar essas funções atualizadas.

O perfil autenticado precisa ter `company_id` preenchido e `role` igual a `admin` ou `gestor` para usar o painel.
O navegador usa a chave pública (anon/publishable) com a sessão do usuário e as políticas RLS. O endpoint de login por nome precisa da chave `service_role` exclusivamente no servidor para resolver o nome para o usuário Auth; a chave nunca é enviada ao navegador.
Configure `SUPABASE_SERVICE_ROLE_KEY` em `.env.local` e no ambiente privado de produção. Nunca use o prefixo `NEXT_PUBLIC_` nessa variável, não a compartilhe e não a coloque no código cliente.

## Funcionalidades conectadas

- Login e sessão via Supabase Auth
- Listagem e cadastro de funcionários em `employees`
- Código sequencial automático e único para cada funcionário
- Criação/consulta de departamentos em `departments`
- Registro e consulta de marcações em `attendance_records`
- Revisão de marcações pendentes com auditoria
- Consulta de marcações por período e funcionário, com exportação CSV
- Arquivamento/restauração de funcionários sem apagar o histórico de ponto
- Captura GPS pontual durante a marcação própria do funcionário
- Isolamento por empresa e autorização por função via RLS

## Acesso do funcionário

Ao cadastrar um funcionário em **Funcionários**, informe o e-mail e a senha inicial. O sistema cria a conta no Supabase Auth, cadastra o funcionário, cria o perfil `funcionario`, atribui um código de registro `ANB-000001` e vincula tudo automaticamente. O código é sequencial e único no sistema. O e-mail é necessário internamente para a conta Supabase; o funcionário entra usando o nome cadastrado e a senha. Entregue a senha inicial ao funcionário de forma privada.

Cadastros antigos sem conta podem continuar usando **Vincular login** após criar sua conta em **Authentication → Users**. O funcionário verá apenas **Meu ponto**. A função `record_own_attendance` registra o horário do servidor, aplica a sequência diária de quatro marcações e não aceita horário enviado pelo navegador. Marcações rejeitadas aparecem no histórico, mas não avançam a sequência; o funcionário pode refazer aquela etapa.

Se o funcionário esquecer a senha, um administrador ou gestor pode abrir **Funcionários → Redefinir senha**, definir uma senha temporária e entregá-la em particular. A alteração é registrada na auditoria; por segurança, a senha não é exibida novamente nem enviada por e-mail.

Para remover um funcionário da equipe ativa sem perder o histórico, use **Arquivar funcionário**. O acesso vinculado é desativado e as marcações são preservadas para relatórios. Um funcionário arquivado pode ser restaurado pela mesma tela; isso reativa o perfil de acesso.

O formulário de entrada solicita apenas o nome cadastrado em `profiles.nome` e a senha. O servidor converte o nome para a conta Auth sem devolver o e-mail ao navegador. Cada nome de perfil precisa identificar uma única conta ativa; nomes duplicados impedem o login por nome. O limite de tentativas do endpoint deve ser complementado por rate limiting persistente no proxy/plataforma de produção.

A localização usa a permissão de geolocalização do navegador somente no momento em que o funcionário registra o ponto; latitude, longitude e precisão estimada são salvas com a marcação e podem ser abertas no mapa. Não há rastreamento em segundo plano. O navegador exige HTTPS para geolocalização fora de `localhost`. Coordenadas são fornecidas pelo dispositivo e não são prova infalível de presença. O sistema não implementa reconhecimento facial nem armazena imagens faciais; autenticação continua pelo Supabase Auth.
