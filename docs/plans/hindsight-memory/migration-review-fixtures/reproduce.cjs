// Run from the repository root using Node 22. Inject synthetic cases without modifying application tests.
const fs = require('node:fs');
const path = require('node:path');
const target = 'src/lib/server/services/memory-profile/migration.integration.test.ts';
(async () => {
  const { startVitest } = await import(process.cwd() + '/node_modules/vitest/dist/node.js');
  const probes = fs.readFileSync(path.join(__dirname, 'probes.ts.txt'), 'utf8');
  const result = await startVitest('test', [target], {
    run: true,
    testNamePattern: 'migration judge',
    maxWorkers: 1,
  }, { plugins: [{
    name: 'migration-independent-regressions',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith(target)) return source + '\n' + probes;
    },
  }] });
  await result?.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
