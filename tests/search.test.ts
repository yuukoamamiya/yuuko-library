import test from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../src/lib/search.ts';
import { validateCategories } from '../src/lib/categories.ts';

const entry = { id: 'example', title: '资本主义的起源：长远视角', authors: ['Ellen Meiksins Wood'], description: '历史与社会关系。', subjects: ['政治经济学'], categories: ['political-economy', 'history'] };
test('中文、作者、多词交集和分类组合搜索', () => {
  assert.equal(matches(entry, '资本 起源'), true);
  assert.equal(matches(entry, 'ＥＬＬＥＮ wood'), true);
  assert.equal(matches(entry, '社会', '政治经济学'), true);
  assert.equal(matches(entry, '社会', '哲学'), false);
  assert.equal(matches(entry, 'wood 不存在'), false);
  assert.equal(matches(entry, 'gemini'), false);
  assert.equal(matches({ ...entry, subjects: [] }, '', '未分类'), false);
});
test('分类与原始标签独立，关键词、分类、标签取交集', () => {
  assert.equal(matches(entry, 'wood', '政治经济学', 'history'), true);
  assert.equal(matches(entry, 'wood', '政治经济学', 'philosophy'), false);
  assert.equal(matches(entry, 'wood', '不存在', 'history'), false);
  assert.equal(matches(entry, '', '', 'political-economy'), true);
  assert.equal(matches({ ...entry, subjects: [] }, '', '', 'history'), true);
  assert.equal(matches(entry, 'history'), false);
  assert.doesNotThrow(() => validateCategories(['history', 'political-economy']));
  for (const categories of [[], ['unknown'], ['history', 'history'], ['history', 'political-economy', 'philosophy'], 'history']) {
    assert.throws(() => validateCategories(categories), /分类/u);
  }
});
