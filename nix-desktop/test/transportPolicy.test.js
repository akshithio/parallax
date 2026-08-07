const test = require('node:test')
const assert = require('node:assert/strict')
const { acceptsResponseSource } = require('../lib/transportPolicy')

test('only network-stream and accepted-turn recovery responses can enter the transcript', () => {
  assert.equal(acceptsResponseSource('network'), true)
  assert.equal(acceptsResponseSource('page-recovery'), true)
  assert.equal(acceptsResponseSource('dom'), false)
  assert.equal(acceptsResponseSource(''), false)
  assert.equal(acceptsResponseSource(undefined), false)
})
