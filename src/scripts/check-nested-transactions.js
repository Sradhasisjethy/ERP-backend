/**
 * Fails when one service opens a transaction inside another's.
 *
 *   npm run check:transactions
 *
 * `sequelize.transaction()` called while a transaction is already in flight
 * does NOT create a savepoint in this codebase — it opens a second, independent
 * transaction on a second connection. Two things follow, both silent:
 *
 *   - The inner transaction cannot see the outer one's uncommitted rows, so a
 *     service reads a row that was written moments earlier and concludes it
 *     does not exist. That is exactly how bundle expansion failed when called
 *     from order creation: "that order line no longer exists", for a line that
 *     had just been inserted.
 *   - The pool holds five connections. Under load, each in-flight request
 *     already owns one, so asking for a second that only a committing sibling
 *     can release means every request waits out the full acquire timeout.
 *
 * The fix is always the same shape, and both DocumentNumberingService.allocate
 * and BundleDocumentService already use it:
 *
 *     return transaction ? run(transaction) : sequelize.transaction(run);
 *
 * This script is deliberately a static scan rather than a test: the failure
 * needs concurrency and real data to reproduce at runtime, so it would not show
 * up in the suite until production.
 */
const fs = require('fs');
const path = require('path');

const API_ROOT = path.join(__dirname, '..', 'api');

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return full.endsWith('.js') ? [full] : [];
  });

/** Every `static` method on a service class, with its body. */
const collectMethods = () => {
  const methods = new Map();

  for (const file of walk(API_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    const className = (source.match(/class\s+(\w+)\s*\{/) || [])[1];
    if (!className) continue;

    const starts = [];
    const methodRe = /^\s{2}static\s+(?:async\s+)?(\w+)\s*\(/gm;
    let match;
    while ((match = methodRe.exec(source))) starts.push({ name: match[1], index: match.index });

    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
      methods.set(`${className}.${start.name}`, {
        body: source.slice(start.index, end),
        file: path.relative(path.join(__dirname, '..', '..'), file),
      });
    });
  }

  return methods;
};

/**
 * The [start, end] span of every `sequelize.transaction(` callback in a body,
 * found by matching brackets forward from the opening call.
 */
const transactionRegions = (body) => {
  const regions = [];
  const re = /sequelize\.transaction\(/g;
  let match;

  while ((match = re.exec(body))) {
    let depth = 0;
    let i = match.index + match[0].length - 1;   // the '(' itself

    for (; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === '(' || ch === '{') depth += 1;
      else if (ch === ')' || ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    regions.push([match.index, i]);
  }

  return regions;
};

const run = () => {
  const methods = collectMethods();
  const opensTransaction = new Set(
    [...methods].filter(([, m]) => /sequelize\.transaction\(/.test(m.body)).map(([key]) => key)
  );

  const risky = [];

  for (const key of opensTransaction) {
    const { body, file } = methods.get(key);
    const className = key.split('.')[0];

    // Only calls lexically INSIDE the transaction callback count. A method can
    // perfectly well call another transaction-opening method on a path that
    // returns before its own transaction starts — FactoryService
    // .updateFinancialYear does exactly that — and flagging those trains people
    // to ignore the checker.
    const regions = transactionRegions(body);

    const callRe = /\b(?:([A-Z]\w*Service)|this)\.(\w+)\s*\(/g;
    let call;
    while ((call = callRe.exec(body))) {
      if (!regions.some(([start, end]) => call.index > start && call.index < end)) continue;

      const target = `${call[1] || className}.${call[2]}`;
      if (target === key || !opensTransaction.has(target)) continue;

      // Passing a transaction is what makes the call safe: the callee reuses it
      // rather than opening its own.
      const statement = body.slice(call.index, call.index + 400).split(';')[0];
      if (/transaction/.test(statement)) continue;

      risky.push({
        caller: key,
        callee: target,
        file,
        line: body.slice(call.index, body.indexOf('\n', call.index)).trim().slice(0, 110),
      });
    }
  }

  console.log(`Checked ${methods.size} service methods, ${opensTransaction.size} of which open a transaction.`);

  if (!risky.length) {
    console.log('No nested transactions without a transaction passed through.');
    return 0;
  }

  console.log(`\n${risky.length} nested transaction(s) that do not pass one through:\n`);
  for (const r of risky) {
    console.log(`  ${r.caller} -> ${r.callee}`);
    console.log(`    ${r.file}`);
    console.log(`    ${r.line}\n`);
  }
  console.log('Pass the caller\'s transaction, and have the callee reuse it:');
  console.log('  return transaction ? run(transaction) : sequelize.transaction(run);');
  return 1;
};

if (require.main === module) process.exit(run());

module.exports = { run };
