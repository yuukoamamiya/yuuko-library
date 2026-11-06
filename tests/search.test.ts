import test from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../src/lib/search.ts';

const entry = { id: 'example', title: '资本主义的起源：长远视角', authors: ['Ellen Meiksins Wood'], description: '历史与社会关系。', subjects: ['政治经济学'] };
test('中文、作者、多词交集和分类组合搜索', () => {
  assert.equal(matches(entry, '资本 起源'), true);
  assert.equal(matches(entry, 'ＥＬＬＥＮ wood'), true);
  assert.equal(matches(entry, '社会', '政治经济学'), true);
  assert.equal(matches(entry, '社会', '哲学'), false);
  assert.equal(matches(entry, 'wood 不存在'), false);
  assert.equal(matches(entry, 'gemini'), false);
  assert.equal(matches({ ...entry, subjects: [] }, '', '未分类'), true);
});
