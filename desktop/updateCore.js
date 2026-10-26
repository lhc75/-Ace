// 更新检查的纯逻辑部分（不依赖 electron，便于 node --test 单测）。
// electron 侧的 IPC / 下载 / 状态落盘在 updater.js。
//
// 双源：GitHub 优先（附件上限 2GB，可放完整 dmg），Gitee 兜底
// （国内网络 GitHub 不可达时仍能检查到更新，附件走 100MB 分卷）。

const GITHUB_SOURCE = {
  name: 'github',
  latestApi: 'https://api.github.com/repos/lhc75/-Ace/releases/latest',
  releasesPage: 'https://github.com/lhc75/-Ace/releases',
  downloadBase: (tag) => `https://github.com/lhc75/-Ace/releases/download/${tag}`,
};
const GITEE_SOURCE = {
  name: 'gitee',
  latestApi: 'https://gitee.com/api/v5/repos/zhanshen0019/interview-assistant/releases/latest',
  releasesPage: 'https://gitee.com/zhanshen0019/interview-assistant/releases',
  downloadBase: (tag) => `https://gitee.com/zhanshen0019/interview-assistant/releases/download/${tag}`,
};
const RELEASE_SOURCES = [GITHUB_SOURCE, GITEE_SOURCE];

/** 解析 "v1.2.3" / "1.2.3" 为 [1, 2, 3]；非法返回 null */
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a > b 返回 1，a < b 返回 -1，相等或非法返回 0 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** 从 release JSON 中解析出有效信息（GitHub/Gitee 字段名一致）；缺少关键字段返回 null */
function parseReleasePayload(payload, source) {
  if (!payload || typeof payload !== 'object') return null;
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  const version = parseVersion(tag);
  if (!version) return null;
  return {
    tag,
    version: version.join('.'),
    name: typeof payload.name === 'string' ? payload.name : tag,
    notes: typeof payload.body === 'string' ? payload.body : '',
    assets: Array.isArray(payload.assets) ? payload.assets : [],
    source,
  };
}

/**
 * 解析下载计划 { fileName, urls }：
 * 1. 附件里有 dmg 就用整包（GitHub 会剥离附件名中的非 ASCII 字符, 按 .dmg 后缀匹配）；
 * 2. 否则找 `.dmg.part-*` 分卷（Gitee 附件限 100MB，大包按分卷上传），按名称排序；
 * 3. 都没有则按约定拼 <downloadBase>/<tag>/InterviewAce-arm64.dmg。
 * fileName 是本地保存名（本地文件系统支持中文）。
 */
function resolveDownloadPlan(release, productName) {
  if (!release) return null;
  const fileName = `${productName}-${release.version}-arm64.dmg`;
  const assets = (release.assets || [])
    .map((a) => ({ name: a && a.name, url: a && a.browser_download_url }))
    .filter((a) => typeof a.name === 'string' && typeof a.url === 'string');

  const whole = assets.find((a) => a.name === fileName) ?? assets.find((a) => /\.dmg$/i.test(a.name));
  if (whole) return { fileName, urls: [whole.url] };

  const parts = assets
    .filter((a) => /\.dmg\.part-/i.test(a.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  if (parts.length > 0) return { fileName, urls: parts.map((p) => p.url) };

  return {
    fileName,
    urls: [`${release.source.downloadBase(release.tag)}/InterviewAce-arm64.dmg`],
  };
}

/** 是否应该提示：有新版本且未被用户跳过 */
function shouldNotify(currentVersion, release, skippedVersion) {
  if (!release) return false;
  if (compareVersions(release.version, currentVersion) <= 0) return false;
  if (skippedVersion && compareVersions(release.version, skippedVersion) <= 0) return false;
  return true;
}

/**
 * 从 `hdiutil attach -plist` 输出里取挂载点。
 * 输出是 XML plist, 挂载点以 <key>mount-point</key><string>...</string> 出现。
 */
function parseHdiutilMountPoint(plistOutput) {
  const match = String(plistOutput || '').match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1] : null;
}

module.exports = {
  GITHUB_SOURCE,
  GITEE_SOURCE,
  RELEASE_SOURCES,
  parseVersion,
  compareVersions,
  parseReleasePayload,
  resolveDownloadPlan,
  shouldNotify,
  parseHdiutilMountPoint,
};
