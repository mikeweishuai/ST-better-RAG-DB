// 零依赖断言。每个 test-*.mjs 用 run() 收集用例,失败即非零退出。
let failures = 0;
let total = 0;

export function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

export function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n       expected ${b}\n       actual   ${a}`);
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

export function near(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg} expected ${expected} ± ${tol}, got ${actual}`);
  }
}

export function done(suite) {
  console.log(`${suite}: ${total - failures}/${total} passed`);
  if (failures) process.exit(1);
}
