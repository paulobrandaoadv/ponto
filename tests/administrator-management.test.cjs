const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const actorId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'administrators', '[administratorId]', 'route.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function setup(options = {}) {
  const state = { audit: [], updates: [], passwords: [] };
  const profiles = {
    [actorId]: { id: actorId, nome: 'Autor', email: 'actor@example.test', role: 'admin', status: 'ativo', company_id: 'company-a', ...options.actor },
    [targetId]: { id: targetId, nome: 'Alvo', role: 'admin', status: 'ativo', company_id: 'company-a', ...options.target },
  };
  function query(table) {
    const filters = {};
    let update = null;
    let insertion = null;
    const chain = {
      select() { return chain; },
      eq(key, value) { filters[key] = value; return chain; },
      insert(value) { insertion = value; state.audit.push(value); return chain; },
      update(value) { update = value; return chain; },
      async single() { return options.auditFailure ? { data: null, error: { message: 'audit unavailable' } } : { data: { id: 'audit-id' }, error: null }; },
      async maybeSingle() {
        if (table === 'audit_logs' && update) {
          state.audit.push(update);
          return options.completionFailure
            ? { data: null, error: { message: 'audit unavailable' } }
            : { data: options.missingCompletedAudit ? null : { id: 'audit-id' }, error: null };
        }
        const profile = profiles[filters.id];
        if (update && options.concurrentName) profile.nome = options.concurrentName;
        const matched = profile && Object.entries(filters).every(([key, value]) => profile[key] === value);
        if (table !== 'profiles' || !matched) return { data: null, error: null };
        if (update) { state.updates.push(update); Object.assign(profile, update); }
        return { data: profile, error: null };
      },
    };
    return chain;
  }
  const caller = { auth: { getUser: async () => ({ data: { user: { id: actorId, email: 'actor@example.test' } }, error: null }) } };
  const verifier = { auth: { signInWithPassword: async ({ password }) => password === 'correct'
    ? { data: { user: { id: actorId } }, error: null }
    : { data: { user: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } } } };
  const admin = {
    from: query,
    auth: { admin: { updateUserById: async (id, value) => { state.passwords.push({ id, ...value }); return { error: null }; } } },
  };
  const context = {
    exports: {},
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://test.example', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'service' } },
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status || 200 }) } };
      if (name === '@supabase/supabase-js') return {
        createClient: (_url, key, config) => key === 'service' ? admin : config.global ? caller : verifier,
      };
      throw new Error(`Unexpected dependency ${name}`);
    },
  };
  vm.runInNewContext(code, context);
  const call = (body, id = targetId, token = 'token') => context.exports.PATCH({
    headers: { get: () => token ? `Bearer ${token}` : null },
    json: async () => body,
  }, { params: { administratorId: id } });
  return { call, state };
}

test('requires a valid active administrator and same-company target', async () => {
  const unauthorized = setup({ actor: { role: 'gestor' } });
  assert.equal((await unauthorized.call({ action: 'name', name: 'Novo Nome', currentPassword: 'correct' })).status, 403);
  const otherCompany = setup({ target: { company_id: 'company-b' } });
  assert.equal((await otherCompany.call({ action: 'password', password: 'longpassword', currentPassword: 'correct' })).status, 404);
  const inactive = setup({ target: { status: 'inativo' } });
  assert.equal((await inactive.call({ action: 'name', name: 'Novo Nome', currentPassword: 'correct' })).status, 404);
  assert.equal(otherCompany.state.passwords.length, 0);
});

test('requires current password and audit before changing an administrator', async () => {
  const wrongPassword = setup();
  assert.equal((await wrongPassword.call({ action: 'password', password: 'longpassword', currentPassword: 'wrong' })).status, 403);
  assert.equal(wrongPassword.state.passwords.length, 0);
  const failedAudit = setup({ auditFailure: true });
  assert.equal((await failedAudit.call({ action: 'name', name: 'Novo Nome', currentPassword: 'correct' })).status, 500);
  assert.equal(failedAudit.state.updates.length, 0);
});

test('updates names and passwords with audit without recording secrets', async () => {
  const run = setup();
  assert.equal((await run.call({ action: 'name', name: ' Novo  Nome ', currentPassword: 'correct' })).status, 200);
  assert.equal(run.state.updates[0].nome, 'Novo Nome');
  assert.equal((await run.call({ action: 'password', password: 'newpassword', currentPassword: 'correct' }, actorId)).status, 200);
  assert.equal(run.state.passwords[0].id, actorId);
  assert.equal(run.state.audit[0].action, 'administrator_name_change_requested');
  assert.equal(run.state.audit[1].action, 'administrator_name_changed');
  assert.equal(run.state.audit[3].action, 'administrator_password_reset');
  assert.equal(JSON.stringify(run.state.audit).includes('newpassword'), false);
  assert.equal(JSON.stringify(run.state.audit).includes('correct'), false);
});

test('reports an applied change when completing its audit fails', async () => {
  const run = setup({ completionFailure: true });
  const result = await run.call({ action: 'password', password: 'newpassword', currentPassword: 'correct' });
  assert.equal(result.status, 500);
  assert.equal(result.body.changed, true);
  assert.equal(run.state.passwords.length, 1);
});

test('reports an applied change when the audit record is missing', async () => {
  const run = setup({ missingCompletedAudit: true });
  const result = await run.call({ action: 'name', name: 'Novo Nome', currentPassword: 'correct' });
  assert.equal(result.status, 500);
  assert.equal(result.body.changed, true);
  assert.equal(run.state.updates.length, 1);
});

test('does not overwrite a concurrent name change or claim it was applied', async () => {
  const run = setup({ concurrentName: 'Outro Nome' });
  const result = await run.call({ action: 'name', name: 'Novo Nome', currentPassword: 'correct' });
  assert.equal(result.status, 409);
  assert.equal(run.state.updates.length, 0);
});
