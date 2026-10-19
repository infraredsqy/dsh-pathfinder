/* 一格的名字与把手：八字短写、无标题落短写、悬停「全名 · 短把手」且名字恰为把手时不重复。
 *
 * 这三条字面住在 src/client/nodes.ts，纯函数、Node 直载可测；卡名/行名的对数由
 * check:panel 的渲染断言间接承担，这里锁判据本身——截断的长短两界、标题的空缺
 * 与空串、悬停前半段的两个落点。
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { shortId, nodeName, nodeHover } from '../src/client/nodes.ts'

function aNode(id, title) {
  return { id, title }
}

test('短写：恰八字原样，第九个字起截，超长身份也只留头八字', () => {
  assert.equal(shortId('abcdefgh'), 'abcdefgh', '恰八字的不截')
  assert.equal(shortId('abcdefghi'), 'abcdefgh', '第九个字起截掉')
  assert.equal(shortId('f47ac10b-58cc-4372-a567-0e02b2c3d479'), 'f47ac10b', '超长身份只留头八字')
})

test('一格的名字：记录写了标题就用标题，没写才轮到身份短写', () => {
  assert.equal(nodeName(aNode('n1', '批E 收尾')), '批E 收尾', '写了标题用标题')
  assert.equal(nodeName(aNode('n123456789', undefined)), 'n1234567', '没写标题落身份短写，不露全长身份')
  assert.equal(nodeName(aNode('n1', '')), '', '写了空标题也算写了，不落回短写')
})

test('悬停：全名后跟八字把手，名字本身就是那八个字时不重复', () => {
  assert.equal(nodeHover(aNode('n123456789', undefined)), 'n1234567', '没写标题就只有短把手')
  assert.equal(nodeHover(aNode('abcdefgh', 'abcdefgh')), 'abcdefgh', '标题恰是八字把手，单段')
  assert.equal(nodeHover(aNode('abcdefgh-rest', 'abcdefgh')), 'abcdefgh', '标题等于截出来的把手，也不重复')
  assert.equal(nodeHover(aNode('n1', '批E 收尾')), '批E 收尾 · n1', '短身份时全名后跟全把手')
  assert.equal(nodeHover(aNode('f47ac10b-58cc-4372-a567-0e02b2c3d479', '批E 收尾')), '批E 收尾 · f47ac10b', '长身份时把手截到八字')
})
