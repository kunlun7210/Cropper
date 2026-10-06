const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../corner-detector.js');
const photo = { left: 20, top: 100, right: 1220, bottom: 1000 };
test('四个局部区域不扫描全图或中间', () => {
  const rois = C.corners(photo);
  assert.equal(rois.length, 4);
  assert.equal(rois.reduce((n, r) => n + r.width * r.height, 0) / (1200 * 900) < .4, true);
  assert.deepEqual(C.corners({ left: 0, top: 0, right: 50, bottom: 40 }), []);
});
test('品牌别名与正文严格区分', () => {
  for (const text of ['携程', '同程旅行', '大众点评', '美团', 'AMAP.COM', '艺龙', '百度地图', '腾讯地图', '飞猪', '去哪儿', '淘宝']) assert.ok(C.brandFor(text));
  for (const text of ['高德合作网友', '美团外卖欢迎光临', '携程旅行更便捷', '地图', '赞']) assert.equal(C.brandFor(text), null);
});
test('相邻分段品牌合并，不拼接遥远正文；百度易混字形要求模板', () => {
  const items = [{ text: 'Baidut', score: .95, poly: [[250, 100], [325, 100], [325, 120], [250, 120]] }, { text: '地图', score: .98, poly: [[330, 100], [375, 100], [375, 120], [330, 120]] }];
  const merged = C.combineItems(items);
  assert.equal(merged.length, 3);
  assert.equal(merged[2].text, '百度地图'); assert.equal(merged[2].needsTemplate, true);
  assert.equal(C.combineItems([items[0], { ...items[1], poly: [[330, 10], [375, 10], [375, 30], [330, 30]] }]).length, 2);
});
test('OCR 单字误差必须有完整 logo 证据，短品牌不猜测', () => {
  assert.equal(C.approximateBrandFor('Baid地图').id, 'baidu');
  assert.equal(C.approximateBrandFor('美园'), null);
  const roi = C.corners(photo)[3];
  assert.equal(C.accept({ text: 'Baid地图', score: .96, poly: [[300, 175], [430, 175], [430, 195], [300, 195]] }, roi, photo), null);
});
test('角落标识接受；正文/低置信度/巨大招牌拒绝', () => {
  const roi = C.corners(photo)[3];
  const item = { text: '携程', score: .96, poly: [[340, 175], [430, 175], [430, 195], [340, 195]] };
  assert.equal(C.accept(item, roi, photo).kind, 'ctrip');
  assert.equal(C.accept({ ...item, score: .5 }, roi, photo), null);
  assert.equal(C.accept({ ...item, poly: [[40, 5], [130, 5], [130, 25], [40, 25]] }, roi, photo), null);
});
test('多个要素取更靠主体的边界且尊重关闭的方向', () => {
  const marks = [{ side: 'bottom', y: 970 }, { side: 'bottom', y: 940 }, { side: 'top', y: 105, height: 35 }];
  const baseline = { top: 100, bottom: 200, left: 20, right: 20 };
  assert.deepEqual(C.merge(baseline, marks, { width: 1240, height: 1200 }, { top: true, bottom: true }), { top: 140, bottom: 260, left: 20, right: 20 });
  assert.deepEqual(C.merge(baseline, marks, { height: 1200 }, {}), baseline);
});
