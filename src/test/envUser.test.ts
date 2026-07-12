import * as assert from 'assert'
import { sudoCapableFromGroups } from '../environment/user'

suite('sudoCapableFromGroups (TRDD-HUWJVQJA — user/account environment facet)', () => {
  test('staff + admin group list is sudo-capable via admin', () => {
    assert.strictEqual(sudoCapableFromGroups(['staff', 'admin']), true)
  })

  test('sudo group alone is sudo-capable', () => {
    assert.strictEqual(sudoCapableFromGroups(['sudo']), true)
  })

  test('wheel group alone is sudo-capable (BSD/macOS admin equivalent)', () => {
    assert.strictEqual(sudoCapableFromGroups(['wheel']), true)
  })

  test('unprivileged groups (users, docker) are not sudo-capable', () => {
    assert.strictEqual(sudoCapableFromGroups(['users', 'docker']), false)
  })

  test('empty group list is not sudo-capable', () => {
    assert.strictEqual(sudoCapableFromGroups([]), false)
  })

  test('group name matching is case-insensitive', () => {
    assert.strictEqual(sudoCapableFromGroups(['ADMIN']), true)
  })
})
