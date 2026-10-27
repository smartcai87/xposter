// Run with Playwright available: NODE_PATH=/path/to/node_modules node scripts/publish-flow-test.js
// Browser-level regression checks use mock Chrome APIs and never contact X.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const version = require('../manifest.json').version;

async function main() {
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  async function scenario(name, options, run) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 420, height: 900 } });
    const page = await context.newPage();
    const exceptions = [];
    page.on('pageerror', e => exceptions.push(e.message));
    await page.route('https://xposter.test/**', route => {
      const file = path.join(root, new URL(route.request().url()).pathname);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ body: fs.readFileSync(file), contentType: type });
    });
    await page.addInitScript(options => {
      window.testCalls = [];
      window.testOptions = options;
      window.testCopied = '';
      let vault = { configured: false };
      let granted = false;
      let articleId = '123456';
      const pageStatus = () => ({
        ok: true, contentScriptVersion: options.version, isArticleRoute: true, hasEditor: true,
        url: `https://x.com/compose/articles/edit/${articleId}`, vault,
        targetContext: { route: 'editor', hasEditor: true, articleId }
      });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
        if (options.clipboardFails) throw Error('Clipboard denied');
        window.testCopied = text;
      } } });
      window.chrome = {
        storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
        permissions: { contains: async () => granted, request: async request => {
          window.testCalls.push({ type: 'permission', request });
          granted = !options.denyPermission;
          return granted;
        } },
        tabs: {
          query: async () => [{ id: 7, url: pageStatus().url }],
          sendMessage: async (id, message) => {
            window.testCalls.push(message);
            if (message.type === 'xposter:page-status') {
              if (options.statusThrows) throw Error('Could not establish connection. Receiving end does not exist.');
              return pageStatus();
            }
            if (message.type === 'xposter:diagnostics') return {
              ...pageStatus(), main: options.timeout ? { ok: false, error: 'MAIN world bridge timeout' }
                : { ok: true, hasDraftStateNode: true, hasOnFilesAdded: !options.noUploads }
            };
            if (message.type === 'xposter:choose-vault') {
              if (options.cancelFolder) return { ok: false, skipped: true };
              vault = { configured: true, permission: 'granted', name: 'images' };
              if (options.switchArticle) articleId = '999999';
              return { ok: true, name: 'images' };
            }
            if (message.type === 'xposter:import-markdown') {
              await new Promise(resolve => setTimeout(resolve, 100));
              return options.importError ? { ok: false, error: 'Image upload failed: HTTP 403' }
                : { ok: true, summary: { elapsedMs: 100, main: {} } };
            }
          }
        },
        runtime: {
          getManifest: () => ({ version: options.version, optional_host_permissions: ['https://*/*', 'http://*/*'] }),
          onMessage: { addListener: () => {} },
          sendMessage: async message => {
            if (message.type === 'xposter:remote-image-permission-status') {
              return { ok: true, granted: granted ? message.origins : [], missing: granted ? [] : message.origins };
            }
            if (message.type === 'xposter:probe-image') {
              window.testCalls.push(message);
              return options.downloadError ? { ok: false, error: 'HTTP 403' } : { ok: true, bytes: 100, mime: 'image/png' };
            }
          }
        }
      };
    }, { ...options, version });
    await page.goto('https://xposter.test/sidepanel.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#languageSelect').selectOption('zh');
    await run(page);
    assert.deepEqual(exceptions, [], `${name}: no uncaught browser errors`);
    await context.close();
    console.log(`PASS ${name}`);
    passed++;
  }
  const fill = async (page, markdown = '# Test\n\nHello') => {
    await page.locator('#markdown').fill(markdown);
    assert.equal(await page.locator('#importDraft').innerText(), '发布');
    assert.equal(await page.locator('#importDraft').isEnabled(), true);
  };
  const publish = async page => {
    await page.locator('#importDraft').click();
    await page.waitForFunction(() => document.querySelector('#importDraft').getAttribute('aria-busy') === 'false');
  };
  const imports = page => page.evaluate(() => testCalls.filter(c => c.type === 'xposter:import-markdown'));
  try {
    await scenario('paste and auto-check; repeat clicks send once', {}, async page => {
      await fill(page);
      await page.evaluate(() => { const b = document.querySelector('#importDraft'); b.click(); b.click(); });
      await page.waitForFunction(() => document.querySelector('#importHint').textContent.includes('已写入'));
      assert.equal((await imports(page)).length, 1);
      assert.equal(await page.locator('#publishError').isVisible(), false);
      assert.equal(await page.locator('#dockCheck').isVisible(), false);
      await page.screenshot({ path: '/tmp/xposter-publish-success.png' });
    });
    await scenario('local file upload', {}, async page => {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#loadFile').click();
      await (await chooser).setFiles({ name: 'article.md', mimeType: 'text/markdown', buffer: Buffer.from('# Local file\n\nBody') });
      await page.waitForFunction(() => document.querySelector('#markdown').value.includes('Local file'));
      await publish(page);
      assert.equal((await imports(page))[0].markdown, '# Local file\n\nBody');
    });
    await scenario('missing folder prompts then continues', {}, async page => {
      await fill(page, '# Image\n\n![pic](./images/pic.png)');
      await publish(page);
      assert.equal(await page.evaluate(() => testCalls.filter(c => c.type === 'xposter:choose-vault').length), 1);
      assert.equal((await imports(page)).length, 1);
      assert.equal(await page.locator('#clearVaultSettings').isEnabled(), true);
    });
    await scenario('cancel folder stops before writing', { cancelFolder: true }, async page => {
      await fill(page, '# Image\n\n![pic](./images/pic.png)');
      await publish(page);
      assert.equal((await imports(page)).length, 0);
      assert.match(await page.locator('#publishErrorText').innerText(), /取消/);
    });
    await scenario('changed article stops before writing', { switchArticle: true }, async page => {
      await fill(page, '# Image\n\n![pic](./images/pic.png)');
      await publish(page);
      assert.equal((await imports(page)).length, 0);
      assert.match(await page.locator('#publishErrorText').innerText(), /changed|变化/);
    });
    await scenario('table uploader failure is shown and copyable', { noUploads: true }, async page => {
      await fill(page, '# Table\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
      await publish(page);
      assert.equal((await imports(page)).length, 0);
      assert.match(await page.locator('#publishErrorText').innerText(), /hasOnFilesAdded=false/);
      await page.locator('#copyPublishError').click();
      assert.match(await page.evaluate(() => testCopied), /hasOnFilesAdded=false/);
      await page.screenshot({ path: '/tmp/xposter-publish-error.png' });
    });
    await scenario('table image wraps long cells instead of squeezing the text', {}, async page => {
      const drawn = await page.evaluate(async () => {
        const proto = CanvasRenderingContext2D.prototype;
        const original = proto.fillText;
        const calls = [];
        proto.fillText = function (text, x, y, ...rest) {
          calls.push({ text, extraArguments: rest.length });
          return original.call(this, text, x, y, ...rest);
        };
        try {
          const question = '长期记忆用什么存储方案？为什么选 MongoDB，为什么用 Markdown？记忆里明文存用户原话吗？';
          const cells = ['追问方向', '典型问法', '存哪、怎么存', question, '短', '短'];
          const result = await xPosterShared.renderTableImage({
            headers: cells.slice(0, 2), alignments: ['left', 'left'], rows: [cells.slice(2, 4), cells.slice(4)]
          }, 'table.png');
          const image = new Image();
          image.src = `data:${result.mime};base64,${result.base64}`;
          await image.decode();
          return {
            ok: result.ok, calls, width: image.naturalWidth, height: image.naturalHeight,
            expected: cells.join('').replace(/\s/g, '')
          };
        } finally { proto.fillText = original; }
      });
      assert.equal(drawn.ok, true);
      assert.ok(drawn.calls.every(call => call.extraArguments === 0), 'fillText gets no maxWidth, which would squeeze the glyphs');
      assert.ok(drawn.calls.length > 6, 'the long cell is drawn on several lines');
      assert.equal(drawn.calls.map(call => call.text).join('').replace(/\s/g, ''), drawn.expected);
      assert.ok(drawn.width <= 680, `the table image stays within 680px (${drawn.width})`);
      assert.ok(drawn.height > 42 * 3, 'the row that wraps is taller than a row of one line');
    });
    await scenario('bridge timeout is shown', { timeout: true }, async page => {
      await fill(page); await publish(page);
      assert.match(await page.locator('#publishErrorText').innerText(), /MAIN world bridge timeout/);
    });
    await scenario('disconnected script is shown', { statusThrows: true }, async page => {
      await fill(page); await publish(page);
      assert.equal((await imports(page)).length, 0);
      assert.equal(await page.locator('#publishError').isVisible(), true);
    });
    await scenario('X write error and clipboard fallback', { importError: true, clipboardFails: true }, async page => {
      await fill(page); await publish(page);
      assert.match(await page.locator('#publishErrorText').innerText(), /HTTP 403/);
      await page.locator('#copyPublishError').click();
      assert.match(await page.locator('#copyErrorFeedback').innerText(), /手动复制/);
      assert.match(await page.evaluate(() => getSelection().toString()), /HTTP 403/);
    });
    await scenario('remote images authorize and download automatically', {}, async page => {
      await fill(page, '# Web image\n\n![pic](https://images.example.org/pic.png)');
      await publish(page);
      assert.equal((await imports(page)).length, 1);
      assert.equal(await page.evaluate(() => testCalls.filter(c => c.type === 'permission').length), 1);
      assert.equal(await page.evaluate(() => testCalls.filter(c => c.type === 'xposter:probe-image').length), 1);
    });
    await scenario('remote permission denied is shown', { denyPermission: true }, async page => {
      await fill(page, '# Web image\n\n![pic](https://images.example.org/pic.png)');
      await publish(page);
      assert.equal((await imports(page)).length, 0);
      assert.match(await page.locator('#publishErrorText').innerText(), /images.example.org/);
    });
    await scenario('remote download failure stops before writing', { downloadError: true }, async page => {
      await fill(page, '# Web image\n\n![pic](https://images.example.org/pic.png)');
      await publish(page);
      assert.equal((await imports(page)).length, 0);
      assert.match(await page.locator('#publishErrorText').innerText(), /HTTP 403/);
    });
    await scenario('real folder dialog: cancel and select', {}, async page => {
      await page.evaluate(() => {
        chrome.runtime.onMessage.addListener = listener => { window.contentListener = listener; };
        window.showDirectoryPicker = async () => ({ name: 'photos' });
        window.xPosterShared.ensureReadPermission = async () => 'granted';
        window.xPosterShared.saveVaultHandle = async handle => { window.savedFolder = handle.name; };
      });
      await page.addScriptTag({ path: path.join(root, 'src/content.js') });
      const openPrompt = () => page.evaluate(() => {
        window.folderResult = null;
        window.contentListener({ type: 'xposter:choose-vault', count: 2, language: 'zh' }, {}, result => { window.folderResult = result; });
      });
      await openPrompt();
      assert.match(await page.getByRole('dialog').innerText(), /2 张本地图片/);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await page.evaluate(() => folderResult.skipped), true);
      await openPrompt();
      await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
      await page.waitForFunction(() => window.folderResult?.ok);
      assert.equal(await page.evaluate(() => savedFolder), 'photos');
      assert.equal(await page.getByRole('dialog').count(), 0);
    });
    for (const config of [
      { label: 'new database', initialVersion: null, hasHandles: false, expectedVersion: 1 },
      { label: 'existing v1', initialVersion: 1, hasHandles: true, expectedVersion: 1 },
      { label: 'existing v2 (reported failure)', initialVersion: 2, hasHandles: true, expectedVersion: 2 },
      { label: 'future v5', initialVersion: 5, hasHandles: true, expectedVersion: 5 },
      { label: 'v2 missing handles store', initialVersion: 2, hasHandles: false, expectedVersion: 3 }
    ]) {
      await scenario(`real IndexedDB: ${config.label}`, {}, async page => {
        const result = await page.evaluate(async config => {
          const requestResult = request => new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const openDb = async version => {
            const request = version ? indexedDB.open('xposter_local_assets', version) : indexedDB.open('xposter_local_assets');
            request.onupgradeneeded = () => {
              request.result.createObjectStore('foreign-store');
              if (config.hasHandles) request.result.createObjectStore('handles');
            };
            return requestResult(request);
          };
          if (config.initialVersion) {
            const db = await openDb(config.initialVersion);
            const tx = db.transaction(Array.from(db.objectStoreNames), 'readwrite');
            const committed = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
            tx.objectStore('foreign-store').put('keep foreign data', 'sentinel');
            if (config.hasHandles) {
              tx.objectStore('handles').put({ handle: { name: 'old-folder' }, name: 'old-folder' }, 'vault_root');
              tx.objectStore('handles').put('keep other handles', 'sentinel');
            }
            await committed;
            db.close();
          }
          const shared = window.xPosterShared;
          const before = await shared.getVaultRecord();
          await shared.saveVaultHandle({ name: 'selected-folder', kind: 'directory' });
          const saved = await shared.getVaultRecord();
          await shared.clearVaultHandle();
          const cleared = await shared.getVaultRecord();
          const db = await openDb();
          const actualVersion = db.version;
          const foreign = config.initialVersion
            ? await requestResult(db.transaction('foreign-store').objectStore('foreign-store').get('sentinel')) : null;
          const otherHandle = config.hasHandles
            ? await requestResult(db.transaction('handles').objectStore('handles').get('sentinel')) : null;
          db.close();
          // This disposable test origin must have no connections left open.
          const deleted = await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase('xposter_local_assets');
            request.onsuccess = () => resolve(true);
            request.onblocked = () => reject(Error('Leaked database connection'));
            request.onerror = () => reject(request.error);
          });
          return { before, saved, cleared, actualVersion, foreign, otherHandle, deleted };
        }, config);
        assert.equal(result.before?.name || null, config.hasHandles ? 'old-folder' : null);
        assert.equal(result.saved.name, 'selected-folder');
        assert.equal(result.cleared, null);
        assert.equal(result.actualVersion, config.expectedVersion);
        if (config.initialVersion) assert.equal(result.foreign, 'keep foreign data');
        if (config.hasHandles) assert.equal(result.otherHandle, 'keep other handles');
        assert.equal(result.deleted, true);
      });
    }
    await scenario('local image paths: rebase leading parents inside selected root', {}, async page => {
      const results = await page.evaluate(async () => {
        // Use a real browser-managed directory handle and IndexedDB, within
        // this disposable origin. No user files or picker mocks are involved.
        const storage = await navigator.storage.getDirectory();
        const selected = await storage.getDirectoryHandle('selected-root', { create: true });
        const images = await selected.getDirectoryHandle('40_Assets', { create: true });
        const filename = '封面.png';
        const file = await images.getFileHandle(filename, { create: true });
        const writer = await file.createWritable();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
        const outside = await storage.getFileHandle('outside.png', { create: true });
        const outsideWriter = await outside.createWritable();
        await outsideWriter.write('outside selected folder');
        await outsideWriter.close();
        await xPosterShared.saveVaultHandle(selected);
        const sources = [
          '40_Assets/封面.png', './40_Assets/封面.png',
          '../40_Assets/封面.png', '../../40_Assets/封面.png',
          './../40_Assets/封面.png', '..\\40_Assets\\封面.png',
          '../40_Assets/%E5%B0%81%E9%9D%A2.png', '%2e%2e/40_Assets/封面.png',
          '40_Assets/../outside.png', '../40_Assets/../../outside.png',
          '../outside.png', '../', '/40_Assets/封面.png',
          '..%2f40_Assets/封面.png', '../40_Assets/%2e%2e%2foutside.png'
        ];
        const results = [];
        for (const source of sources) results.push({ source, result: await xPosterShared.resolveLocalImage(source) });
        return results;
      });
      for (let i = 0; i < results.length; i++) {
        const { source, result } = results[i];
        if (i < 8) {
          assert.equal(result.ok, true, source);
          assert.equal(result.base64, 'AQID', source);
          assert.equal(result.source, source, 'the original Markdown image reference stays unchanged');
        } else assert.equal(result.ok, false, `must not read outside root or accept invalid path: ${source}`);
      }
    });
    console.log(`${passed} publish workflow scenarios passed`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
