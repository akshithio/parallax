import { describe, expect, test } from 'vitest'
import {
  normalizeCurrentModel,
  normalizeIntelligenceLabel,
  normalizeModels,
} from '../lib/modelGroups'

describe('model picker state', () => {
  test('rejects generic menu navigation and Project memory labels', () => {
    expect(normalizeCurrentModel('Model')).toBe('')
    expect(normalizeCurrentModel('GPT-5.6 Sol')).toBe('GPT-5.6 Sol')
    expect(normalizeIntelligenceLabel(
      'Default memoryThis project can access memory from outside chats, and vice versa.',
    )).toBe('')
    expect(normalizeIntelligenceLabel('High')).toBe('High')
  })

  test('removes polluted intelligence options from persisted models', () => {
    expect(normalizeModels([
      {
        title: 'GPT-5.6 Sol',
        intelligences: [
          { label: 'High' },
          { label: 'Project-only memoryThis project can only access its own memory.' },
        ],
      },
      { title: 'Model' },
    ])).toEqual([
      {
        slug: 'GPT-5.6 Sol',
        title: 'GPT-5.6 Sol',
        intelligences: [{ label: 'High' }],
      },
    ])
  })
})
