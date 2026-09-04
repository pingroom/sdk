import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('private room types reject fields reserved for public room creation', () => {
  const filename = fileURLToPath(new URL('./room-contract.mts', import.meta.url));
  const source = `
    import { PingRoom } from '../dist/index.js';
    const pr = new PingRoom();
    const room = { name: 'Deploys', icon: 'bell', color: '#e33122' };
    pr.rooms.create(room);
    // @ts-expect-error private room descriptions are prohibited
    pr.rooms.create({ ...room, description: 'A description' });
    // @ts-expect-error private room trigger permissions are prohibited
    pr.rooms.create({ ...room, everyone_can_trigger: true });
    // @ts-expect-error private room password protection is prohibited
    pr.rooms.create({ ...room, is_password_protected: true });
    // @ts-expect-error private room passwords are prohibited
    pr.rooms.create({ ...room, password: 'secret' });
    // @ts-expect-error private room initial actions are prohibited
    pr.rooms.create({ ...room, actions: [] });
    pr.rooms.createPublic({ ...room, handle: 'deploys', description: 'A description',
      actions: [{ action_number: 1, label: 'Deployed', icon: '✅' }] });
  `;
  const options = { strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (path) => path === filename ? source : originalRead(path);
  host.fileExists = (path) => path === filename || originalExists(path);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
});
