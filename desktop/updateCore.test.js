const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GITHUB_SOURCE,
  GITEE_SOURCE,
  RELEASE_SOURCES,
  parseVersion,
  compareVersions,
  parseReleasePayload,
  resolveDownloadPlan,
  shouldNotify,
} = require('./updateCore');

test('release sources are GitHub first with Gitee fallback', () => {
  assert.equal(RELEASE_SOURCES[0], GITHUB_SOURCE);
  assert.equal(RELEASE_SOURCES[1], GITEE_SOURCE);
  assert.ok(GITHUB_SOURCE.latestApi.includes('api.github.com'));
});

test('parseVersion accepts plain and v-prefixed semver', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v1.10.0'), [1, 10, 0]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('abc'), null);
  assert.equal(parseVersion(null), null);
});

test('compareVersions orders semver numerically', () => {
  assert.equal(compareVersions('1.1.0', '1.0.12'), 1);
  assert.equal(compareVersions('1.0.12', '1.1.0'), -1);
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('garbage', '1.0.0'), 0);
});

test('parseReleasePayload extracts tag/name/notes and rejects bad payloads', () => {
  const release = parseReleasePayload({ tag_name: 'v1.1.0', name: '界面重设计', body: '说明' }, GITHUB_SOURCE);
  assert.equal(release.version, '1.1.0');
  assert.equal(release.name, '界面重设计');
  assert.equal(release.notes, '说明');
  assert.equal(release.source, GITHUB_SOURCE);
  assert.equal(parseReleasePayload(null, GITHUB_SOURCE), null);
  assert.equal(parseReleasePayload({ tag_name: 'not-a-version' }, GITHUB_SOURCE), null);
});

test('resolveDownloadPlan prefers whole dmg asset', () => {
  const release = {
    version: '1.1.0',
    tag: 'v1.1.0',
    assets: [{ name: '面试Ace-1.1.0-arm64.dmg', browser_download_url: 'https://gitee.com/x/面试Ace-1.1.0-arm64.dmg' }],
  };
  assert.deepEqual(resolveDownloadPlan(release, '面试Ace'), {
    fileName: '面试Ace-1.1.0-arm64.dmg',
    urls: ['https://gitee.com/x/面试Ace-1.1.0-arm64.dmg'],
  });
});

test('resolveDownloadPlan tolerates GitHub stripping non-ascii asset names', () => {
  // GitHub 上传的「面试Ace-1.1.0-arm64.dmg」会被存成「Ace-1.1.0-arm64.dmg」
  const release = {
    version: '1.1.0',
    tag: 'v1.1.0',
    assets: [{ name: 'Ace-1.1.0-arm64.dmg', browser_download_url: 'https://github.com/lhc75/-Ace/releases/download/v1.1.0/Ace-1.1.0-arm64.dmg' }],
  };
  assert.deepEqual(resolveDownloadPlan(release, '面试Ace'), {
    fileName: '面试Ace-1.1.0-arm64.dmg',
    urls: ['https://github.com/lhc75/-Ace/releases/download/v1.1.0/Ace-1.1.0-arm64.dmg'],
  });
});

test('resolveDownloadPlan collects sorted dmg parts', () => {
  const release = {
    version: '1.1.0',
    tag: 'v1.1.0',
    assets: [
      { name: '面试Ace-1.1.0-arm64.dmg.part-ac', browser_download_url: 'https://gitee.com/x/part-ac' },
      { name: '面试Ace-1.1.0-arm64.dmg.part-aa', browser_download_url: 'https://gitee.com/x/part-aa' },
      { name: '面试Ace-1.1.0-arm64.dmg.part-ab', browser_download_url: 'https://gitee.com/x/part-ab' },
      { name: 'v1.1.0.zip', browser_download_url: 'https://gitee.com/x/src.zip' },
    ],
  };
  assert.deepEqual(resolveDownloadPlan(release, '面试Ace'), {
    fileName: '面试Ace-1.1.0-arm64.dmg',
    urls: ['https://gitee.com/x/part-aa', 'https://gitee.com/x/part-ab', 'https://gitee.com/x/part-ac'],
  });
});

test('resolveDownloadPlan falls back to conventional url of the release source', () => {
  const release = { version: '1.1.0', tag: 'v1.1.0', assets: [], source: GITEE_SOURCE };
  assert.deepEqual(resolveDownloadPlan(release, '面试Ace'), {
    fileName: '面试Ace-1.1.0-arm64.dmg',
    urls: ['https://gitee.com/zhanshen0019/interview-assistant/releases/download/v1.1.0/InterviewAce-arm64.dmg'],
  });
  const ghRelease = { version: '1.1.0', tag: 'v1.1.0', assets: [], source: GITHUB_SOURCE };
  assert.deepEqual(resolveDownloadPlan(ghRelease, '面试Ace'), {
    fileName: '面试Ace-1.1.0-arm64.dmg',
    urls: ['https://github.com/lhc75/-Ace/releases/download/v1.1.0/InterviewAce-arm64.dmg'],
  });
  assert.equal(resolveDownloadPlan(null, '面试Ace'), null);
});

test('shouldNotify only for newer, non-skipped versions', () => {
  const release = { version: '1.1.0' };
  assert.equal(shouldNotify('1.0.12', release, null), true);
  assert.equal(shouldNotify('1.1.0', release, null), false);
  assert.equal(shouldNotify('1.2.0', release, null), false);
  assert.equal(shouldNotify('1.0.12', release, '1.1.0'), false);
  assert.equal(shouldNotify('1.0.12', release, '1.0.9'), true);
  assert.equal(shouldNotify('1.0.12', null, null), false);
});
