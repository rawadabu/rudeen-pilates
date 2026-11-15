// Many small checks inside one node:test test: every check is listed, and the
// test fails at the end with all the failed ones (not only the first).
import assert from 'node:assert/strict'

export function checks() {
  const failed = []
  const ok = (name, cond, extra = '') => {
    if (cond) return console.log('  ✓ ' + name)
    failed.push(name + (extra === '' ? '' : ' — ' + String(extra).slice(0, 500)))
    console.log('  ✗ ' + name)
  }
  const finish = () => assert.equal(failed.length, 0, `${failed.length} failed:\n` + failed.join('\n'))
  return { ok, finish }
}
