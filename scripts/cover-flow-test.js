// Exercise the real MAIN-world flow with immutable editor snapshots and async
// React commits. No browser account or network request is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function BlockMap(entries = []) {
  const result = Object.create(BlockMap.prototype);
  result.items = new Map(entries);
  return result;
}
BlockMap.prototype.constructor = BlockMap;
BlockMap.prototype.get = function(key) { return this.items.get(key); };
BlockMap.prototype.has = function(key) { return this.items.has(key); };
BlockMap.prototype.set = function(key, value) { const next = BlockMap(this.items); next.items.set(key, value); return next; };
BlockMap.prototype.delete = function(key) { const next = BlockMap(this.items); next.items.delete(key); return next; };
BlockMap.prototype.last = function() { return [...this.items.values()].at(-1); };
BlockMap.prototype.forEach = function(fn) { for (const [key, value] of this.items) if (fn(value, key) === false) break; };
BlockMap.prototype.find = function(fn) { return [...this.items.values()].find(fn); };
function CharList(items = []) {
  const list = Object.create(CharList.prototype);
  list.items = items;
  return list;
}
CharList.prototype.constructor = CharList;
CharList.prototype.push = function(character) { return CharList([...this.items, character]); };
CharList.prototype.find = function(fn) { return this.items.find(fn) || null; };
CharList.prototype.get = function(index) { return this.items[index]; };
CharList.prototype.first = function() { return this.items[0]; };
Object.defineProperty(CharList.prototype, 'size', { get() { return this.items.length; } });
const character = (entity = null) => ({
  getEntity: () => entity,
  set(name, value) { return name === 'entity' ? character(value) : this; },
  getStyle: () => ({ clear() { return this; }, add() { return this; } })
});
class Block {
  constructor(key, text, entity = null) { this.key = key; this.text = text; this.entity = entity; }
  getType() { return this.entity ? 'atomic' : 'unstyled'; }
  getText() { return this.text; }
  getKey() { return this.key; }
  getData() { return { clear() { return this; } }; }
  getCharacterList() { return CharList([character(this.entity)]); }
  merge(config) {
    const first = config.characterList ? config.characterList.items[0] : null;
    const entity = config.characterList ? (first ? first.getEntity() : null) : this.entity;
    return new Block(config.key ?? this.key, config.text ?? this.text, entity);
  }
  findEntityRanges(predicate, fn) { if (predicate(this.getCharacterList().get(0))) fn(0); }
}
class SelectionState {
  static createEmpty() { return new SelectionState(); }
  merge() { return this; }
}
class ContentState {
  constructor(blocks, entities) { this.blocks = blocks; this.entities = entities; }
  getBlockMap() { return this.blocks; }
  getEntity(key) { return this.entities.get(key); }
  createEntity(type, mutability, data) {
    const key = `created${this.entities.size}`;
    const entities = new Map(this.entities);
    entities.set(key, { getType: () => type, getMutability: () => mutability, getData: () => data });
    const next = new ContentState(this.blocks, entities);
    next.lastCreated = key;
    return next;
  }
  getLastCreatedEntityKey() { return this.lastCreated; }
  set(key, value) { return new ContentState(key === 'blockMap' ? value : this.blocks, this.entities); }
}
class EditorState {
  constructor(content) { this.content = content; }
  getCurrentContent() { return this.content; }
  getSelection() { return new SelectionState(); }
  static push(state, content) { return new EditorState(content); }
  static moveSelectionToEnd(state) { return state; }
  static forceSelection(state) { return state; }
}
const entity = id => ({ getType: () => 'MEDIA', getMutability: () => 'IMMUTABLE', getData: () => ({ mediaItems: [{ mediaId: id }] }) });

async function runScenario({ secondImage = false, delayedId = false, graphqlError = false, existingImage = false } = {}) {
  const marker = '__XPOSTER_TEST_IMAGE_1__';
  const second = '__XPOSTER_TEST_IMAGE_2__';
  let blocks = BlockMap([['text', new Block('text', 'Body')], ['marker1', new Block('marker1', marker)]]);
  let entities = new Map();
  if (secondImage) blocks = blocks.set('marker2', new Block('marker2', second));
  if (existingImage) { blocks = blocks.set('existing', new Block('existing', ' ', 'existing-entity')); entities.set('existing-entity', entity('old-id')); }
  let state = new EditorState(new ContentState(blocks, entities));
  let node;
  let uploads = 0;
  let coverId = null;
  let coverConfirmed = false;
  const messages = [];
  const editor = { focus() {}, dispatchEvent: () => true, getBoundingClientRect: () => ({ width: 700, height: 400 }) };
  function mount(nextState) {
    state = nextState;
    node = { props: { editorState: nextState, onChange: value => setTimeout(() => mount(value), 1) } };
    editor.__reactFiber$test = { stateNode: node, memoizedProps: { onFilesAdded }, return: null };
  }
  function onFilesAdded() {
    const index = ++uploads;
    const key = `media${index}`;
    const entityKey = `entity${index}`;
    const nextEntities = new Map(state.content.entities);
    nextEntities.set(entityKey, entity(delayedId ? null : `id${index}`));
    mount(new EditorState(new ContentState(state.content.blocks.set(key, new Block(key, ' ', entityKey)), nextEntities)));
    if (delayedId) setTimeout(() => {
      const ready = new Map(state.content.entities);
      ready.set(entityKey, entity(`id${index}`));
      mount(new EditorState(new ContentState(state.content.blocks, ready)));
    }, 15);
  }
  mount(state);
  const sandbox = {
    File, Uint8Array, atob,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://x.com/compose/articles/edit/123' },
    document: { querySelectorAll: () => [editor], cookie: '' },
    DataTransfer: class { setData() {} },
    ClipboardEvent: class { constructor(type, options) { Object.assign(this, options); } },
    window: { addEventListener() {}, removeEventListener() {}, postMessage: value => messages.push(value) },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      coverId = body.variables.coverMedia.media_id;
      coverConfirmed = !graphqlError;
      // Simulate React replacing its editor instance after a cover update.
      mount(new EditorState(new ContentState(state.content.blocks, state.content.entities)));
      return { ok: true, status: 200, text: async () => JSON.stringify(graphqlError
        ? { errors: [{ message: 'Cover mutation rejected' }] }
        : { data: { article_entity_update_cover_media: { id: '123' } } }) };
    }
  };
  const source = fs.readFileSync(process.env.XPOSTER_MAIN_SOURCE || require.resolve('../src/main-world.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.testRunFlow = runFlow; })();'), sandbox);
  const imageOp = (marker, source) => ({ marker, op: { type: 'image', source, file: { base64: 'eA==', fileName: 'cover.png', mime: 'image/png' } } });
  const plan = [imageOp(marker, './cover.png')];
  if (secondImage) plan.push(imageOp(second, './inline.png'));
  await sandbox.window.testRunFlow({ blocks: [], html: '', plain: '', markerPrefix: '__XPOSTER_TEST_', plan, cover: './cover.png' });
  const summary = messages.findLast(message => message.kind === 'done').summary;
  const remaining = [...state.content.blocks.items.values()];
  assert.equal(uploads, secondImage ? 2 : 1, 'each image uploads only once');
  assert.equal(coverId, 'id1', 'cover reuses the first upload after its media ID is ready');
  assert.equal(remaining.some(block => block.text.startsWith('__XPOSTER_TEST_')), false, 'no placeholder remains');
  assert.equal(remaining.some(block => block.key === 'text'), true, 'article text is preserved');
  if (graphqlError) {
    assert.equal(coverConfirmed, false);
    assert.equal(summary.cover.graphql.ok, false, 'HTTP 200 with GraphQL errors must not count as success');
    assert.equal(remaining.some(block => block.entity === 'entity1'), true, 'keep image if cover assignment fails');
  } else {
    assert.equal(coverConfirmed, true);
    assert.equal(summary.cover.bodyBlockDeleted.ok, true);
    assert.equal(remaining.some(block => block.entity === 'entity1'), false, 'duplicate body cover stays removed after cleanup/render');
  }
  if (secondImage) assert.equal(remaining.some(block => block.entity === 'entity2'), true, 'other inline image is preserved');
  if (existingImage) assert.equal(remaining.some(block => block.entity === 'existing-entity'), true, 'existing unrelated media is preserved');
}
const plain = value => JSON.parse(JSON.stringify(value)); // summaries come from the vm realm

// X has been seen to swap in an earlier editor state (just "x") as an upload
// finishes, which drops the article that was written after it. replace:
// 'after-upload' swaps it in as each upload completes; 'before-upload' swaps it
// in between uploads; stuck: X then ignores new edits.
async function runReplacedScenario({ replace = 'after-upload', stuck = false, images = 2 } = {}) {
  const prefix = '__XPOSTER_TEST_';
  const markers = [`${prefix}IMAGE_0__`, `${prefix}IMAGE_1__`].slice(0, images);
  const paragraphs = Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1}`);
  const texts = [...paragraphs.slice(0, 3), markers[0], ...paragraphs.slice(3, 6), ...markers.slice(1), ...paragraphs.slice(6)];
  const olderCopy = BlockMap([['x', new Block('x', 'x')]]);
  let state = new EditorState(new ContentState(olderCopy, new Map()));
  let node;
  let uploads = 0;
  let frozen = false;
  const messages = [];
  const editor = { focus() {}, dispatchEvent: () => true, getBoundingClientRect: () => ({ width: 700, height: 400 }) };
  function mount(nextState) {
    state = nextState;
    node = { props: { editorState: nextState, onChange: value => { if (!frozen) setTimeout(() => mount(value), 1); } } };
    editor.__reactFiber$test = { stateNode: node, memoizedProps: { onFilesAdded }, return: null };
  }
  function rebuildFromOlderCopy() {
    let blocks = olderCopy;
    state.content.blocks.forEach((block, key) => { if (block.entity) blocks = blocks.set(key, block); });
    mount(new EditorState(new ContentState(blocks, state.content.entities)));
    frozen = stuck;
  }
  function onFilesAdded() {
    const index = ++uploads;
    const key = `media${index}`;
    const entities = new Map(state.content.entities);
    entities.set(`entity${index}`, entity(`id${index}`));
    mount(new EditorState(new ContentState(state.content.blocks.set(key, new Block(key, ' ', `entity${index}`)), entities)));
    if (replace === 'after-upload') setTimeout(rebuildFromOlderCopy, 1);
  }
  mount(state);
  const sandbox = {
    File, Uint8Array, atob,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://x.com/compose/articles/edit/123' },
    document: { querySelectorAll: () => [editor], cookie: '' },
    DataTransfer: class { setData() {} },
    ClipboardEvent: class { constructor(type, options) { Object.assign(this, options); } },
    window: {
      addEventListener() {}, removeEventListener() {},
      postMessage: value => {
        messages.push(value);
        if (replace === 'before-upload' && value.kind === 'progress' && value.text.startsWith('Uploading image 2/')) rebuildFromOlderCopy();
      }
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { ok: true } }) })
  };
  const source = fs.readFileSync(process.env.XPOSTER_MAIN_SOURCE || require.resolve('../src/main-world.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.testRunFlow = runFlow; })();'), sandbox);
  const imageOp = (marker, source) => ({ marker, op: { type: 'image', source, file: { base64: 'eA==', fileName: 'figure.png', mime: 'image/png' } } });
  const plan = markers.map((marker, index) => imageOp(marker, index ? './inline.png' : './cover.png'));
  await sandbox.window.testRunFlow({
    blocks: texts.map(text => ({ type: 'unstyled', text, inlineStyleRanges: [], links: [] })),
    html: '', plain: '', markerPrefix: prefix, plan, cover: stuck ? null : './cover.png'
  });
  const summary = messages.findLast(message => message.kind === 'done').summary;
  const remaining = [...state.content.blocks.items.values()];
  if (stuck) {
    assert.equal(summary.bodyLost, true, 'a body X will not let us restore is reported as lost');
    assert.equal(summary.imgFail, images, 'uploads that cannot be placed are reported');
    assert.deepEqual(plain(summary.body), { expected: 8, actual: 1 });
    return;
  }
  assert.equal(uploads, images, 'a restored upload is not uploaded again');
  assert.equal(summary.imgFail, 0);
  assert.equal(summary.imgOk, images);
  assert.deepEqual(plain(summary.bodyRestores.map(item => item.stage)), replace === 'after-upload' ? Array(images).fill('after-upload') : ['before-upload']);
  assert.equal(summary.bodyLost, false);
  assert.deepEqual(plain(summary.body), { expected: 8, actual: 8 });
  for (const paragraph of paragraphs) assert.equal(remaining.some(block => block.text === paragraph), true, `${paragraph} is back`);
  assert.equal(remaining.some(block => block.text === 'x'), false, 'the older copy is not left behind');
  assert.equal(remaining.some(block => block.text.startsWith(prefix)), false, 'no placeholder remains');
  assert.equal(summary.cover.bodyBlockDeleted.ok, true);
  assert.equal(remaining.filter(block => block.entity).length, images - 1, 'only the non-cover images stay in the body');
  const order = remaining.map(block => block.entity ? '[image]' : block.text);
  if (images === 2) assert.equal(order.indexOf('[image]'), order.indexOf('Paragraph 6') + 1, 'second image sits at its placeholder');
}

(async () => {
  for (const [name, options] of [
    ['async editor commits do not restore removed cover', {}],
    ['wait for upload media ID before setting cover', { delayedId: true }],
    ['keep other inline image', { secondImage: true }],
    ['keep unrelated existing media', { existingImage: true }],
    ['GraphQL failure preserves body image', { graphqlError: true }]
  ]) { await runScenario(options); console.log(`PASS ${name}`); }
  for (const [name, options] of [
    ['restore article when X replaces it after each upload', {}],
    ['restore article when X replaces it between uploads', { replace: 'before-upload' }],
    ['report a body X will not let us restore', { stuck: true, images: 1 }]
  ]) { await runReplacedScenario(options); console.log(`PASS ${name}`); }
})().catch(error => { console.error(error); process.exitCode = 1; });
