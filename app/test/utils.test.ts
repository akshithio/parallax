import { describe, expect, test } from 'vitest'
import { chatgptProjectName } from '../lib/utils'

describe('chatgptProjectName', () => {
  test('uses the desktop folder basename with the plx prefix', () => {
    expect(chatgptProjectName('/Users/example/Developer/my-project')).toBe(
      'plx-my-project',
    )
  })
})
