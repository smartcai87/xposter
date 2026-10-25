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
CharList.prototype.clear = function() { return CharList([]); };
CharList.prototype.concat = function(items) { return CharList([...this.items, ...items]); };
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
    const entity = config.characterList ? (first?.getEntity?.() ?? null) : this.entity;
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
    ...fastClock(),
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
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.testRunFlow = runFlow; window.testLayoutReport = layoutReport; })();'), sandbox);
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

// The flow waits for X in real seconds. Run its clock 30 times faster so the
// scenarios finish quickly while every wait keeps its proportions.
function fastClock(factor = 30) {
  const realNow = Date.now.bind(Date);
  const start = realNow();
  return {
    Date: { now: () => start + (realNow() - start) * factor },
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms || 0) / factor),
    clearTimeout
  };
}

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
    ...fastClock(),
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
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.testRunFlow = runFlow; window.testLayoutReport = layoutReport; })();'), sandbox);
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

// X can rebuild its editor from the copy it saved when the title or cover call
// finishes. That copy has each image where X inserted it (the end of the article)
// and none of the placement xPoster only made locally. rebuild: 'saved-copy'
// brings that copy back after the cover call; 'renumber' changes entity keys
// after each upload; 'drop-media' brings back a copy without the first image;
// 'late-placeholders' brings the copy back after the placeholders were removed.
async function runLateRebuildScenario({ rebuild }) {
  const prefix = '__XPOSTER_TEST_';
  const markers = [`${prefix}TABLE_0__`, `${prefix}IMAGE_1__`];
  const paragraphs = Array.from({ length: 8 }, (_, index) => `Paragraph ${index + 1}`);
  const texts = [...paragraphs.slice(0, 3), markers[0], ...paragraphs.slice(3, 6), markers[1], ...paragraphs.slice(6)];
  let state = new EditorState(new ContentState(BlockMap([['x', new Block('x', 'x')]]), new Map()));
  let node;
  let uploads = 0;
  let saved = null;
  let cleaning = false;
  let rebuiltLate = false;
  const messages = [];
  const editor = { focus() {}, dispatchEvent: () => true, getBoundingClientRect: () => ({ width: 700, height: 400 }) };
  function mount(nextState) {
    state = nextState;
    node = {
      props: {
        editorState: nextState,
        onChange: value => {
          setTimeout(() => mount(value), 1);
          if (cleaning && rebuild === 'late-placeholders' && !rebuiltLate) {
            rebuiltLate = true;
            setTimeout(() => mount(saved), 3);
          }
        }
      }
    };
    editor.__reactFiber$test = { stateNode: node, memoizedProps: { onFilesAdded }, return: null };
  }
  function renumber() {
    let blocks = BlockMap();
    const entities = new Map();
    state.content.blocks.forEach((block, key) => {
      if (!block.entity) { blocks = blocks.set(key, block); return; }
      const renamed = block.entity.replace('entity', 'renumbered');
      entities.set(renamed, state.content.entities.get(block.entity));
      blocks = blocks.set(key, new Block(key, ' ', renamed));
    });
    mount(new EditorState(new ContentState(blocks, entities)));
  }
  function onFilesAdded() {
    const index = ++uploads;
    // X renumbers the entity keys of earlier images just as the next upload starts.
    if (rebuild === 'renumber-before-insert' && index === 2) renumber();
    const key = `media${index}`;
    const entities = new Map(state.content.entities);
    entities.set(`entity${index}`, entity(`id${index}`));
    // X inserts at the end of the article and saves what it did by itself.
    mount(new EditorState(new ContentState(state.content.blocks.set(key, new Block(key, ' ', `entity${index}`)), entities)));
    saved = state;
    if (rebuild === 'renumber') setTimeout(() => setTimeout(renumber, 5), 5);
  }
  mount(state);
  const sandbox = {
    File, Uint8Array, atob,
    ...fastClock(),
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://x.com/compose/articles/edit/123' },
    document: { querySelectorAll: () => [editor], cookie: '' },
    DataTransfer: class { setData() {} },
    ClipboardEvent: class { constructor(type, options) { Object.assign(this, options); } },
    window: {
      addEventListener() {}, removeEventListener() {},
      postMessage: value => {
        messages.push(value);
        if (value.kind === 'progress' && value.text === 'Cleaning up import markers...') cleaning = true;
      }
    },
    fetch: async () => {
      if (rebuild === 'saved-copy') mount(saved);
      if (rebuild === 'drop-media') mount(new EditorState(new ContentState(saved.content.blocks.delete('media1'), saved.content.entities)));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { ok: true } }) };
    }
  };
  const source = fs.readFileSync(process.env.XPOSTER_MAIN_SOURCE || require.resolve('../src/main-world.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.testRunFlow = runFlow; window.testLayoutReport = layoutReport; })();'), sandbox);
  const imageOp = (marker, source) => ({ marker, op: { type: 'image', source, file: { base64: 'eA==', fileName: 'figure.png', mime: 'image/png' } } });
  await sandbox.window.testRunFlow({
    blocks: texts.map(text => ({ type: 'unstyled', text, inlineStyleRanges: [], links: [] })),
    html: '', plain: '', markerPrefix: prefix, cover: './cover.png',
    plan: [imageOp(markers[0], undefined), imageOp(markers[1], './cover.png')]
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  const summary = messages.findLast(message => message.kind === 'done').summary;
  const remaining = [...state.content.blocks.items.values()];
  const order = remaining.map(block => block.entity ? '[image]' : block.text);
  assert.equal(summary.imgFail, 0);
  assert.equal(uploads, 2, 'nothing is uploaded twice');
  for (const paragraph of paragraphs) assert.equal(order.includes(paragraph), true, `${paragraph} is still there`);
  assert.equal(order.filter(item => item === '[image]').length, 1, 'only the table image stays in the body; the other is the cover');
  assert.equal(order.indexOf('[image]'), order.indexOf('Paragraph 3') + 1, 'the table image sits at its placeholder');
  assert.equal(order[order.indexOf('[image]') + 1], 'Paragraph 4');
  assert.equal(order.some(item => item.startsWith(prefix)), false, 'no placeholder remains');
  assert.equal(summary.markersLeft, 0);
  assert.equal(summary.cover.bodyBlockDeleted.ok, true);
  if (rebuild === 'drop-media') assert.equal(summary.recreatedImages, 1, 'a dropped image is rebuilt from its upload data');
}


// A closer model of X for the placement tests. The editor remembers its caret;
// X inserts an uploaded image at the caret of the editor state its upload
// handler was last rendered with (and sets that state, so a stale handler also
// throws away whatever came after it); React keeps two fibers per component, so
// the one the DOM node points at can be a commit behind; and X saves the
// article to a server copy a little after each change.
class RichSelection extends SelectionState {
  constructor(key = null) { super(); this.key = key; }
  static createEmpty(key) { return new RichSelection(key); }
  getAnchorKey() { return this.key; }
  getFocusKey() { return this.key; }
  getAnchorOffset() { return 0; }
  getFocusOffset() { return 0; }
}
class RichState extends EditorState {
  constructor(content, key = null) { super(content); this.key = key; }
  getSelection() { return new RichSelection(this.key); }
  static push(state, content) { return new RichState(content, state.key); }
  // Draft cannot put a caret in an editor with no block.
  static moveSelectionToEnd(state) { return new RichState(state.content, state.content.getBlockMap().last().getKey()); }
  static forceSelection(state, selection) { return new RichState(state.content, selection.key); }
}
const mediaIdFor = index => `20000000000000000${String(index).padStart(2, '0')}`;
const withBlocks = (content, entries, entities = content.entities) => {
  let blocks = BlockMap();
  for (const [key, block] of entries) blocks = blocks.set(key, block);
  return new ContentState(blocks, entities);
};
const blocksOf = content => [...content.getBlockMap().items.entries()];

function toRaw(content) {
  const blocks = [];
  const entityMap = [];
  content.getBlockMap().forEach((block, key) => {
    if (block.getType() === 'atomic') {
      const found = content.getEntity(block.entity);
      entityMap.push({ key: String(entityMap.length), value: { type: found.getType(), mutability: 'IMMUTABLE', data: found.getData() } });
      blocks.push({ key, type: 'atomic', text: ' ', entityRanges: [{ key: entityMap.length - 1, offset: 0, length: 1 }], inlineStyleRanges: [], data: {} });
    } else {
      blocks.push({ key, type: 'unstyled', text: block.getText(), entityRanges: [], inlineStyleRanges: [], data: {} });
    }
  });
  return { blocks, entity_map: entityMap };
}

async function runNativeScenario({
  commitsBefore = 0, splitEmpty = false, serverRebuild = false, autosave = 'debounced', images = 3, firstIsCover = true, endAtCaret = false, failImage = 0, titleReload = 0,
  commitDelay = 0, rekey = false, zombie = false, coverOnly = false, nudgeDamage = false, startTwice = false, swapAfter = 0,
  saveDelay = 1500, saveThrottle = 0, saveOnInsert = false, ignoreCall = 0, slowImage = 0, dupCopy = false, foreignCopy = false, lateStray = false
} = {}) {
  const prefix = '__XPOSTER_TEST_';
  const markers = Array.from({ length: images }, (_, index) => `${prefix}IMAGE_${index}__`);
  const paragraphs = coverOnly ? [] : Array.from({ length: images * 3 + 2 }, (_, index) => `Paragraph ${index + 1}`);
  const texts = [];
  if (coverOnly) texts.push(markers[0]);
  else {
    markers.forEach((marker, index) => texts.push(...paragraphs.slice(index * 3, index * 3 + 3), marker));
    texts.push(...paragraphs.slice(images * 3));
  }
  let overlaps = 0;
  let serverMissed = 0;
  let pendingCommits = 0;
  // X numbers its entities again from 1: in document order, or from the end.
  const rekeyByOrder = content => {
    let blocks = BlockMap();
    const entities = new Map();
    const media = blocksOf(content).filter(([, block]) => block.entity).map(([key]) => key);
    const order = rekey === 'reverse' ? [...media].reverse() : media;
    content.getBlockMap().forEach((block, key) => {
      if (!block.entity) { blocks = blocks.set(key, block); return; }
      const n = order.indexOf(key) + 1;
      entities.set(`entity${n}`, content.getEntity(block.entity));
      blocks = blocks.set(key, new Block(key, ' ', `entity${n}`));
    });
    return new ContentState(blocks, entities);
  };

  const clock = fastClock();
  const events = [];
  let state = new RichState(new ContentState(BlockMap([['x', new Block('x', 'x')]]), new Map()), 'x');
  let server = state.content;
  let saveTimer = null;
  let titleSet = false;
  let uploads = 0;
  let commits = 0;
  const node = { props: null };
  const root = { current: null };
  const roots = [0, 1].map(() => ({ tag: 3, stateNode: root, return: null, alternate: null }));
  const parents = [0, 1].map(() => ({ return: null, alternate: null }));
  const children = [0, 1].map(() => ({ return: null, alternate: null, stateNode: node, memoizedProps: {} }));
  [roots, parents, children].forEach(([a, b]) => { a.alternate = b; b.alternate = a; });
  [0, 1].forEach(side => { parents[side].return = roots[side]; children[side].return = parents[side]; roots[side].child = parents[side]; parents[side].child = children[side]; });
  root.current = roots[0];
  const editor = { focus() {}, dispatchEvent: () => true, getBoundingClientRect: () => ({ width: 700, height: 400 }), __reactFiber$test: children[0] };

  // Which image an upload is for: the caret sits on that image's placeholder.
  const markerOfUpload = index => uploadMarkers[index - 1];
  const uploadMarkers = [];
  // X saves a moment after the first change, then at most once every
  // saveThrottle ms: the copy can hold an image's placeholder for a while after
  // the upload has ended. Without saveThrottle every change restarts the wait.
  let lastSaveAt = -Infinity;
  let saveScheduled = false;
  const scheduleSave = () => {
    if (autosave !== 'debounced') return;
    if (saveThrottle) {
      if (saveScheduled) return;
      saveScheduled = true;
      const wait = Math.max(saveDelay, lastSaveAt + saveThrottle - clock.Date.now());
      clock.setTimeout(() => { server = state.content; lastSaveAt = clock.Date.now(); saveScheduled = false; }, wait);
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = clock.setTimeout(() => { server = state.content; }, saveDelay);
  };
  function commit(next) {
    state = next;
    node.props = {
      editorState: next,
      onChange: value => {
        // An edit made while the one before has not been committed was worked
        // out from a state that is already out of date.
        if (pendingCommits > 0) overlaps += 1;
        pendingCommits += 1;
        const apply = () => { pendingCommits -= 1; commit(value); };
        if (commitDelay) clock.setTimeout(apply, commitDelay);
        else setTimeout(apply, 1);
      }
    };
    const side = root.current === roots[0] ? 1 : 0;
    parents[side].memoizedProps = { onFilesAdded: makeHandler(next) };
    children[side].stateNode = node;
    root.current = roots[side];
    scheduleSave();
  }
  function makeHandler(bound) {
    return () => {
      const index = ++uploads;
      events.push(`upload${index}`);
      // The image before this one has to be in X's copy with its media ID by now.
      if (index >= 3 && !JSON.stringify(toRaw(server)).includes(mediaIdFor(index - 1))) serverMissed += 1;
      const entityKey = `entity${index}`;
      const media = new Block(`media${index}`, ' ', entityKey);
      uploadMarkers[index - 1] = bound.content.getBlockMap().get(bound.key)?.getText();
      // X does not react to this call at all.
      if (ignoreCall && index === ignoreCall) return;
      const entries = [];
      let placed = false;
      for (const [key, block] of blocksOf(bound.content)) {
        if (key === bound.key && !endAtCaret) {
          if (splitEmpty) entries.push([`empty${index}`, new Block(`empty${index}`, '')]);
          entries.push([media.key, media]);
          placed = true;
        }
        entries.push([key, block]);
      }
      if (!placed) entries.push([media.key, media]);
      const entities = new Map(bound.content.entities);
      entities.set(entityKey, entity(null));
      commit(new RichState(withBlocks(bound.content, entries, entities), bound.key));
      // The upload that was given up on ends now, while this one is still loading.
      if (lateStray && index === 3) clock.setTimeout(() => {
        const entities = new Map(state.content.entities);
        entities.set('strayEntity', entity(mediaIdFor(2)));
        commit(new RichState(withBlocks(state.content, [...blocksOf(state.content), ['stray', new Block('stray', ' ', 'strayEntity')]], entities), state.key));
      }, 300);
      // X saves the article at once when an image block is added, and the end of
      // the upload (its media ID) only with the next, slow, save.
      if (saveOnInsert) server = state.content;
      const slow = slowImage && markerOfUpload(index) === markers[slowImage - 1];
      clock.setTimeout(() => {
        // The upload of this image never completes: X keeps its loading placeholder.
        if (failImage && markerOfUpload(index) === markers[failImage - 1]) return;
        const ready = new Map(state.content.entities);
        ready.set(entityKey, entity(mediaIdFor(index)));
        let content = new ContentState(state.content.blocks, ready);
        if (serverRebuild) {
          // X reloads the editor from the copy it saved, with the new image added.
          const saved = blocksOf(server).filter(([key]) => key !== media.key);
          content = withBlocks(server, [...saved, [media.key, media]], ready);
        }
        commit(new RichState(content, state.key));
        // X swaps in the old editor ("x") with the uploaded image, a moment after the upload.
        if (swapAfter && index === 1) clock.setTimeout(() => {
          const uploaded = new Block(media.key, ' ', entityKey);
          commit(new RichState(withBlocks(state.content, [['x', new Block('x', 'x')], [uploaded.key, uploaded]], state.content.entities), 'x'));
        }, swapAfter);
        if (rekey) clock.setTimeout(() => commit(new RichState(rekeyByOrder(state.content), state.key)), 150);
        // X adds another block for the upload once it ends: the same image again,
        // or one more (the late end of an upload that was given up on).
        if (dupCopy || foreignCopy) clock.setTimeout(() => {
          const entities = new Map(state.content.entities);
          const copyKey = foreignCopy ? `late${index}` : entityKey;
          if (foreignCopy) entities.set(copyKey, entity(mediaIdFor(80 + index)));
          commit(new RichState(withBlocks(state.content, [...blocksOf(state.content), [`copy${index}`, new Block(`copy${index}`, ' ', copyKey)]], entities), state.key));
        }, 100);
        // A copy taken in the middle of an upload brings its loading placeholder back.
        if (zombie && index === 2) clock.setTimeout(() => {
          const entities = new Map(state.content.entities);
          entities.set('zombieEntity', entity(null));
          commit(new RichState(withBlocks(state.content, [...blocksOf(state.content), ['zombie', new Block('zombie', ' ', 'zombieEntity')]], entities), state.key));
        }, 200);
      }, slow ? 80000 : 800);
    };
  }
  commit(state);
  for (let extra = 0; extra < commitsBefore; extra += 1) commit(state);

  const messages = [];
  const listeners = [];
  const sandbox = {
    File, Uint8Array, atob,
    ...clock,
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://x.com/compose/articles/edit/123' },
    document: {
      querySelectorAll: () => [editor],
      cookie: '',
      execCommand: (command) => {
        if (autosave === 'nudged') clock.setTimeout(() => { server = state.content; }, 300);
        if (nudgeDamage) {
          // X swallows the typed space but deletes a real character.
          const entries = blocksOf(state.content);
          const last = [...entries].reverse().find(([, block]) => !block.entity);
          if (last && command === 'delete') {
            commit(new RichState(withBlocks(state.content, entries.map(([key, block]) => [key, key === last[0] ? new Block(key, block.text.slice(0, -1)) : block])), state.key));
          }
        }
        return true;
      }
    },
    DataTransfer: class { setData() {} },
    ClipboardEvent: class { constructor(type, options) { Object.assign(this, options); } },
    window: {
      addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
      removeEventListener() {},
      postMessage: value => messages.push(value)
    },
    fetch: async (url) => {
      const respond = json => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
      if (/UpdateCoverMedia/.test(url)) { events.push('cover'); return respond({ data: { ok: true } }); }
      if (!titleSet && titleReload) {
        // The reply to X's own title mutation reloads the editor from the saved copy, late.
        clock.setTimeout(() => commit(new RichState(server, 'x')), titleReload);
      }
      events.push(titleSet ? 'read' : 'title');
      titleSet = true;
      return respond({ data: { articleentity_update_title: { content_state: toRaw(server) } } });
    }
  };
  const source = fs.readFileSync(process.env.XPOSTER_MAIN_SOURCE || require.resolve('../src/main-world.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.testRunFlow = runFlow; window.testLayoutReport = layoutReport; })();'), sandbox);
  const imageOp = (marker, index) => ({ marker, op: { type: 'image', source: index === 0 && firstIsCover ? './cover.png' : `./figure-${index}.png`, file: { base64: 'eA==', fileName: `figure-${index}.png`, mime: 'image/png' } } });
  const payload = {
    blocks: texts.map(text => ({ type: 'unstyled', text, inlineStyleRanges: [], links: [] })),
    html: '', plain: '', markerPrefix: prefix, title: 'Test title', cover: firstIsCover ? './cover.png' : null,
    plan: markers.map(imageOp)
  };
  if (startTwice) {
    // Ask for a second import while the first is still running, the way the page does.
    const ask = () => listeners.forEach(listener => listener({ source: sandbox.window, data: { source: 'xposter', kind: 'run', payload } }));
    ask();
    ask();
    for (let wait = 0; wait < 4000 && !messages.some(message => message.kind === 'done'); wait += 1) await new Promise(resolve => setTimeout(resolve, 5));
  } else {
    await sandbox.window.testRunFlow(payload);
  }
  const refused = messages.filter(message => message.kind === 'error').map(message => message.error);
  const summary = messages.findLast(message => message.kind === 'done').summary;
  const order = blocksOf(state.content).map(([, block]) => block.entity ? '[image]' : block.text);
  const expected = [];
  paragraphs.forEach((paragraph, index) => {
    expected.push(paragraph);
    if (index % 3 === 2 && index / 3 < images && !(firstIsCover && index === 2)) expected.push(failImage && index === failImage * 3 - 1 ? '[image upload failed]' : '[image]');
  });
  const finalIds = blocksOf(state.content).filter(([, block]) => block.entity).map(([, block]) => state.content.getEntity(block.entity).getData().mediaItems[0].mediaId);
  return { summary, order, expected, events, uploads, server, state, overlaps, refused, serverMissed, finalIds };
}

const checkNative = (result, images, extra = {}) => {
  const { summary, order, expected, events, uploads } = result;
  assert.equal(uploads, extra.calls ?? images, extra.failed ? 'an upload X is still working on is waited for, not started again' : 'every image uploads exactly once');
  assert.equal(summary.imgFail, extra.failed ? 1 : 0);
  assert.deepEqual(order, expected, 'every image sits after the paragraph its placeholder followed, with no placeholder or empty line left');
  assert.equal(summary.layout.ok, true, `layout check: ${summary.layout.problems}`);
  assert.equal(summary.markersLeft, 0);
  assert.equal(summary.bodyLost, false);
  assert.equal(events[0], 'title', 'the title is set before anything is written');
  assert.ok(events.indexOf('title') < events.indexOf('upload1'));
  assert.ok(Array.isArray(summary.trace) && summary.trace.some(line => line.includes('uploaded')), 'the report says what happened');
  if (extra.native) assert.equal(summary.relocatedImages, 0, 'X put each image where the caret was; nothing had to be moved');
  if (extra.saved) {
    assert.equal(summary.bodyRestores.length, 0, 'X had the article saved before it reloaded from its copy, so nothing was lost');
    assert.ok(summary.saved.matched >= images, 'every wait for X to save succeeded');
  }
  if (extra.restored) assert.ok(summary.bodyRestores.length > 0, 'the article had to be put back');
  if (extra.slowCommits) assert.equal(result.overlaps, 0, 'no edit was made before the one before it had committed');
  if (extra.noRecreate) assert.equal(summary.recreatedImages, 0, 'no image had to be rebuilt');
  if (extra.noZombies) {
    assert.equal(summary.recreatedImages, 0, 'no image had to be rebuilt');
    assert.equal(summary.trace.some(line => /extra image block/.test(line)), false, 'X was never left with an image it had not finished');
    assert.equal(summary.bodyRestores.length, 0);
  }
  if (extra.serverHasIds) assert.equal(result.serverMissed, 0, 'the next image was not started before X had the previous one with its media ID');
  if (extra.finalIds) assert.deepEqual(result.finalIds, extra.finalIds, 'each place holds the image that was uploaded for it');
  if (extra.removedExtras) assert.ok(summary.trace.some(line => /extra image block/.test(line)), 'the extra image was found and taken out');
  if (extra.nudgeOnce) assert.equal(summary.saved.nudges, 1, 'a prompt that damaged the article is not tried again');
  if (extra.refused) assert.ok(result.refused.length === 1 && /still running/.test(result.refused[0]), 'the second import is refused');
  if (extra.cover !== false) {
    assert.ok(events.indexOf('cover') > events.indexOf('upload1') && (images < 2 || events.indexOf('cover') < events.indexOf('upload2')), 'the cover is set right after its own upload');
    assert.equal(summary.cover.bodyBlockDeleted.ok, true);
  }
};


// The final check names an image that is not next to the text the Markdown puts
// it beside, whatever else X did to the article.
function runLayoutChecks() {
  const prefix = '__XPOSTER_TEST_';
  const sandbox = { console: { log() {}, warn() {}, error() {} }, window: { addEventListener() {}, removeEventListener() {}, postMessage() {} } };
  const source = fs.readFileSync(process.env.XPOSTER_MAIN_SOURCE || require.resolve('../src/main-world.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.testLayoutReport = layoutReport; window.testServerItems = serverArticleItems; })();'), sandbox);
  const planBlocks = ['Intro', 'First', `${prefix}IMAGE_0__`, 'Second', 'Third', `${prefix}IMAGE_1__`, 'Last'];
  const payload = { markerPrefix: prefix, blocks: planBlocks.map(text => ({ text })), plan: [`${prefix}IMAGE_0__`, `${prefix}IMAGE_1__`].map(marker => ({ marker })) };
  const uploads = [
    { marker: `${prefix}IMAGE_0__`, mediaId: '111', index: 1, label: 'a.png' },
    { marker: `${prefix}IMAGE_1__`, mediaId: '222', index: 2, label: 'b.png' }
  ];
  const report = (lines, extra = {}) => {
    let blocks = BlockMap();
    const entities = new Map();
    lines.forEach((line, index) => {
      const key = `b${index}`;
      if (line.startsWith('[')) {
        entities.set(`e${index}`, entity(line.slice(1, -1)));
        blocks = blocks.set(key, new Block(key, ' ', `e${index}`));
      } else {
        blocks = blocks.set(key, new Block(key, line));
      }
    });
    const node = { props: { editorState: new EditorState(new ContentState(blocks, entities)) } };
    return plain(sandbox.window.testLayoutReport(node, payload, extra.uploads || uploads, [], false, extra.failed));
  };
  assert.equal(report(['Intro', 'First', '[111]', 'Second', 'Third', '[222]', 'Last']).ok, true);
  assert.equal(report(['Intro', 'First', '', '[111]', 'Second', 'Third', '[222]', 'Last']).ok, true, 'empty lines do not matter');
  const wrong = report(['Intro', 'First', 'Second', '[111]', 'Third', '[222]', 'Last']);
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems[0], /image 1 \(a\.png\) is between "Second" and "Third"/);
  assert.match(wrong.problems[0], /Markdown has it between "First" and "Second"/);
  assert.equal(report(['Intro', 'First', '[222]', 'Second', 'Third', '[111]', 'Last']).problems.some(item => /different order/.test(item)), true);
  assert.equal(report(['Intro', 'First', '[111]', 'Second', 'Third', 'Last']).problems[0], 'image 2 (b.png) is not in the article');
  assert.equal(report(['Intro', 'First', '[111]', 'Second', 'Third', '[222]', 'Last', '[333]'], { uploads: [...uploads, { marker: 'x', mediaId: '333', index: 3, label: 'c.png', dropped: true }] }).problems[0], 'the cover image (image 3) is also still in the article body');
  assert.equal(report(['Intro', 'First', '[111]', 'Second', 'Third', '[222]', 'Last', 'Extra line X added']).ok, true, 'a line X added elsewhere does not hide a correct placement');
  // The saved copy X returns: whatever shape the entity has, the media ID is the
  // image's, never the local ID that sits beside it.
  const reply = (entityMap, entityKey = 0) => ({ data: { update: { content_state: {
    blocks: [{ type: 'unstyled', text: 'One' }, { type: 'atomic', text: ' ', entityRanges: [{ key: entityKey, offset: 0, length: 1 }] }],
    entity_map: entityMap
  } } } });
  const mediaItems = [{ localMediaId: '1234567890123', mediaCategory: 'DraftTweetImage', mediaId: '2000000000000000007' }];
  for (const [shape, map] of [
    ['array of entries', [{ key: '0', value: { type: 'MEDIA', mutability: 'Immutable', data: { mediaItems } } }]],
    ['entity map object', { 0: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems } } }],
    ['data as JSON text', [{ key: '0', value: { type: 'MEDIA', data: JSON.stringify({ mediaItems }) } }]],
    ['key and value pairs', [{ key: '0', value: { type: 'MEDIA', data: [{ key: 'mediaItems', value: [[{ key: 'localMediaId', value: '1234567890123' }, { key: 'mediaId', value: '2000000000000000007' }]] }] } }]]
  ]) {
    const items = plain(sandbox.window.testServerItems(reply(map)));
    assert.ok(items[1].raw.includes('2000000000000000007'), `${shape}: the entity text is kept to look for the ID in`);
    assert.deepEqual(items.map(({ raw, ...item }) => item), [{ kind: 'text', text: 'One' }, { kind: 'atomic', type: 'MEDIA', mediaId: '2000000000000000007' }], shape);
  }
  assert.equal(plain(sandbox.window.testServerItems({ data: { nothing: true } })), null, 'a reply without the article is not read');
  // The second image failed: its placeholder became a line of text, and that line
  // counts as text beside the image after it.
  const failedBlocks = ['Intro', `${prefix}IMAGE_0__`, `${prefix}IMAGE_1__`, `${prefix}IMAGE_2__`, 'Last'];
  const failedPayload = { markerPrefix: prefix, blocks: failedBlocks.map(text => ({ text })), plan: [0, 1, 2].map(index => ({ marker: `${prefix}IMAGE_${index}__` })) };
  const afterFailure = (lines, notes) => {
    let blocks = BlockMap();
    const entities = new Map();
    lines.forEach((line, index) => {
      const key = `f${index}`;
      if (line.startsWith('[') && line.endsWith(']') && /\d/.test(line)) {
        entities.set(`g${index}`, entity(line.slice(1, -1)));
        blocks = blocks.set(key, new Block(key, ' ', `g${index}`));
      } else {
        blocks = blocks.set(key, new Block(key, line));
      }
    });
    const node = { props: { editorState: new EditorState(new ContentState(blocks, entities)) } };
    const list = [0, 2].map(index => ({ marker: `${prefix}IMAGE_${index}__`, mediaId: String(111 * (index + 1)), index: index + 1, label: `${index}.png` }));
    return plain(sandbox.window.testLayoutReport(node, failedPayload, list, [], false, notes));
  };
  const notes = new Map([[`${prefix}IMAGE_1__`, '[image upload failed]']]);
  assert.equal(afterFailure(['Intro', '[111]', '[image upload failed]', '[333]', 'Last'], notes).ok, true);
  assert.equal(afterFailure(['Intro', '[image upload failed]', '[111]', '[333]', 'Last'], notes).ok, false, 'the first image moved past the note');
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
  for (const [name, options] of [
    ['keep images in place when X restores its saved copy after the cover call', { rebuild: 'saved-copy' }],
    ['find images by media ID after X renumbers entity keys', { rebuild: 'renumber' }],
    ['do not mistake an earlier image for a new upload after entity keys change', { rebuild: 'renumber-before-insert' }],
    ['rebuild an image the saved copy does not have', { rebuild: 'drop-media' }],
    ['clean up again when the saved copy brings the placeholders back', { rebuild: 'late-placeholders' }]
  ]) { await runLateRebuildScenario(options); console.log(`PASS ${name}`); }
  runLayoutChecks();
  console.log('PASS the final check names an image that is not beside its text');
  // A single image that is the cover leaves no placeholder to wait for, so the
  // wait after putting the article back has to look at the article itself.
  for (const swapAfter of [900, 1300, 1700, 2100, 2500, 2900]) {
    const result = await runNativeScenario({ images: 1, commitDelay: 200, autosave: 'never', swapAfter });
    checkNative(result, 1, { slowCommits: true, noRecreate: false });
  }
  console.log('PASS wait for the article itself after putting it back, even with no placeholder left');
  {
    const result = await runNativeScenario({ images: 1, coverOnly: true });
    assert.deepEqual(result.order, [''], 'an article with only a cover keeps one empty paragraph');
    assert.equal(result.summary.markersLeft, 0);
    assert.equal(result.summary.cover.bodyBlockDeleted.ok, true);
    assert.equal(result.summary.imgFail, 0);
    console.log('PASS a title and a cover image alone leave an empty article, not a crash');
  }
  for (const [name, options, extra] of [
    ['images land at the caret when it is committed before X is asked', {}, { native: true }],
    ['take X\'s upload handler from the current fiber, not the one the DOM node points at', { commitsBefore: 1 }, { native: true }],
    ['remove the empty line X leaves above an image', { splitEmpty: true }, { native: true }],
    ['move images X put at the end of the article', { endAtCaret: true }, {}],
    ['wait for X to save before an upload that reloads the editor from its saved copy', { serverRebuild: true }, { saved: true }],
    ['prompt X to save when it ignores programmatic edits', { serverRebuild: true, autosave: 'nudged' }, { saved: true }],
    ['carry on when X never saves', { autosave: 'never' }, { native: true }],
    ['put the article back when X reloads a stale copy and never saves', { serverRebuild: true, autosave: 'never' }, { restored: true }],
    ['no cover: every image stays in the body', { firstIsCover: false }, { cover: false, native: true }],
    ['an image that never uploads leaves a note, not a loading placeholder, and the others stay in place', { failImage: 2 }, { failed: true }],
    ['put the article back when the title reply reloads the editor after the text was written', { titleReload: 3000 }, { restored: true }],
    ['keep the note of a failed image when X brings back a copy with the placeholder', { failImage: 2, serverRebuild: true, autosave: 'nudged' }, { failed: true }],
    ['do not take another image for the cover when X numbers its entities again', { rekey: true }, { native: true, noRecreate: true }],
    ['find a finished upload whose entity got the key an earlier image had', { rekey: 'reverse' }, { native: true, noRecreate: true }],
    ['remove a loading placeholder that comes back from an older copy', { zombie: true }, { native: true }],
    ['put the last paragraph back exactly when the edit that prompts a save damages it', { nudgeDamage: true, autosave: 'nudged' }, { nudgeOnce: true }],
    ['refuse a second import while one is running', { startTwice: true }, { refused: true }],
    ['wait for the media ID to be in X\'s copy before going on, so a reload cannot bring back an unfinished image', { serverRebuild: true, saveDelay: 6000, saveOnInsert: true }, { noZombies: true, serverHasIds: true }],
    ['leave alone the late end of an upload that was given up on while the next one loads', { failImage: 2, lateStray: true }, { failed: true, finalIds: [mediaIdFor(3)], removedExtras: true }],
    ['wait for a slow upload instead of starting it again', { slowImage: 2 }, { native: true }],
    ['ask again when X did not react to the upload call', { ignoreCall: 2 }, { calls: 4, native: true }],
    ['take out a second block with the same image', { dupCopy: true }, { removedExtras: true }],
    ['take out an image X adds when an abandoned upload ends', { foreignCopy: true }, { removedExtras: true }],
    ['never edit before the last edit has committed (slow commits)', { commitDelay: 200 }, { slowCommits: true, native: true }],
    ['never edit before the last edit has committed when X reloads a stale copy', { commitDelay: 200, serverRebuild: true, autosave: 'never' }, { slowCommits: true, restored: true }],
    ['never edit before the last edit has committed when the title reply reloads the editor', { commitDelay: 200, titleReload: 3000 }, { slowCommits: true, restored: true }],
    ['never edit before the last edit has committed when an image fails', { commitDelay: 200, failImage: 2 }, { slowCommits: true, failed: true }]
  ]) {
    const images = 3;
    const result = await runNativeScenario(options);
    checkNative(result, images, extra);
    console.log(`PASS ${name}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
