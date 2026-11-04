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
FACE_TEMPLATE_ENCRYPTION_KEY=replace-with-64-hexadecimal-characters
```

> Em projetos mais recentes do Supabase, a chave pública pode aparecer como `publishable key`. O app aceita tanto `NEXT_PUBLIC_SUPABASE_ANON_KEY` quanto `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

Gere `FACE_TEMPLATE_ENCRYPTION_KEY` com um gerador criptograficamente seguro. No PowerShell, execute:

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[BitConverter]::ToString($bytes).Replace('-', '').ToLower()
$rng.Dispose()
```

Copie o resultado para `.env.local` e para as variáveis **Secret** do Vercel. A chave deve ter exatamente 64 caracteres hexadecimais, não pode ter o prefixo `NEXT_PUBLIC_` e não deve ser compartilhada ou versionada. A perda da chave torna os cadastros faciais existentes ilegíveis; ao trocar a chave, remova e recadastre os rostos.

## Configuração do banco

No Supabase, abra **SQL Editor → New query** e execute primeiro `supabase/schema.sql`.
Em seguida, execute `supabase/secure_rls.sql` para instalar as políticas de acesso por empresa, as funções de marcação/revisão e a criação segura de funcionários com conta vinculada.
Se já executou `secure_rls.sql` antes, execute-o novamente após atualizar o arquivo para instalar as tabelas e funções atualizadas, incluindo passkeys e reconhecimento facial.

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
- Login facial com marcação de ponto, até três tentativas e fallback para senha
- Cadastro e remoção de modelos faciais por administradores/gestores
- Marcação própria com passkey do aparelho como alternativa e marcação manual
- Isolamento por empresa e autorização por função via RLS

## Acesso do funcionário

Ao cadastrar um funcionário em **Funcionários**, informe o e-mail e a senha inicial. O sistema cria a conta no Supabase Auth, cadastra o funcionário, cria o perfil `funcionario`, atribui um código de registro `ANB-000001` e vincula tudo automaticamente. O código é sequencial e único no sistema. O e-mail é necessário internamente para a conta Supabase; o funcionário entra usando o nome cadastrado e a senha. Entregue a senha inicial ao funcionário de forma privada.

Cadastros antigos sem conta podem continuar usando **Vincular login** após criar sua conta em **Authentication → Users**. O funcionário verá apenas **Meu ponto**. A função `record_own_attendance` registra o horário do servidor, aplica a sequência diária de quatro marcações e não aceita horário enviado pelo navegador. Marcações rejeitadas aparecem no histórico, mas não avançam a sequência; o funcionário pode refazer aquela etapa.

Se o funcionário esquecer a senha, um administrador ou gestor pode abrir **Funcionários → Redefinir senha**, definir uma senha temporária e entregá-la em particular. A alteração é registrada na auditoria; por segurança, a senha não é exibida novamente nem enviada por e-mail.

Para remover um funcionário da equipe ativa sem perder o histórico, use **Arquivar funcionário**. O acesso vinculado é desativado e as marcações são preservadas para relatórios. Um funcionário arquivado pode ser restaurado pela mesma tela; isso reativa o perfil de acesso.

O acesso abre a câmera e apresenta **Bater Ponto**. Ao reconhecer um funcionário, a sessão é iniciada e o sistema registra a próxima marcação prevista do dia (entrada, saída para almoço, retorno ou saída), com GPS e revisão pendente. Se o rosto não for reconhecido três vezes, a câmera falhar ou a permissão for recusada, o sistema encerra a câmera e abre o login manual. O fallback aceita o nome, a matrícula ou o código de registro e a senha. O nome precisa identificar uma única conta ativa; nomes duplicados impedem o login por nome. O limite de tentativas no navegador é complementado por rate limiting temporário no endpoint; configure também proteção persistente no proxy/plataforma de produção para ambientes de maior risco.

A localização usa a permissão de geolocalização do navegador somente no momento em que o funcionário registra o ponto; latitude, longitude e precisão estimada são salvas com a marcação e podem ser abertas no mapa. Não há rastreamento em segundo plano. O navegador exige HTTPS para geolocalização fora de `localhost`. Coordenadas são fornecidas pelo dispositivo e não são prova infalível de presença.

### Reconhecimento facial

Antes de cadastrar um rosto, o administrador/gestor deve obter e guardar o consentimento escrito do funcionário conforme o procedimento da empresa. Em **Funcionários**, use **Cadastrar rosto** ou **Atualizar rosto** e mantenha somente o funcionário diante da câmera. O cadastro exige conta de acesso ativa e vinculada. Para revogar, use **Remover rosto**; arquivar o funcionário também apaga o modelo e os desafios faciais pendentes.

A detecção e a criação do modelo acontecem no navegador. Nenhuma foto ou vídeo é enviado ao servidor nem armazenado. O servidor recebe somente o descriptor numérico e guarda o template criptografado com AES-256-GCM; as tabelas `employee_face_templates` e `face_auth_challenges` não permitem acesso direto por `anon`/`authenticated` e são usadas pelas APIs do servidor. O modelo fica associado ao funcionário e à empresa. Não reutilize o template para outras finalidades.

O reconhecimento facial requer câmera e HTTPS em produção. A busca atual suporta até 5.000 modelos faciais; acima desse limite, o sistema interrompe a busca e orienta o uso do login manual. A marcação também requer permissão de localização GPS, como a marcação própria existente. Se o GPS for negado após a validação do rosto, a sessão será iniciada, mas o ponto não será gravado; abra **Meu ponto** para concluir manualmente. Os registros faciais ficam identificados como `web_face` em `attendance_records.source`.

O fluxo atual não tem detecção de vivacidade e pode ser enganado por uma foto ou vídeo apresentado à câmera. Portanto, o reconhecimento facial não prova, sozinho, que o funcionário está fisicamente presente; mantenha revisão e controles organizacionais. O login manual permanece disponível como contingência. Os modelos YuNet e SFace estão em `public/models`, com os textos de licença em `third_party/licenses`; o runtime ONNX é servido localmente.

### Biometria do aparelho (passkey)

O funcionário pode cadastrar uma passkey no próprio aparelho pela tela **Meu ponto → Ativar neste aparelho**. O aparelho solicita Face ID, Windows Hello, impressão digital ou o método de desbloqueio configurado. A disponibilidade e o método variam conforme navegador, sistema operacional e aparelho; o PIN/código do aparelho pode ser aceito como verificação.

Para passkeys, o sistema não captura nem recebe rosto, impressão digital ou imagem biométrica do autenticador. O servidor guarda apenas a chave pública da passkey e dados técnicos necessários para validar assinaturas; a chave privada e a verificação biométrica ficam no autenticador do aparelho. Funcionários podem cadastrar mais de um aparelho e remover passkeys pela mesma tela. Ao arquivar um funcionário, suas passkeys são removidas.

Para registrar com passkey, abra **Meu ponto**, cadastre o aparelho e use **Registrar com biometria**. A ação solicita a verificação do aparelho e a localização GPS. Essas marcações ficam identificadas como `web_passkey` em `attendance_records.source`. Se o aparelho/navegador não oferecer passkey, o usuário cancelar ou a verificação falhar, use **Registrar manualmente**. A marcação manual permanece disponível e não exige passkey.

O WebAuthn exige HTTPS em produção. `NEXT_PUBLIC_SITE_URL` deve ser a URL pública exata usada pelos funcionários (por exemplo, `https://ponto-umber-ten.vercel.app`); em desenvolvimento, `http://localhost:3000` é aceito. Após configurar ou alterar essa URL em produção, faça um novo deploy. A execução da migração `supabase/secure_rls.sql` é necessária antes de carregar as passkeys.

Passkeys confirmam a verificação local do usuário pelo dispositivo, mas não garantem que o aparelho esteja com o funcionário nem substituem os controles internos de registro e revisão do ponto.
