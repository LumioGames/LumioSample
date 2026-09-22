/**
 * R-00568 / criterion 7 world assertions. Two rounds can hash-equal a wrong world;
 * this check fails when cells or ore counts do not match the expected snapshot.
 */

export function assertWorld(actual, expected) {
  const failures = [];
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return [{ check: 'world:shape', message: 'actual world must be an object' }];
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return [{ check: 'world:shape', message: 'expected world must be an object' }];
  }
  if (!Array.isArray(actual.cells) || actual.cells.length === 0) {
    failures.push({ check: 'world:cells', message: 'actual cells must be a non-empty array' });
  }
  if (!Array.isArray(expected.cells) || expected.cells.length === 0) {
    failures.push({ check: 'world:cells', message: 'expected cells must be a non-empty array' });
  }
  if (failures.length > 0) return failures;

  const keyOf = (cell) => `${cell.x},${cell.y},${cell.z}`;
  const expectedMap = new Map(expected.cells.map((cell) => [keyOf(cell), cell]));
  const actualMap = new Map(actual.cells.map((cell) => [keyOf(cell), cell]));

  if (expectedMap.size !== actualMap.size) {
    failures.push({
      check: 'world:cells',
      message: `cell count ${actualMap.size} != ${expectedMap.size}`,
    });
  }
  for (const [key, cell] of expectedMap) {
    const seen = actualMap.get(key);
    if (!seen) {
      failures.push({ check: 'world:cell', message: `missing cell ${key}` });
      continue;
    }
    if (seen.block !== cell.block) {
      failures.push({ check: 'world:cell', message: `cell ${key} block ${seen.block} != ${cell.block}` });
    }
  }

  if (actual.oreCount !== expected.oreCount) {
    failures.push({
      check: 'world:ore',
      message: `oreCount ${actual.oreCount} != ${expected.oreCount}`,
    });
  }
  return failures;
}

export function worldsMatch(actual, expected) {
  return assertWorld(actual, expected).length === 0;
}
