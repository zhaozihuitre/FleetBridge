// Redaction before anything of the self-improvement analysis leaves this machine (server/insights/redact.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, redactDeep } from '../server/insights/redact.js';

const o = { home: 'C:\\Users\\alice', user: 'alice', secrets: ['fleet-bridge-0f1e2d3c4b5a69788796a5b4'] };
const clean = (s) => redact(s, o);

test('keys and tokens by their shape', () => {
  const cases = {
    'key sk-ant-api03-AbCdEfGh123456_xyz end': 'sk-ant-api03',
    'openai sk-proj-abcdefghijklmnopqrstuvwxyz123456': 'sk-proj-abcdef',
    'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789': 'ghp_abcdef',
    'pat github_pat_11ABCDEFG0123456789_abcdefghij': 'github_pat_11',
    'aws AKIAIOSFODNN7EXAMPLE x': 'AKIAIOSFODNN7EXAMPLE',
    'google AIzaSyA1234567890abcdefghijklmnopqrstu': 'AIzaSy',
    'slack xoxb-1234567890-abcdefghij': 'xoxb-1234567890',
    'npm npm_abcdefghijklmnopqrstuvwxyz0123456789': 'npm_abcdef',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U': 'eyJhbGci',
  };
  for (const [text, secret] of Object.entries(cases)) {
    const out = clean(text);
    assert.ok(!out.includes(secret), `${text} -> ${out}`);
    assert.match(out, /‹redacted:/);
  }
});

test('passwords, tokens, cookies and auth headers as name = value', () => {
  const text = [
    'password=hunter2pass',
    'PASSWORD: "S3cr3t!x"',
    'db_passwd = abc12345',
    'api_key: 0123abcd',
    '"client_secret": "very-secret-value"',
    'export GITHUB_TOKEN=abcdef123456',
    'Authorization: Bearer abc.def.ghi1234567890',
    'Cookie: sid=abc123; theme=dark',
    'set-cookie: session=xyz789; HttpOnly',
    'mysql -u root --password=topsecret1',
    'curl https://bob:pa55word@example.com/x',
    'sessionId=8f7e6d5c4b3a',
  ].join('\n');
  const out = clean(text);
  for (const s of ['hunter2pass', 'S3cr3t!x', 'abc12345', '0123abcd', 'very-secret-value', 'abcdef123456', 'abc.def.ghi1234567890', 'sid=abc123', 'xyz789', 'topsecret1', 'pa55word', '8f7e6d5c4b3a']) assert.ok(!out.includes(s), `${s} left in:\n${out}`);
});

test('private keys, e-mail, long random strings, this machine\'s secrets, the user\'s folder and name', () => {
  const out = clean(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----
mail me: alice.smith@example.co.jp
hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
rand Zx9Qw3Er5Ty7Ui9Op1As3Df5Gh
topic fleet-bridge-0f1e2d3c4b5a69788796a5b4
path C:\\Users\\alice\\project\\x.js and C:/Users/alice/y and alice said hi`);
  for (const s of ['b3BlbnNzaC1rZXk', 'alice.smith@example.co.jp', '9f86d081884c7d659a2feaa0c55ad015', 'Zx9Qw3Er5Ty7Ui9Op1As3Df5Gh', '0f1e2d3c4b5a69788796a5b4', 'alice']) assert.ok(!out.includes(s), `${s} left in:\n${out}`);
  assert.match(out, /~\\project\\x\.js/);
  assert.match(out, /~\/y/);
});

test('ordinary text stays as it is', () => {
  const s = '修复 server/turns.js 的截断：REPLY_MAX 改成 3000，测试 17 项通过。fleet_read_screen 用了 12 次。';
  assert.equal(clean(s), s);
  assert.equal(clean('session 7c1e9a2b-4d3f-4a6b-9c8d-0e1f2a3b4c5d ended'), 'session 7c1e9a2b-4d3f-4a6b-9c8d-0e1f2a3b4c5d ended');
});

test('redactDeep goes through objects and arrays', () => {
  const out = redactDeep({ a: ['token=abcdef123'], b: { c: 'mail x@y.com' }, n: 3 }, o);
  assert.deepEqual(out.n, 3);
  assert.ok(!JSON.stringify(out).includes('abcdef123'));
  assert.ok(!JSON.stringify(out).includes('x@y.com'));
});
