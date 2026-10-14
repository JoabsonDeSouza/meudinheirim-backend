import { describe, expect, it } from 'vitest';

import { categoryCodeSchema, getSystemCategoryCodes } from '../../src/modules/categories/categories.schema.js';
import { toCustomCategoryName, toCustomCategoryId } from '../../src/shared/utils/categoryHelpers.js';

describe('stable category codes', () => {
  it('accepts stable English codes and rejects localized display labels', () => {
    expect(categoryCodeSchema.parse('FOOD')).toBe('FOOD');
    expect(categoryCodeSchema.safeParse('Food').success).toBe(false);
    expect(categoryCodeSchema.safeParse('Alimentação').success).toBe(false);
  });

  it('returns system category code catalog without translated labels', () => {
    const catalog = getSystemCategoryCodes();
    expect(catalog.some((category) => category.code === 'FOOD')).toBe(true);
    expect(catalog.some((category) => category.code === 'SALARY')).toBe(true);
    expect(catalog.every((category) => !('label' in category))).toBe(true);
  });

  it('uses UUID identity for custom categories and round-trips the token', () => {
    const id = '5a7cde52-ae08-4ce0-92a4-c6a87127e130';
    expect(toCustomCategoryName(id)).toBe(`CUSTOM:${id}`);
    expect(toCustomCategoryId(`CUSTOM:${id}`)).toBe(id);
  });
});
