const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");

assert.equal(manifest.manifest_version, 3, "manifest must be MV3");
assert.equal(manifest.name, "xPoster", "manifest name must stay xPoster");
assert.equal(pkg.version, manifest.version, "package and manifest versions must match");

const requiredFiles = [
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "diagnostics.html",
  "diagnostics.css",
  "diagnostics.js",
  "src/background.js",
  "src/content.js",
  "src/main-world.js",
  "src/shared.js",
  "fixtures/live-x-smoke.md",
  "README.zh-CN.md",
  "docs/usage.md",
  "docs/usage.zh-CN.md",
  "docs/privacy.md",
  "docs/privacy.zh-CN.md",
  "docs/images/buy-me-a-coffee-qr.png",
  "assets/icon-16.png",
  "assets/icon-32.png",
  "assets/icon-48.png",
  "assets/icon-128.png"
];

for (const file of requiredFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
}

for (const contentScript of manifest.content_scripts || []) {
  for (const file of contentScript.js || []) {
    assert.ok(fs.existsSync(path.join(root, file)), `content script ${file} is missing`);
  }
}

for (const resourceGroup of manifest.web_accessible_resources || []) {
  for (const file of resourceGroup.resources || []) {
    assert.ok(fs.existsSync(path.join(root, file)), `web resource ${file} is missing`);
  }
}

const shared = require(path.join(root, "src/shared.js"));
const fixture = fs.readFileSync(path.join(root, "fixtures/live-x-smoke.md"), "utf8");
const parsed = shared.parseMarkdown(fixture);
const counts = shared.segmentCounts(parsed.segments);
const plan = shared.buildPastePlan(parsed.segments);

assert.equal(parsed.title, "xPoster live smoke test", "frontmatter title should parse");
assert.ok(parsed.cover, "cover should parse");
assert.ok(counts.image >= 1, "fixture should include an image");
assert.ok(counts.table >= 1, "fixture should include a table");
assert.ok(counts.tweet >= 1, "fixture should include a tweet");
assert.ok(counts.code >= 1, "fixture should include a code block");
assert.ok(counts.divider >= 1, "fixture should include a divider");
assert.ok(plan.html.includes("__XPOSTER_"), "paste plan should include replacement markers");

const coverOf = (markdown) => shared.parseMarkdown(markdown).cover;
assert.equal(coverOf("---\ncover: ./front.png\n---\n\nText\n\n![a](./body.png)"), "./front.png", "explicit cover wins");
assert.equal(coverOf("# Title\n\n![cover](./cover.png)\n\nText"), "./cover.png", "image right under the title is the cover");
assert.equal(
  coverOf("---\ntitle: T\n---\n\n# T\n\n![cover](./cover.png)\n\nText"),
  "./cover.png",
  "image under a repeated title heading is the cover"
);
assert.equal(coverOf("![cover](./cover.png)\n\nText"), "./cover.png", "a leading image is the cover");
assert.equal(
  coverOf("# Title\n\nIntro paragraph.\n\n![figure](./figure.png)\n"),
  null,
  "an image below the opening text stays in the body"
);
assert.equal(
  coverOf("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![figure](./figure.png)"),
  null,
  "an image below a table stays in the body"
);

// X shows the title on its own, so a heading that repeats it stays out of the body.
const bodyOf = (markdown) =>
  shared.parseMarkdown(markdown).segments.map((segment) => (segment.type === "text" ? `${segment.kind}:${segment.text}` : segment.type));
assert.deepEqual(bodyOf("---\ntitle: T Title\n---\n\n# T Title\n\nText"), ["unstyled:Text"], "a heading that repeats the title is left out");
assert.deepEqual(
  bodyOf("---\ntitle: Agent 高频题 05. 上下文太长\n---\n\n# Agent高频题05.上下文太长\n\nText"),
  ["unstyled:Text"],
  "spacing does not make it a different heading"
);
assert.deepEqual(
  bodyOf("---\ntitle: Claude Fable 5.1 提示词指南（Prompting Claude Fable 5.1）\n---\n\n# Claude Fable 5.1 提示词指南\n\nText"),
  ["unstyled:Text"],
  "a title that adds a translation in brackets still repeats the heading"
);
assert.deepEqual(
  bodyOf("---\ntitle: T Title\n---\n\n# T Title\n\n![cover](./cover.png)\n\nText"),
  ["image", "unstyled:Text"],
  "the cover stays when the repeated heading goes"
);
assert.deepEqual(
  bodyOf("---\ntitle: T Title\n---\n\n# Another heading\n\nText"),
  ["header-one:Another heading", "unstyled:Text"],
  "a different heading stays in the body"
);
assert.deepEqual(
  bodyOf("---\ntitle: T Title\n---\n\nIntro first.\n\n# T Title\n\nText"),
  ["unstyled:Intro first.", "header-one:T Title", "unstyled:Text"],
  "only the heading that opens the article is the title line"
);
assert.deepEqual(
  bodyOf("---\ntitle: AI\n---\n\n# AI in practice\n\nText"),
  ["header-one:AI in practice", "unstyled:Text"],
  "a short title does not swallow a longer heading that starts with it"
);
const noMeta = shared.parseMarkdown("# Only Title\n\nText");
assert.equal(noMeta.title, "Only Title", "without frontmatter the first heading is the title");
assert.deepEqual(noMeta.segments.map((segment) => segment.text), ["Text"], "and it is not repeated in the body");

const readText = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readme = readText("README.md");
const readmeZh = readText("README.zh-CN.md");
const usageZh = readText("docs/usage.zh-CN.md");
const allPublicText = [
  "README.md",
  "README.zh-CN.md",
  "docs/usage.md",
  "docs/usage.zh-CN.md",
  "docs/privacy.md",
  "docs/privacy.zh-CN.md",
  "manifest.json",
  "sidepanel.js"
]
  .map(readText)
  .join("\n");

assert.ok(
  readme.includes("https://chromewebstore.google.com/detail/xposter/iimkimodgdjnnmdopeolboakhjmhfbbj"),
  "English README should recommend the Chrome Web Store listing"
);
assert.ok(readmeZh.includes("Chrome Web Store"), "Chinese README should mention Chrome Web Store");
assert.ok(usageZh.includes("添加至 Chrome"), "Chinese usage guide should explain store installation");
assert.ok(readmeZh.includes("https://x.com/xiaoxiaodong01"), "Chinese README should include author contact");
assert.ok(
  readme.includes("docs/images/buy-me-a-coffee-qr.png"),
  "English README should include the support QR code"
);
assert.ok(
  readmeZh.includes("docs/images/buy-me-a-coffee-qr.png"),
  "Chinese README should include the support QR code"
);
assert.ok(
  !/https:\/\/[^\s"']*cos\.ap-guangzhou\.myqcloud\.com/.test(allPublicText),
  "private image host must not be exposed"
);

console.log("xPoster smoke test passed");
