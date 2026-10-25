(() => {
  const LOG = "[xPoster MAIN]";
  const CHANNEL_TO_MAIN = "xposter";
  const CHANNEL_FROM_MAIN = "xposter-main";
  const EDITOR_SELECTOR =
    "[data-contents='true'] [contenteditable='true'], [contenteditable='true'][role='textbox'], [contenteditable='true'].public-DraftEditor-content, [contenteditable='true']";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function post(kind, payload = {}) {
    window.postMessage({ source: CHANNEL_FROM_MAIN, kind, ...payload }, "*");
  }

  function progress(text, level = "work") {
    post("progress", { text, level });
  }

  // What happened and when, returned with the summary so a run that goes wrong
  // can be diagnosed from the report alone: our own steps, every change to the
  // editor, and X's article and upload requests.
  const flight = { startedAt: 0, events: [], skipped: 0, running: false, shape: "", node: null };
  const FLIGHT_HEAD = 110;
  const FLIGHT_LIMIT = 260;

  function note(text) {
    if (!flight.startedAt) return;
    flight.events.push(`+${((Date.now() - flight.startedAt) / 1000).toFixed(1)}s ${text}`);
    if (flight.events.length > FLIGHT_LIMIT) {
      flight.events.splice(FLIGHT_HEAD, 1);
      flight.skipped += 1;
    }
  }

  function flightLog() {
    if (!flight.skipped) return flight.events.slice();
    return [
      ...flight.events.slice(0, FLIGHT_HEAD),
      `... ${flight.skipped} entries left out here ...`,
      ...flight.events.slice(FLIGHT_HEAD)
    ];
  }

  function mediaIdOfData(data) {
    const item = (data?.mediaItems || data?.media_items || [])[0];
    const id = item?.mediaId || item?.media_id;
    return id ? String(id) : "";
  }

  // The first entity of a block: its type, data and key.
  function blockEntity(contentState, block) {
    let found = null;
    block.findEntityRanges(
      (character) => Boolean(character.getEntity()),
      (start) => {
        if (found) return;
        const entityKey = block.getCharacterList().get(start)?.getEntity?.();
        if (!entityKey) return;
        try {
          const entity = contentState.getEntity(entityKey);
          found = { key: entityKey, type: String(entity.getType() || "").toUpperCase(), data: entity.getData() };
        } catch {}
      }
    );
    return found;
  }

  function editorShape(node, markerPrefix) {
    const content = node.props.editorState.getCurrentContent();
    let blocks = 0;
    let markers = 0;
    const images = [];
    content.getBlockMap().forEach((block) => {
      blocks += 1;
      if (block.getType() === "atomic") {
        const entity = blockEntity(content, block);
        if (entity?.type === "MEDIA") {
          const id = mediaIdOfData(entity.data);
          images.push(id ? id.slice(-4) : "?");
        }
      } else if (markerPrefix && (block.getText() || "").trim().startsWith(markerPrefix)) {
        markers += 1;
      }
    });
    return `${blocks} blocks, ${markers} markers, images [${images.join(" ")}]`;
  }

  function startFlight(markerPrefix) {
    flight.startedAt = Date.now();
    flight.events = [];
    flight.skipped = 0;
    flight.shape = "";
    flight.node = null;
    flight.running = true;
    const tick = () => {
      if (!flight.running) return;
      try {
        const node = findDraftStateNode();
        if (!node) {
          if (flight.shape !== "gone") {
            flight.shape = "gone";
            note("editor: not found");
          }
        } else {
          const shape = editorShape(node, markerPrefix);
          const rebuilt = Boolean(flight.node) && flight.node !== node;
          if (shape !== flight.shape || rebuilt) {
            note(`editor${rebuilt ? " (new instance)" : ""}: ${shape}`);
            flight.shape = shape;
          }
          flight.node = node;
        }
      } catch {}
      setTimeout(tick, 120);
    };
    tick();
  }

  function stopFlight() {
    flight.running = false;
  }

  // X's article and upload requests. Only watched, never changed: used to tell
  // when X has finished talking to its server and to log what it sent.
  const net = { installed: false, pending: 0, seen: 0, lastActivity: 0 };
  const NET_WATCH = /\/i\/api\/graphql\/[\w-]+\/\w*Article\w*|upload\.(?:x|twitter)\.com|\/i\/media\/upload|\/1\.1\/media\//i;

  function netLabel(url) {
    const text = String(url || "");
    return text.match(/\/i\/api\/graphql\/[\w-]+\/(\w+)/)?.[1] || "media upload";
  }

  function sentBlocks(body) {
    if (typeof body !== "string" || body.length > 4000000) return null;
    try {
      const find = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 6) return null;
        if (Array.isArray(node.blocks)) return node.blocks.length;
        for (const value of Object.values(node)) {
          const found = find(value, depth + 1);
          if (found !== null) return found;
        }
        return null;
      };
      return find(JSON.parse(body), 0);
    } catch {
      return null;
    }
  }

  function startRequest(input, init) {
    const url = typeof input === "string" ? input : input?.url || String(input || "");
    if (!NET_WATCH.test(url)) return null;
    net.pending += 1;
    net.seen += 1;
    return {
      label: netLabel(url),
      method: String(init?.method || input?.method || "GET").toUpperCase(),
      startedAt: Date.now(),
      blocks: sentBlocks(init?.body)
    };
  }

  function finishRequest(entry, status) {
    net.pending = Math.max(0, net.pending - 1);
    net.lastActivity = Date.now();
    const sent = entry.blocks === null ? "" : `, sent ${entry.blocks} blocks`;
    note(`x request ${entry.method} ${entry.label} -> ${status || "failed"} in ${Date.now() - entry.startedAt}ms${sent}`);
  }

  function installNetworkWatch() {
    if (net.installed) return;
    net.installed = true;
    try {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch === "function") {
        window.fetch = function (input, init) {
          let entry = null;
          try {
            entry = startRequest(input, init);
          } catch {}
          const promise = nativeFetch.apply(this, arguments);
          if (entry) promise.then((response) => finishRequest(entry, response.status), () => finishRequest(entry, 0));
          return promise;
        };
      }
      const Xhr = window.XMLHttpRequest;
      if (Xhr?.prototype?.open && Xhr.prototype.send) {
        const nativeOpen = Xhr.prototype.open;
        const nativeSend = Xhr.prototype.send;
        Xhr.prototype.open = function (method, url) {
          this.__xposterRequest = { method, url };
          return nativeOpen.apply(this, arguments);
        };
        Xhr.prototype.send = function (body) {
          try {
            const info = this.__xposterRequest;
            const entry = info ? startRequest(info.url, { method: info.method, body }) : null;
            if (entry) this.addEventListener("loadend", () => finishRequest(entry, this.status));
          } catch {}
          return nativeSend.apply(this, arguments);
        };
      }
    } catch (error) {
      console.warn(LOG, "request watch could not be installed", error);
    }
  }

  function networkQuiet(quietMs) {
    return net.seen === 0 || (net.pending === 0 && Date.now() - net.lastActivity >= quietMs);
  }

  function requestPreparedFile(operation, timeoutMs = 30000) {
    const token = operation?.op?.file?.token || operation?.marker || "";
    if (operation?.op?.file?.base64) return Promise.resolve(operation.op.file);
    if (!token) return Promise.reject(new Error("Prepared image token is missing"));
    const requestId = `file_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", listener);
        reject(new Error("Prepared image data did not arrive"));
      }, timeoutMs);
      const listener = (event) => {
        if (event.source !== window || event.data?.source !== CHANNEL_TO_MAIN) return;
        const message = event.data;
        if (message.kind !== "file-response" || message.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", listener);
        if (message.ok && message.file?.base64) resolve(message.file);
        else reject(new Error(message.error || "Prepared image data was not available"));
      };
      window.addEventListener("message", listener);
      post("file-request", { requestId, token, marker: operation.marker });
    });
  }

  function findEditorElement() {
    for (const element of document.querySelectorAll(EDITOR_SELECTOR)) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 80) return element;
    }
    return null;
  }

  function findDraftStateNode() {
    const editor = findEditorElement();
    if (!editor) return null;
    const fiberKey = Object.keys(editor).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;
    let fiber = editor[fiberKey];
    for (let depth = 0; depth < 80 && fiber; depth += 1) {
      const stateNode = fiber.stateNode;
      if (stateNode?.props?.editorState && typeof stateNode.props.onChange === "function") {
        return stateNode;
      }
      fiber = fiber.return;
    }
    return null;
  }

  const HOST_ROOT_TAG = 3;

  // React keeps two fibers per component and swaps which one is current on every
  // commit, while a DOM node keeps pointing at the first fiber React made for
  // it. Props read through that fiber can be a commit behind, so ask which of
  // the pair is the current one the way React does.
  function currentFiber(fiber) {
    const alternate = fiber.alternate;
    if (!alternate) return fiber;
    let a = fiber;
    let b = alternate;
    for (let guard = 0; guard < 500; guard += 1) {
      const parentA = a.return;
      if (!parentA) break;
      const parentB = parentA.alternate;
      if (!parentB) {
        const next = parentA.return;
        if (!next) break;
        a = next;
        b = next;
        continue;
      }
      if (parentA.child === parentB.child) {
        for (let child = parentA.child; child; child = child.sibling) {
          if (child === a) return fiber;
          if (child === b) return alternate;
        }
        return fiber;
      }
      if (a.return !== b.return) {
        a = parentA;
        b = parentB;
      } else {
        let found = false;
        for (let child = parentA.child; child && !found; child = child.sibling) {
          if (child === a) {
            a = parentA;
            b = parentB;
            found = true;
          } else if (child === b) {
            b = parentA;
            a = parentB;
            found = true;
          }
        }
        for (let child = parentB.child; child && !found; child = child.sibling) {
          if (child === a) {
            a = parentB;
            b = parentA;
            found = true;
          } else if (child === b) {
            b = parentB;
            a = parentA;
            found = true;
          }
        }
        if (!found) return fiber;
      }
      if (a.alternate !== b) return fiber;
    }
    if (a.tag !== HOST_ROOT_TAG || !a.stateNode) return fiber;
    return a.stateNode.current === a ? fiber : alternate;
  }

  function liveFiber(fiber) {
    try {
      return currentFiber(fiber) || fiber;
    } catch {
      return fiber;
    }
  }

  function editorFiber() {
    const editor = findEditorElement();
    if (!editor) return null;
    const fiberKey = Object.keys(editor).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );
    return fiberKey ? editor[fiberKey] : null;
  }

  // The nearest function prop with this name above the editor. live reads it
  // from the current fibers instead of whichever one the DOM node points at.
  function findPropFunction(name, live) {
    let fiber = editorFiber();
    for (let depth = 0; depth < 80 && fiber; depth += 1) {
      if (live) fiber = liveFiber(fiber);
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (typeof props?.[name] === "function") return props[name];
      fiber = fiber.return;
    }
    return null;
  }

  function findOnFilesAdded() {
    return findPropFunction("onFilesAdded", true) || findPropFunction("onFilesAdded", false);
  }

  function pasteHtml(html, plain) {
    const editor = findEditorElement();
    if (!editor) return false;
    editor.focus();
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", plain || html.replace(/<[^>]*>/g, ""));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    });
    if (event.clipboardData !== data) {
      Object.defineProperty(event, "clipboardData", { value: data });
    }
    return editor.dispatchEvent(event);
  }

  function isDraftCharacterMetadata(character, requireStyle = true) {
    return Boolean(character?.set && (!requireStyle || character.getStyle));
  }

  function firstCharacterMetadata(block, requireStyle = true) {
    const characterList = block?.getCharacterList?.();
    if (!characterList) return null;
    if (typeof characterList.find === "function") {
      const found = characterList.find((character) => isDraftCharacterMetadata(character, requireStyle));
      if (found) return found;
    }
    const size =
      typeof characterList.size === "number"
        ? characterList.size
        : typeof characterList.count === "function"
          ? characterList.count()
          : 0;
    for (let index = 0; index < size; index += 1) {
      const character = characterList.get?.(index);
      if (isDraftCharacterMetadata(character, requireStyle)) return character;
    }
    const first = characterList.first?.() || characterList.get?.(0);
    return isDraftCharacterMetadata(first, requireStyle) ? first : null;
  }

  function findDraftCharacterSample(draftNode) {
    const blockMap = draftNode?.props?.editorState?.getCurrentContent?.()?.getBlockMap?.();
    if (!blockMap?.find) return null;
    const block = blockMap.find((candidate) => Boolean(firstCharacterMetadata(candidate))) || null;
    return block ? { block, character: firstCharacterMetadata(block) } : null;
  }

  function findDraftSampleBlock(draftNode) {
    return findDraftCharacterSample(draftNode)?.block || null;
  }

  async function ensureDraftCharacterSample(draftNode) {
    if (findDraftSampleBlock(draftNode)) return draftNode;
    const editor = findEditorElement();
    if (!editor) return draftNode;

    editor.focus();
    document.execCommand("insertText", false, "x");

    const deadline = Date.now() + 1600;
    while (Date.now() < deadline) {
      await sleep(80);
      const latestNode = findDraftStateNode() || draftNode;
      if (findDraftSampleBlock(latestNode)) return latestNode;
    }
    return findDraftStateNode() || draftNode;
  }

  function writeDraftBlocks(draftNode, blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return { ok: false, error: "No structured blocks" };

    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    const sample = findDraftCharacterSample(draftNode);
    const sampleBlock = sample?.block || null;
    const sampleCharacter = sample?.character || null;
    if (!sampleBlock || !sampleCharacter) return { ok: false, error: "No Draft.js character sample for structured write" };

    const BlockMap = blockMap.constructor;
    const CharacterList = sampleBlock.getCharacterList().constructor;
    if (!sampleCharacter?.set || !sampleCharacter.getStyle) return { ok: false, error: "No Draft.js character metadata sample for structured write" };

    let nextContent = contentState;
    let nextBlockMap = BlockMap();
    const createdKeys = [];

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index] || {};
      const text = String(block.text || "");
      const key = `${Math.random().toString(36).slice(2, 7)}${index.toString(36)}`;
      let characterList = CharacterList();
      const entityRanges = new Map();

      for (const link of block.links || []) {
        const offset = Number(link.offset) || 0;
        const length = Math.max(0, Number(link.length) || 0);
        if (!length || !link.url) continue;
        nextContent = nextContent.createEntity("LINK", "MUTABLE", { url: String(link.url) });
        entityRanges.set(`${offset}:${offset + length}`, nextContent.getLastCreatedEntityKey());
      }

      for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
        const styleNames = (block.inlineStyleRanges || [])
          .filter((range) => charIndex >= range.offset && charIndex < range.offset + range.length)
          .map((range) => draftInlineStyleName(range.style))
          .filter(Boolean);
        let entity = null;
        for (const [range, entityKey] of entityRanges.entries()) {
          const [start, end] = range.split(":").map(Number);
          if (charIndex >= start && charIndex < end) {
            entity = entityKey;
            break;
          }
        }
        let style = sampleCharacter.getStyle().clear();
        for (const styleName of styleNames) style = style.add(styleName);
        characterList = characterList.push(sampleCharacter.set("style", style).set("entity", entity));
      }

      const nextBlock = sampleBlock.merge({
        key,
        type: block.type || "unstyled",
        text,
        characterList,
        depth: block.type === "unordered-list-item" || block.type === "ordered-list-item" ? 0 : 0,
        data: sampleBlock.getData?.()?.clear?.() || sampleBlock.getData?.()
      });
      nextBlockMap = nextBlockMap.set(key, nextBlock);
      createdKeys.push(key);
    }

    if (!createdKeys.length) return { ok: false, error: "No Draft.js blocks created" };
    const lastKey = createdKeys[createdKeys.length - 1];
    const selection = SelectionState.createEmpty(lastKey);
    const nextState = nextContent
      .set("blockMap", nextBlockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextState, "insert-fragment");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return { ok: true, blocks: createdKeys.length, keys: createdKeys };
  }

  function draftInlineStyleName(style) {
    return (
      {
        Bold: "BOLD",
        Italic: "ITALIC",
        Strikethrough: "STRIKETHROUGH",
        Code: "CODE"
      }[style] || style
    );
  }

  function findMarkerBlock(contentState, marker) {
    let blockKey = null;
    contentState.getBlockMap().forEach((block, key) => {
      if (block.getType() !== "atomic" && (block.getText() || "").trim() === marker) {
        blockKey = key;
        return false;
      }
      return true;
    });
    return blockKey;
  }

  function countBlocksStartingWith(draftNode, prefix) {
    if (!draftNode || !prefix) return 0;
    let count = 0;
    draftNode.props.editorState
      .getCurrentContent()
      .getBlockMap()
      .forEach((block) => {
        if ((block.getText() || "").trim().startsWith(prefix)) count += 1;
      });
    return count;
  }

  async function waitForDraftMarkers(markerPrefix, expectedCount, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latestNode = findDraftStateNode();
      if (latestNode && countBlocksStartingWith(latestNode, markerPrefix) >= expectedCount) {
        return latestNode;
      }
      await sleep(100);
    }
    return findDraftStateNode();
  }

  // An atomic block (with a new entity) shaped like the marker's block.
  function createAtomicBlock(contentState, markerBlock, sampleBlock, entityType, data, mutability, blockKey) {
    const characterList = markerBlock.getCharacterList();
    const markerCharacter = firstCharacterMetadata(markerBlock, false);
    const fallbackCharacter = firstCharacterMetadata(sampleBlock, false);
    const sampleCharacter = markerCharacter?.set ? markerCharacter : fallbackCharacter;
    if (!sampleCharacter?.set) return { ok: false, error: "No Draft.js character sample" };
    const CharacterList = characterList.constructor;

    const withEntity = contentState.createEntity(entityType, mutability || "IMMUTABLE", data || {});
    const entityKey = withEntity.getLastCreatedEntityKey();
    const character = sampleCharacter.set("entity", entityKey);
    const atomicBlock = markerBlock.merge({
      key: blockKey,
      type: "atomic",
      text: " ",
      characterList: CharacterList([character]),
      depth: 0
    });
    return { ok: true, withEntity, entityKey, atomicBlock };
  }

  function replaceMarkerWithAtomic(contentState, marker, entityType, data, mutability, sampleBlock) {
    const blockKey = findMarkerBlock(contentState, marker);
    if (!blockKey) return { ok: false, error: `Marker not found: ${marker}`, contentState };

    const markerBlock = contentState.getBlockMap().get(blockKey);
    const created = createAtomicBlock(contentState, markerBlock, sampleBlock, entityType, data, mutability, blockKey);
    if (!created.ok) return { ok: false, error: `${created.error} for marker: ${marker}`, contentState };
    const blockMap = created.withEntity.getBlockMap().set(blockKey, created.atomicBlock);
    return { ok: true, entityKey: created.entityKey, contentState: created.withEntity.set("blockMap", blockMap) };
  }

  // Put a media block right before the marker's block; the marker stays as the
  // anchor until the article is final.
  function insertMediaBeforeMarker(contentState, marker, data, mutability, sampleBlock) {
    const markerKey = findMarkerBlock(contentState, marker);
    if (!markerKey) return { ok: false, error: `Marker not found: ${marker}` };
    const blockMap = contentState.getBlockMap();
    let blockKey;
    do {
      blockKey = Math.random().toString(36).slice(2, 7);
    } while (blockMap.has(blockKey));
    const created = createAtomicBlock(contentState, blockMap.get(markerKey), sampleBlock, "MEDIA", data, mutability, blockKey);
    if (!created.ok) return { ok: false, error: `${created.error} for marker: ${marker}` };
    let nextBlockMap = blockMap.constructor();
    blockMap.forEach((block, key) => {
      if (key === markerKey) nextBlockMap = nextBlockMap.set(blockKey, created.atomicBlock);
      nextBlockMap = nextBlockMap.set(key, block);
    });
    return {
      ok: true,
      entityKey: created.entityKey,
      blockKey,
      contentState: created.withEntity.set("blockMap", nextBlockMap)
    };
  }

  function insertAtomicBatch(draftNode, operations) {
    if (!operations.length) return { okCount: 0, failCount: 0, errors: [] };
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    let contentState = editorState.getCurrentContent();
    const sampleBlock = findDraftSampleBlock(draftNode);
    let okCount = 0;
    const errors = [];

    for (const item of operations) {
      const result = replaceMarkerWithAtomic(
        contentState,
        item.marker,
        item.op.entityType,
        item.op.data || {},
        item.op.mutability || "IMMUTABLE",
        sampleBlock
      );
      if (result.ok) {
        contentState = result.contentState;
        okCount += 1;
      } else {
        errors.push(result.error);
      }
    }

    if (okCount > 0) {
      const lastKey = contentState.getBlockMap().last().getKey();
      const selection = SelectionState.createEmpty(lastKey);
      const nextContent = contentState.set("selectionBefore", selection).set("selectionAfter", selection);
      let nextEditorState = EditorState.push(editorState, nextContent, "insert-fragment");
      nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
      draftNode.props.onChange(nextEditorState);
    }

    return { okCount, failCount: errors.length, errors };
  }

  function base64ToFile(base64, fileName, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], fileName, { type: mime });
  }

  // Media IDs already in the article. Entity keys change when X rebuilds its
  // editor, so an image that was there before an upload can look new by key.
  function existingMediaIds(contentState) {
    const ids = new Set();
    contentState.getBlockMap().forEach((block) => {
      if (block.getType() !== "atomic") return;
      block.findEntityRanges(
        (character) => Boolean(character.getEntity()),
        (start) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey) return;
          try {
            const entity = contentState.getEntity(entityKey);
            if (entity.getType() !== "MEDIA") return;
            const data = entity.getData();
            for (const item of data?.mediaItems || data?.media_items || []) {
              const id = item?.mediaId || item?.media_id;
              if (id) ids.add(String(id));
            }
          } catch {}
        }
      );
    });
    return ids;
  }

  // Entity keys of images X has put in the article but not finished uploading.
  function pendingMediaEntities(contentState) {
    const entities = new Set();
    contentState.getBlockMap().forEach((block) => {
      if (block.getType() !== "atomic") return;
      const entity = blockEntity(contentState, block);
      if (entity?.type === "MEDIA" && !mediaIdOfData(entity.data)) entities.add(entity.key);
    });
    return entities;
  }

  function placeSelectionAtMarker(draftNode, marker) {
    const editorState = draftNode.props.editorState;
    const SelectionState = editorState.getSelection().constructor;
    const EditorState = editorState.constructor;
    const contentState = editorState.getCurrentContent();
    const blockKey = findMarkerBlock(contentState, marker);
    if (!blockKey) return false;
    const selection = SelectionState.createEmpty(blockKey).merge({ anchorOffset: 0, focusOffset: 0 });
    draftNode.props.onChange(EditorState.forceSelection(editorState, selection));
    return true;
  }

  // The committed editor state has its caret at the start of the marker's line.
  function caretIsAtMarker(draftNode, marker) {
    if (!draftNode) return false;
    const editorState = draftNode.props.editorState;
    const blockKey = findMarkerBlock(editorState.getCurrentContent(), marker);
    if (!blockKey) return false;
    const selection = editorState.getSelection();
    if (typeof selection?.getAnchorKey !== "function") return true;
    return (
      selection.getAnchorKey() === blockKey &&
      selection.getFocusKey() === blockKey &&
      selection.getAnchorOffset() === 0 &&
      selection.getFocusOffset() === 0
    );
  }

  async function waitUntil(check, timeoutMs, stepMs = 80) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await sleep(stepMs);
    }
    return check();
  }

  function markersPresent(draftNode, markers) {
    if (!draftNode) return false;
    const contentState = draftNode.props.editorState.getCurrentContent();
    return markers.every((marker) => Boolean(findMarkerBlock(contentState, marker)));
  }

  function textBlocks(contentState) {
    const texts = [];
    contentState.getBlockMap().forEach((block) => {
      const text = (block.getText() || "").trim();
      if (block.getType() !== "atomic" && text) texts.push(text);
    });
    return texts;
  }

  function countSurvivors(before, after) {
    const pool = new Map();
    for (const text of after) pool.set(text, (pool.get(text) || 0) + 1);
    let kept = 0;
    for (const text of before) {
      const left = pool.get(text) || 0;
      if (!left) continue;
      pool.set(text, left - 1);
      kept += 1;
    }
    return kept;
  }

  // An upload only adds blocks beside the caret. X has been seen to swap in an
  // earlier editor state as an upload finishes (the draft was left as "x" plus
  // the new media block), which drops the imported article. Most earlier text
  // or a later placeholder missing afterwards means that happened.
  function inspectBody(beforeTexts, contentState, ignoreMarker, laterMarkers) {
    const expected = beforeTexts.filter((text) => text !== ignoreMarker);
    const kept = countSurvivors(expected, textBlocks(contentState));
    const markerLost = laterMarkers.some((marker) => !findMarkerBlock(contentState, marker));
    return {
      replaced: markerLost || (expected.length > 0 && kept * 2 < expected.length),
      kept,
      total: expected.length
    };
  }

  function putBackContent(contentState, selectionKey) {
    const node = findDraftStateNode();
    if (!node) return false;
    const editorState = node.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const selection = SelectionState.createEmpty(selectionKey || contentState.getBlockMap().last().getKey());
    const nextContent = contentState.set("selectionBefore", selection).set("selectionAfter", selection);
    node.props.onChange(EditorState.moveSelectionToEnd(EditorState.push(editorState, nextContent, "insert-fragment")));
    return true;
  }

  // The entity data X saved for an uploaded image, copied so it can rebuild the
  // block if X later drops it.
  function readMediaEntity(contentState, entityKey) {
    try {
      const entity = contentState.getEntity(entityKey);
      let data = entity.getData() || {};
      try { data = JSON.parse(JSON.stringify(data)); } catch {}
      return { data, mutability: entity.getMutability?.() || "IMMUTABLE" };
    } catch {
      return null;
    }
  }

  // X goes on working for a moment after an edit or an upload: it can rebuild
  // its editor and talk to its server. Wait until the editor instance and its
  // content stop changing and X's own requests are done.
  async function waitForStable(timeoutMs = 5000, quietMs = 700) {
    const startedAt = Date.now();
    let last = null;
    let since = startedAt;
    while (Date.now() - startedAt < timeoutMs) {
      const node = findDraftStateNode();
      const content = node ? node.props.editorState.getCurrentContent() : null;
      if (!last || last.node !== node || last.content !== content) {
        last = { node, content };
        since = Date.now();
      } else if (Date.now() - since >= quietMs && networkQuiet(quietMs)) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  // The upload itself worked (X has a media ID) but the article around it was
  // replaced. Restore the article as it was before the upload and put the
  // uploaded media before its placeholder, so nothing is uploaded twice.
  async function restoreArticleWithMedia(beforeContent, marker, uploadedContent, uploaded) {
    const media = readMediaEntity(uploadedContent, uploaded.entityKey);
    if (!media) return { ok: false, error: "Uploaded media could not be read back" };
    const node = findDraftStateNode();
    if (!node) return { ok: false, error: "X editor disappeared while restoring the article" };
    const placed = insertMediaBeforeMarker(beforeContent, marker, media.data, media.mutability, findDraftSampleBlock(node));
    if (!placed.ok) return { ok: false, error: placed.error };
    putBackContent(placed.contentState, placed.blockKey);
    const settled = await waitUntil(
      () => Boolean(findDraftStateNode()?.props.editorState.getCurrentContent().getBlockMap().has(placed.blockKey)),
      2500
    );
    if (!settled) return { ok: false, error: "The article could not be restored after X replaced it" };
    return { ok: true, entityKey: placed.entityKey, blockKey: placed.blockKey, mediaId: uploaded.mediaId, ...media };
  }

  async function uploadImageAtMarker(draftNode, imageOperation, existingAtomicBlocks, laterMarkers = [], seenMediaIds = new Set()) {
    const preparedFile = await requestPreparedFile(imageOperation);
    const file = base64ToFile(preparedFile.base64, preparedFile.fileName, preparedFile.mime);

    draftNode = findDraftStateNode() || draftNode;
    const beforeContent = draftNode.props.editorState.getCurrentContent();
    const beforeTexts = textBlocks(beforeContent);
    findEditorElement()?.focus?.({ preventScroll: true });
    if (!placeSelectionAtMarker(draftNode, imageOperation.marker)) {
      return { ok: false, error: "Image placeholder was not found in the X editor" };
    }
    // X puts an image where the caret was when it last rendered. Let React
    // commit the caret move first, then take X's upload handler as it is now:
    // one taken earlier works from the editor as it was before the move.
    const landed = await waitUntil(() => caretIsAtMarker(findDraftStateNode(), imageOperation.marker), 3000);
    await sleep(200);
    draftNode = findDraftStateNode() || draftNode;
    const onFilesAdded = findOnFilesAdded();
    if (!onFilesAdded) return { ok: false, error: "X upload handler was not reachable" };
    note(
      `upload: caret ${landed ? "is" : "is NOT"} at the placeholder; upload handler ` +
        `${findPropFunction("onFilesAdded", false) === onFilesAdded ? "matches" : "differs from"} the one the DOM node reaches`
    );

    const beforePending = pendingMediaEntities(draftNode.props.editorState.getCurrentContent());
    const beforeIds = existingMediaIds(draftNode.props.editorState.getCurrentContent());

    onFilesAdded([file]);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await sleep(350);
      draftNode = findDraftStateNode() || draftNode;
      const contentState = draftNode.props.editorState.getCurrentContent();
      let found = null;
      contentState.getBlockMap().forEach((block, blockKey) => {
        if (found || block.getType() !== "atomic") return;
        block.findEntityRanges(
          (character) => Boolean(character.getEntity()),
          (start) => {
            const entityKey = block.getCharacterList().get(start)?.getEntity?.();
            if (!entityKey) return;
            try {
              const entity = contentState.getEntity(entityKey);
              if (entity.getType() !== "MEDIA") return;
              // A MEDIA block appears before its server-side media ID is ready.
              // Wait for the ID so the same upload can also become the cover.
              const mediaId = mediaIdOfData(entity.getData());
              if (!mediaId) return;
              // Media IDs tell the images apart. Entity keys do not: X can number
              // them again, so a new image may get a key an old one had.
              if (beforeIds.has(mediaId) || seenMediaIds.has(mediaId)) return;
              if (beforePending.has(entityKey)) return;
              found = { entityKey, blockKey, mediaId };
            } catch {}
          }
        );
      });
      if (found) {
        const body = inspectBody(beforeTexts, contentState, imageOperation.marker, laterMarkers);
        if (body.replaced) {
          console.warn(LOG, "X replaced the article during an upload; restoring it", body);
          progress("X replaced the article during the upload. Putting it back...", "warn");
          const restored = await restoreArticleWithMedia(beforeContent, imageOperation.marker, contentState, found);
          if (!restored.ok) return restored;
          existingAtomicBlocks.add(restored.blockKey);
          return { ...restored, restored: { kept: body.kept, total: body.total } };
        }
        existingAtomicBlocks.add(found.blockKey);
        return { ok: true, ...found, ...readMediaEntity(contentState, found.entityKey) };
      }
    }

    const dropped = await removePendingMedia(beforePending);
    note(`upload timed out${dropped ? `; removed ${dropped} unfinished image placeholder(s)` : ""}`);
    return { ok: false, error: "Timed out waiting for X media upload" };
  }

  // An upload that never got its media ID leaves a loading placeholder behind.
  // Returns once the editor has dropped it, so the next edit starts from there.
  async function removePendingMedia(knownEntities) {
    const pendingKeys = (node) => {
      const content = node.props.editorState.getCurrentContent();
      const keys = [];
      content.getBlockMap().forEach((block, blockKey) => {
        if (block.getType() !== "atomic") return;
        const entity = blockEntity(content, block);
        if (entity?.type === "MEDIA" && !mediaIdOfData(entity.data) && !knownEntities.has(entity.key)) keys.push(blockKey);
      });
      return keys;
    };
    const node = findDraftStateNode();
    const keys = node ? pendingKeys(node) : [];
    if (!keys.length || !deleteBlocksByKey(node, keys).ok) return 0;
    await waitUntil(() => {
      const latest = findDraftStateNode();
      return !latest || pendingKeys(latest).length === 0;
    }, 2000);
    return keys.length;
  }

  function replaceMarkerText(draftNode, marker, text) {
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    const blockKey = findMarkerBlock(contentState, marker);
    if (!blockKey) return false;
    const block = blockMap.get(blockKey);
    const characterFactory = block.getCharacterList().get(0)?.constructor;
    const character = characterFactory ? characterFactory.create({}) : null;
    const characterList = block.getCharacterList().clear().concat(Array.from({ length: text.length }, () => character));
    const nextBlock = block.merge({ text, characterList });
    const selection = SelectionState.createEmpty(blockKey);
    const nextContent = contentState
      .set("blockMap", blockMap.set(blockKey, nextBlock))
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    draftNode.props.onChange(EditorState.push(editorState, nextContent, "change-block-data"));
    return true;
  }

  // Make sure every uploaded image is in the article, right before its
  // placeholder. Images are found by their X media ID because entity keys change
  // when X rebuilds its editor, and one that has gone missing is rebuilt from the
  // entity data saved at upload time. Placeholders stay as anchors until the
  // article is final, so this can run again to repair a later rebuild.
  function placeImages(draftNode, uploads, protectedAtomicBlocks) {
    const stats = { moved: 0, created: 0, missing: 0 };
    const wanted = uploads.filter((upload) => !upload.dropped);
    if (!wanted.length) return stats;
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    let contentState = editorState.getCurrentContent();
    const ourIds = new Set(uploads.map((upload) => String(upload.mediaId || "")));

    // Entity keys are only a hint: X can number its entities again, so a key an
    // image had can end up on another one. A block counts as an image's own by
    // its media ID, or by its key only while it has no media ID at all.
    const byMediaId = new Map();
    const byEntity = new Map();
    const spare = [];
    contentState.getBlockMap().forEach((block, blockKey) => {
      if (block.getType() !== "atomic") return;
      let isOurs = false;
      let isMedia = false;
      let spareEntry = null;
      block.findEntityRanges(
        (character) => Boolean(character.getEntity()),
        (start) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey) return;
          try {
            const entity = contentState.getEntity(entityKey);
            if (entity.getType() !== "MEDIA") return;
            isMedia = true;
            const data = entity.getData();
            let withId = false;
            for (const item of data?.mediaItems || data?.media_items || []) {
              const id = String(item?.mediaId || item?.media_id || "");
              if (!id) continue;
              withId = true;
              byMediaId.set(id, blockKey);
              if (ourIds.has(id)) isOurs = true;
              spareEntry ||= { blockKey, entityKey, mediaId: id };
            }
            if (!withId) byEntity.set(entityKey, blockKey);
          } catch {}
        }
      );
      if (isMedia && !isOurs && spareEntry && !protectedAtomicBlocks.has(blockKey)) spare.push(spareEntry);
    });

    const items = [];
    const claimed = new Set();
    for (const upload of wanted) {
      const markerKey = findMarkerBlock(contentState, upload.marker);
      if (!markerKey) {
        stats.missing += 1;
        continue;
      }
      const imageKey =
        (upload.mediaId && byMediaId.get(String(upload.mediaId))) ||
        (upload.entityKey && byEntity.get(upload.entityKey)) ||
        null;
      if (imageKey) claimed.add(imageKey);
      items.push({ upload, imageKey });
    }

    const sampleBlock = findDraftSampleBlock(draftNode);
    let spareIndex = 0;
    for (const item of items) {
      if (item.imageKey) continue;
      while (spareIndex < spare.length && claimed.has(spare[spareIndex].blockKey)) spareIndex += 1;
      if (spare[spareIndex]) {
        // An image with an ID we did not get from the upload: take it as this
        // one, with the ID it has now, so the article and our records agree.
        const adopted = spare[spareIndex];
        spareIndex += 1;
        item.imageKey = adopted.blockKey;
        note(`image ${item.upload.index}: took the image with media …${adopted.mediaId.slice(-4)} for it (its own …${String(item.upload.mediaId).slice(-4)} was not in the article)`);
        item.upload.mediaId = adopted.mediaId;
        item.upload.entityKey = adopted.entityKey;
        item.upload.blockKey = adopted.blockKey;
        const entity = readMediaEntity(contentState, adopted.entityKey);
        if (entity) {
          item.upload.data = entity.data;
          item.upload.mutability = entity.mutability;
        }
        continue;
      }
      const { upload } = item;
      const made = upload.data
        ? insertMediaBeforeMarker(contentState, upload.marker, upload.data, upload.mutability, sampleBlock)
        : { ok: false };
      if (!made.ok) {
        stats.missing += 1;
        continue;
      }
      contentState = made.contentState;
      item.imageKey = made.blockKey;
      upload.entityKey = made.entityKey;
      upload.blockKey = made.blockKey;
      stats.created += 1;
    }

    const blockMap = contentState.getBlockMap();
    const keys = [];
    blockMap.forEach((block, key) => {
      keys.push(key);
    });
    const moves = new Map();
    for (const { upload, imageKey } of items) {
      if (!imageKey) continue;
      const markerKey = findMarkerBlock(contentState, upload.marker);
      if (keys[keys.indexOf(markerKey) - 1] !== imageKey) moves.set(markerKey, imageKey);
    }
    if (moves.size) {
      const moving = new Set(moves.values());
      let nextBlockMap = blockMap.constructor();
      for (const key of keys) {
        if (moving.has(key)) continue;
        if (moves.has(key)) nextBlockMap = nextBlockMap.set(moves.get(key), blockMap.get(moves.get(key)));
        nextBlockMap = nextBlockMap.set(key, blockMap.get(key));
      }
      contentState = contentState.set("blockMap", nextBlockMap);
      stats.moved = moves.size;
    }

    if (!stats.moved && !stats.created) return stats;
    const selection = SelectionState.createEmpty(keys[keys.length - 1]);
    const nextContent = contentState.set("selectionBefore", selection).set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return stats;
  }

  const isEmptyParagraph = (block) => block.getType() === "unstyled" && !(block.getText() || "").trim();

  // Take the placeholder lines out, and the empty paragraphs with them. xPoster
  // never writes an empty paragraph; X leaves them when it splits a placeholder
  // line to insert an image, or adds one after each image it inserts.
  function cleanupMarkers(draftNode, markerPrefix) {
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    let blockMap = contentState.getBlockMap();
    const toDelete = [];
    blockMap.forEach((block, key) => {
      if (block.getType() !== "atomic" && (block.getText() || "").trim().startsWith(markerPrefix)) {
        toDelete.push(key);
      }
    });
    for (const key of toDelete) blockMap = blockMap.delete(key);

    const strays = [];
    let remaining = 0;
    blockMap.forEach((block, key) => {
      remaining += 1;
      if (isEmptyParagraph(block)) strays.push(key);
    });
    // The editor keeps at least one block.
    if (strays.length >= remaining) strays.pop();
    for (const key of strays) blockMap = blockMap.delete(key);
    if (!toDelete.length && !strays.length) return { markers: 0, tidied: 0 };
    blockMap = withAtLeastOneBlock(blockMap, findDraftSampleBlock(draftNode));

    const lastKey = blockMap.last()?.getKey?.();
    const selection = lastKey ? SelectionState.createEmpty(lastKey) : editorState.getSelection();
    const nextContent = contentState
      .set("blockMap", blockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return { markers: toDelete.length, tidied: strays.length };
  }

  function emptyParagraphs(draftNode) {
    let count = 0;
    let total = 0;
    draftNode.props.editorState
      .getCurrentContent()
      .getBlockMap()
      .forEach((block) => {
        total += 1;
        if (isEmptyParagraph(block)) count += 1;
      });
    // The editor keeps one block even when it is empty.
    return count >= total ? count - 1 : count;
  }

  function removeMarkerBlock(marker) {
    const node = findDraftStateNode();
    if (!node) return false;
    const key = findMarkerBlock(node.props.editorState.getCurrentContent(), marker);
    return key ? deleteBlockByKey(node, key).ok : false;
  }

  // Imported text blocks the editor should hold versus the ones it holds now.
  function importedBodyStats(draftNode, payload) {
    const prefix = payload.markerPrefix || "";
    const isContent = (text) => Boolean(text) && !(prefix && text.startsWith(prefix));
    const expected = (payload.blocks || []).filter((block) => isContent(String(block?.text || "").trim())).length;
    let actual = 0;
    draftNode.props.editorState
      .getCurrentContent()
      .getBlockMap()
      .forEach((block) => {
        if (block.getType() !== "atomic" && isContent((block.getText() || "").trim())) actual += 1;
      });
    return { expected, actual };
  }

  // Where the images and embedded blocks sit compared with the Markdown: next to
  // the same lines of text, and in the same order.
  function layoutReport(draftNode, payload, uploads, atomicOps, checkEmbedded, failedNotes = new Map()) {
    const norm = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const prefix = payload.markerPrefix || "";
    const markerSet = new Set((payload.plan || []).map((item) => item.marker));

    // The text on either side of item, skipping everything that is not text.
    const around = (list, index) => {
      let before;
      for (let i = index - 1; i >= 0 && before === undefined; i -= 1) before = list[i].text;
      let after;
      for (let i = index + 1; i < list.length && after === undefined; i += 1) after = list[i].text;
      return { before, after };
    };
    // Either neighbour matching is enough: it still tells the image is in its place.
    const sameSpot = (want, got) => !want || want.before === got.before || want.after === got.after;
    const describe = (spot) => `${spot.before === undefined ? "the start" : `"${spot.before.slice(0, 28)}"`} and ${spot.after === undefined ? "the end" : `"${spot.after.slice(0, 28)}"`}`;

    // A failed image's placeholder became a line of text saying so.
    const planned = [];
    for (const block of payload.blocks || []) {
      const text = norm(block?.text);
      if (!text) continue;
      if (!markerSet.has(text)) planned.push({ text });
      else if (failedNotes.has(text)) planned.push({ text: norm(failedNotes.get(text)) });
      else planned.push({ marker: text });
    }
    const wanted = new Map();
    planned.forEach((item, index) => {
      if (item.marker) wanted.set(item.marker, around(planned, index));
    });

    const content = draftNode.props.editorState.getCurrentContent();
    const actual = [];
    content.getBlockMap().forEach((block) => {
      if (block.getType() === "atomic") {
        const entity = blockEntity(content, block);
        if (entity?.type !== "MEDIA") actual.push({ embedded: true });
        else if (mediaIdOfData(entity.data)) actual.push({ image: mediaIdOfData(entity.data) });
        else actual.push({ unfinished: true });
        return;
      }
      const text = norm(block.getText());
      if (text && !(prefix && text.startsWith(prefix))) actual.push({ text });
    });

    const problems = [];
    const shown = uploads.filter((upload) => !upload.dropped);
    for (const upload of shown) {
      const index = actual.findIndex((item) => item.image === upload.mediaId);
      const name = `image ${upload.index} (${upload.label})`;
      if (index < 0) {
        problems.push(`${name} is not in the article`);
        continue;
      }
      const want = wanted.get(upload.marker);
      if (!sameSpot(want, around(actual, index))) {
        problems.push(`${name} is between ${describe(around(actual, index))}, the Markdown has it between ${describe(want)}`);
      }
    }
    const shownIds = shown.map((upload) => upload.mediaId);
    const foundIds = [...new Set(actual.map((item) => item.image).filter((id) => shownIds.includes(id)))];
    if (foundIds.join(",") !== shownIds.filter((id) => foundIds.includes(id)).join(",")) {
      problems.push("the images are in a different order than in the Markdown");
    }
    for (const upload of uploads.filter((item) => item.dropped && actual.some((line) => line.image === item.mediaId))) {
      problems.push(`the cover image (image ${upload.index}) is also still in the article body`);
    }
    // Anything else that is an image in the article should not be there.
    const ourIds = new Set(uploads.map((upload) => upload.mediaId));
    const counts = new Map();
    for (const item of actual) if (item.image) counts.set(item.image, (counts.get(item.image) || 0) + 1);
    for (const [id, count] of counts) {
      const upload = shown.find((candidate) => candidate.mediaId === id);
      if (upload && count > 1) problems.push(`image ${upload.index} (${upload.label}) is in the article ${count} times`);
      if (!ourIds.has(id)) problems.push(`the article has an image xPoster did not upload (media …${id.slice(-4)})`);
    }
    const unfinished = actual.filter((item) => item.unfinished).length;
    if (unfinished) problems.push(`the article has ${unfinished} unfinished image placeholder(s)`);
    if (checkEmbedded) {
      const embedded = actual.map((item, index) => (item.embedded ? index : -1)).filter((index) => index >= 0);
      const planned = atomicOps.map((item) => wanted.get(item.marker)).filter(Boolean);
      if (embedded.length !== planned.length) {
        problems.push(`the article has ${embedded.length} embedded block(s) (code, dividers, tweets), the Markdown has ${planned.length}`);
      } else {
        embedded.forEach((index, position) => {
          if (!sameSpot(planned[position], around(actual, index))) {
            problems.push(`embedded block ${position + 1} is between ${describe(around(actual, index))}, the Markdown has it between ${describe(planned[position])}`);
          }
        });
      }
    }
    return { ok: problems.length === 0, problems, images: shown.length, lines: actual.filter((item) => item.text !== undefined).length };
  }

  function kickRender(draftNode) {
    try {
      const EditorState = draftNode.props.editorState.constructor;
      draftNode.props.onChange(EditorState.moveSelectionToEnd(draftNode.props.editorState));
    } catch (error) {
      console.warn(LOG, "render kick failed", error);
    }
  }

  const GRAPHQL_FEATURES = {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };

  const X_BEARER_TOKEN =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  function articleIdFromUrl() {
    return location.href.match(/\/articles\/edit\/(\d+)/)?.[1] || null;
  }

  function csrfToken() {
    return document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1] || "";
  }

  async function graphqlRequest(queryId, operationName, body) {
    // A request that never answers would stall the whole import.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
    let response;
    let text = "";
    try {
      response = await fetch(`https://x.com/i/api/graphql/${queryId}/${operationName}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${X_BEARER_TOKEN}`,
          "x-csrf-token": csrfToken(),
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session"
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      });
      try {
        text = await response.text();
      } catch {}
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const error = data?.errors?.map((item) => item.message || "GraphQL error").join("; ") || null;
    return {
      ok: response.ok && Boolean(data?.data) && !error,
      status: response.status,
      error: error || (!response.ok ? `HTTP ${response.status}` : !data?.data ? "X returned no GraphQL result" : null),
      body: text.slice(0, 240),
      data
    };
  }

  // Same call without the parsed response, which is too big to report.
  async function xGraphql(queryId, operationName, body) {
    const { data, ...result } = await graphqlRequest(queryId, operationName, body);
    return result;
  }

  const TITLE_QUERY_ID = "x75E2ABzm8_mGTg1bz8hcA";

  function titleBody(articleId, title) {
    return {
      variables: { articleEntityId: articleId, title: String(title) },
      features: GRAPHQL_FEATURES,
      queryId: TITLE_QUERY_ID
    };
  }

  function updateTitleGraphql(articleId, title) {
    return xGraphql(TITLE_QUERY_ID, "ArticleEntityUpdateTitle", titleBody(articleId, title));
  }

  // --- What X has saved --------------------------------------------------
  // Setting the title again returns the article as X's server holds it. That is
  // the copy X rebuilds its editor from, so it has to match the editor before
  // anything happens that makes X rebuild.

  function findContentState(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 6) return null;
    if (Array.isArray(node.blocks)) return node;
    for (const value of Object.values(node)) {
      const found = findContentState(value, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function serverEntity(entityMap, key) {
    if (!entityMap || key === undefined || key === null) return null;
    if (Array.isArray(entityMap)) {
      return entityMap.find((item) => item && String(item.key) === String(key)) || entityMap[Number(key)] || null;
    }
    return entityMap[String(key)] || null;
  }

  // A media ID inside whatever shape X's reply gives an entity: an object with a
  // mediaId, a JSON string holding one, or a key/value pair. localMediaId is
  // not it.
  function findMediaId(node, depth = 0) {
    if (!node || depth > 8) return "";
    if (typeof node === "string") {
      if (!node.startsWith("{") && !node.startsWith("[")) return "";
      try {
        return findMediaId(JSON.parse(node), depth + 1);
      } catch {
        return "";
      }
    }
    if (typeof node !== "object") return "";
    if (!Array.isArray(node)) {
      for (const name of ["mediaId", "media_id"]) {
        if (/^\d{6,}$/.test(String(node[name] ?? ""))) return String(node[name]);
      }
      if ((node.key === "mediaId" || node.key === "media_id") && /^\d{6,}$/.test(String(node.value ?? ""))) return String(node.value);
    }
    for (const value of Object.values(node)) {
      const found = findMediaId(value, depth + 1);
      if (found) return found;
    }
    return "";
  }

  // The article as a list of items: a text per non-empty paragraph, and one
  // entry per embedded block with its type and (for images) its media ID.
  function serverArticleItems(data) {
    const state = findContentState(data?.data);
    if (!state) return null;
    const entityMap = state.entity_map ?? state.entityMap ?? null;
    const items = [];
    for (const block of state.blocks) {
      if (block?.type === "atomic") {
        const range = (block.entityRanges || block.entity_ranges || [])[0];
        const entity = range ? serverEntity(entityMap, range.key) : null;
        const type = String(entity?.type ?? entity?.value?.type ?? "").toUpperCase() || (/media/i.test(JSON.stringify(entity || "")) ? "MEDIA" : "");
        items.push({ kind: "atomic", type, mediaId: type === "MEDIA" ? findMediaId(entity) : "" });
        continue;
      }
      const text = String(block?.text || "").replace(/\s+/g, " ").trim();
      if (text) items.push({ kind: "text", text });
    }
    return items;
  }

  function articleItems(contentState) {
    const items = [];
    contentState.getBlockMap().forEach((block) => {
      if (block.getType() === "atomic") {
        const entity = blockEntity(contentState, block);
        const type = entity?.type || "";
        items.push({ kind: "atomic", type, mediaId: type === "MEDIA" ? mediaIdOfData(entity.data) : "" });
        return;
      }
      const text = (block.getText() || "").replace(/\s+/g, " ").trim();
      if (text) items.push({ kind: "text", text });
    });
    return items;
  }

  const describeItems = (items) =>
    `${items.filter((item) => item.kind === "text").length} paragraphs, ${items.filter((item) => item.kind === "atomic").length} embedded`;

  // Same paragraphs and the same embedded blocks in the same places. An image
  // that has not got its media ID yet matches any.
  function sameArticle(editorItems, savedItems) {
    const shape = (items) => items.map((item) => (item.kind === "text" ? "t" : "a")).join("");
    if (shape(editorItems) !== shape(savedItems)) {
      return { ok: false, reason: `editor has ${describeItems(editorItems)}, X saved ${describeItems(savedItems)}` };
    }
    for (let index = 0; index < editorItems.length; index += 1) {
      const mine = editorItems[index];
      const theirs = savedItems[index];
      if (mine.kind !== "atomic") continue;
      if (mine.type && theirs.type && (mine.type === "MEDIA") !== (theirs.type === "MEDIA")) {
        return { ok: false, reason: `item ${index + 1} is ${mine.type} here, ${theirs.type} there` };
      }
      if (mine.mediaId && theirs.mediaId && mine.mediaId !== theirs.mediaId) {
        return { ok: false, reason: `image at item ${index + 1} differs (…${mine.mediaId.slice(-4)} here, …${theirs.mediaId.slice(-4)} there)` };
      }
    }
    return { ok: true };
  }

  async function readSavedArticle(saved) {
    try {
      const result = await graphqlRequest(TITLE_QUERY_ID, "ArticleEntityUpdateTitle", titleBody(saved.articleId, saved.title));
      if (!result.ok) return { ok: false, error: result.error || `HTTP ${result.status}` };
      const items = serverArticleItems(result.data);
      if (!items) return { ok: false, unreadable: true, error: "X's reply has no article content" };
      return { ok: true, items };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  // Edit the last paragraph the way a person would so X saves the article. If
  // the edit leaves anything behind, the article is put back exactly as it was.
  async function nudgeAutosave() {
    const node = findDraftStateNode();
    const editor = findEditorElement();
    if (!node || !editor || typeof document.execCommand !== "function") return { ok: false };
    const contentBefore = node.props.editorState.getCurrentContent();
    let lastKey = null;
    contentBefore.getBlockMap().forEach((block, key) => {
      if (block.getType() !== "atomic") lastKey = key;
    });
    if (!lastKey) return { ok: false };
    const blockBefore = contentBefore.getBlockMap().get(lastKey);
    const original = blockBefore.getText();
    const editorState = node.props.editorState;
    const SelectionState = editorState.getSelection().constructor;
    const selection = SelectionState.createEmpty(lastKey).merge({ anchorOffset: original.length, focusOffset: original.length });
    node.props.onChange(editorState.constructor.forceSelection(editorState, selection));
    await sleep(200);
    editor.focus();
    document.execCommand("insertText", false, " ");
    await sleep(250);
    document.execCommand("delete");
    await sleep(250);
    const blockAfter = findDraftStateNode()?.props.editorState.getCurrentContent().getBlockMap().get(lastKey);
    const sameStyling = !blockAfter?.getCharacterList?.().equals || blockAfter.getCharacterList().equals(blockBefore.getCharacterList());
    if (blockAfter && blockAfter.getText() === original && sameStyling) return { ok: true };
    note("the edit that prompts a save left the last paragraph changed; putting it back");
    putBackContent(contentBefore, lastKey);
    await waitUntil(() => findDraftStateNode()?.props.editorState.getCurrentContent().getBlockMap().get(lastKey)?.getText() === original, 2000);
    return { ok: false, damaged: true };
  }

  // Wait until the copy X saved holds the same article as the editor. Returns
  // early when X cannot be asked, and gives up after a while so one slow save
  // does not stall the whole import.
  async function waitForSave(saved, label) {
    if (!saved || saved.off) return { skipped: true };
    const startedAt = Date.now();
    const limit = saved.timeouts ? 5000 : 14000;
    let nudged = false;
    progress(`Waiting for X to save (${label})...`);
    for (let attempt = 0; ; attempt += 1) {
      const node = findDraftStateNode();
      if (!node) return { ok: false, error: "X editor disappeared" };
      const editorItems = articleItems(node.props.editorState.getCurrentContent());
      const reply = await readSavedArticle(saved);
      if (!reply.ok) {
        saved.failures += 1;
        note(`could not read X's saved copy: ${reply.error}`);
        if (reply.unreadable || saved.failures >= 2) saved.off = true;
        return { ok: false, unreadable: true, error: reply.error };
      }
      saved.failures = 0;
      const verdict = sameArticle(editorItems, reply.items);
      if (verdict.ok) {
        saved.matched += 1;
        if (nudged) saved.nudgeWorked = true;
        note(`X has saved ${label} (${describeItems(editorItems)}) after ${Date.now() - startedAt}ms`);
        return { ok: true, ms: Date.now() - startedAt };
      }
      const waited = Date.now() - startedAt;
      // X may only save what a person typed. Once a nudge has worked, use it sooner.
      if (!nudged && !saved.nudgeUseless && waited > (saved.nudgeWorked ? 2000 : 5000)) {
        nudged = true;
        saved.nudges += 1;
        note(`X has not saved ${label} after ${waited}ms (${verdict.reason}); editing the last paragraph to prompt a save`);
        const nudge = await nudgeAutosave();
        if (!nudge.ok) saved.nudgeUseless = true;
      }
      if (waited > limit) {
        saved.timeouts += 1;
        if (nudged) saved.nudgeUseless = true;
        if (saved.timeouts >= 3) saved.off = true;
        note(`gave up waiting for X to save ${label} after ${waited}ms (${verdict.reason})`);
        return { ok: false, timedOut: true, reason: verdict.reason };
      }
      await sleep(attempt === 0 ? 900 : attempt === 1 ? 1400 : 1800);
    }
  }

  function updateCoverGraphql(articleId, mediaId, category = "DraftTweetImage") {
    return xGraphql("Es8InPh7mEkK9PxclxFAVQ", "ArticleEntityUpdateCoverMedia", {
      variables: {
        articleEntityId: articleId,
        coverMedia: { media_id: String(mediaId), media_category: category }
      },
      features: GRAPHQL_FEATURES,
      queryId: "Es8InPh7mEkK9PxclxFAVQ"
    });
  }

  // Draft cannot hold an editor with no block at all.
  function withAtLeastOneBlock(blockMap, sampleBlock) {
    if (blockMap.last() || !sampleBlock) return blockMap;
    const key = Math.random().toString(36).slice(2, 7);
    const empty = sampleBlock.merge({
      key,
      type: "unstyled",
      text: "",
      characterList: sampleBlock.getCharacterList().clear(),
      depth: 0,
      data: sampleBlock.getData?.()?.clear?.() || sampleBlock.getData?.()
    });
    return blockMap.set(key, empty);
  }

  function deleteBlocksByKey(draftNode, blockKeys) {
    if (!blockKeys.length || blockKeys.some((key) => !key)) return { ok: false, error: "Missing block key" };
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    if (!blockMap.has(blockKeys[0])) return { ok: false, error: "Block not found" };
    let nextBlockMap = blockMap;
    for (const key of blockKeys) nextBlockMap = nextBlockMap.delete(key);
    nextBlockMap = withAtLeastOneBlock(nextBlockMap, findDraftSampleBlock(draftNode));
    const lastKey = nextBlockMap.last()?.getKey?.();
    const selection = lastKey ? SelectionState.createEmpty(lastKey) : editorState.getSelection();
    const nextContent = contentState
      .set("blockMap", nextBlockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return { ok: true };
  }

  function deleteBlockByKey(draftNode, blockKey) {
    return deleteBlocksByKey(draftNode, [blockKey]);
  }

  // The empty paragraph right above a block: what X leaves behind when it splits
  // a placeholder line to insert an image there.
  function strayEmptyAbove(contentState, blockKey) {
    let previousKey = null;
    let stray = null;
    contentState.getBlockMap().forEach((_block, key) => {
      if (key === blockKey && previousKey) {
        const above = contentState.getBlockMap().get(previousKey);
        if (isEmptyParagraph(above)) stray = previousKey;
      }
      previousKey = key;
    });
    return stray;
  }

  function findUploadedMediaBlock(draftNode, upload) {
    const content = draftNode.props.editorState.getCurrentContent();
    let match = null;
    content.getBlockMap().forEach((block, key) => {
      if (match || block.getType() !== "atomic") return;
      block.findEntityRanges(
        (character) => Boolean(character.getEntity()),
        (start) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey) return;
          try {
            const entity = content.getEntity(entityKey);
            if (entity.getType() !== "MEDIA") return;
            const data = entity.getData();
            const ids = (data?.mediaItems || data?.media_items || []).map((item) => String(item.mediaId || item.media_id || ""));
            // The media ID says which image this is. The entity key only counts
            // while the block has no ID yet: X can give a key to another image.
            if (ids.includes(String(upload.mediaId)) || (!ids.some(Boolean) && entityKey === upload.entityKey)) match = key;
          } catch {}
        }
      );
    });
    return match;
  }

  async function removeCoverBodyImage(upload) {
    // Setting a cover can replace the React editor instance. Resolve the live
    // node and the uploaded media identity instead of relying on old block keys.
    let node = findDraftStateNode();
    if (!node) return { ok: false, error: "X editor disappeared after setting the cover" };
    const key = findUploadedMediaBlock(node, upload);
    if (!key) return { ok: true, alreadyAbsent: true };
    const stray = strayEmptyAbove(node.props.editorState.getCurrentContent(), key);
    const result = deleteBlocksByKey(node, stray ? [key, stray] : [key]);
    if (!result.ok) return result;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await sleep(80);
      node = findDraftStateNode();
      if (node && !findUploadedMediaBlock(node, upload)) return { ok: true };
    }
    return { ok: false, error: "Cover was set, but its duplicate body image could not be removed. Remove that body image in X." };
  }

  async function setTitleViaUi(title) {
    if (!title) return { ok: true, skipped: true };
    const editor = findEditorElement();
    const candidates = Array.from(document.querySelectorAll("input[type='text'], textarea, [contenteditable='true']")).filter(
      (element) => element !== editor && isVisible(element)
    );
    const titleWords = ["title", "标题", "add title", "输入标题"];
    let best = null;
    let score = -1;
    for (const element of candidates) {
      const haystack = [
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.getAttribute("data-testid")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const rect = element.getBoundingClientRect();
      let current = 0;
      if (titleWords.some((word) => haystack.includes(word))) current += 10;
      if (rect.top < 420) current += 3;
      if (rect.width > 240) current += 2;
      if (current > score) {
        score = current;
        best = element;
      }
    }
    if (!best || score <= 0) return { ok: false, error: "Title field not found" };
    if (best instanceof HTMLInputElement || best instanceof HTMLTextAreaElement) {
      const proto = best instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(best, String(title));
      best.dispatchEvent(new Event("input", { bubbles: true }));
      best.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      best.focus();
      await sleep(80);
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, String(title));
      best.dispatchEvent(new Event("input", { bubbles: true }));
      best.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true };
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  // The article goes in the way a person would build it: the title, then all the
  // text, then one image at a time. After each upload the image is put where the
  // Markdown has it and X is given time to save before the next one starts.
  async function runFlow(payload) {
    let draftNode = findDraftStateNode();
    if (!draftNode) throw new Error("X Draft.js editor was not reachable");
    const articleId = articleIdFromUrl();
    const markerPrefix = payload.markerPrefix;
    const atomicOps = (payload.plan || []).filter((item) => item.op.type === "atomic");
    const imageOps = (payload.plan || []).filter((item) => item.op.type === "image");
    const hasMarkers = (payload.plan || []).length > 0;

    const summary = {
      atomicOk: 0,
      atomicFail: 0,
      imgOk: 0,
      imgFail: 0,
      imageErrors: [],
      markersCleaned: 0,
      tidied: 0,
      relocatedImages: 0,
      recreatedImages: 0,
      atomicRestored: 0,
      bodyRestores: [],
      body: null,
      bodyLost: false,
      markersLeft: 0,
      layout: null,
      saved: null,
      trace: null,
      title: {
        requested: Boolean(payload.title),
        value: payload.title || null,
        articleId: articleId || null,
        ui: null,
        graphql: null
      },
      cover: {
        requested: Boolean(payload.cover),
        source: payload.cover || null,
        matchedUpload: false,
        mediaIdSuffix: null,
        graphql: null,
        bodyBlockDeleted: null,
        skippedReason: null
      }
    };

    startFlight(markerPrefix);
    installNetworkWatch();
    try {
      // 1. Title first. X saves it on its own too, and what it sends back can
      // reload the editor, so let that finish while there is no article to lose.
      if (payload.title) {
        progress("Setting title...");
        note("title: setting");
        const result = await setTitleViaUi(payload.title);
        summary.title.ui = result;
        if (!result.ok) console.warn(LOG, "title failed", result.error);
        if (articleId) {
          const graphResult = await updateTitleGraphql(articleId, payload.title).catch((error) => ({
            ok: false,
            error: error?.message || String(error)
          }));
          summary.title.graphql = graphResult;
          if (!graphResult.ok) console.warn(LOG, "title GraphQL failed", graphResult);
        } else {
          summary.title.graphql = { ok: false, skipped: true, reason: "No article id in URL" };
        }
        await sleep(1200);
        await waitForStable(4000, 600);
      }

      // 2. All the text, with a placeholder line wherever an image goes.
      progress("Pasting structured Markdown...");
      draftNode = await ensureDraftCharacterSample(findDraftStateNode() || draftNode);
      const writeResult = writeDraftBlocks(draftNode, payload.blocks);
      if (!writeResult.ok) {
        console.warn(LOG, "structured block write failed; falling back to paste", writeResult.error);
        pasteHtml(payload.html, payload.plain);
      }
      draftNode = await waitForDraftMarkers(markerPrefix, (payload.plan || []).length);
      if (!draftNode) throw new Error("X Draft.js editor was not reachable after writing Markdown");
      await sleep(150);
      note(`article written: ${editorShape(draftNode, markerPrefix)}`);

      if (atomicOps.length) {
        progress(`Inserting ${atomicOps.length} special block(s)...`);
        draftNode = findDraftStateNode() || draftNode;
        const result = insertAtomicBatch(draftNode, atomicOps);
        summary.atomicOk = result.okCount;
        summary.atomicFail = result.failCount;
        if (result.errors?.length) console.warn(LOG, "atomic failures", result.errors);
        await sleep(350);
        await waitUntil(() => {
          const latest = findDraftStateNode();
          return !latest || atomicOps.every((item) => !findMarkerBlock(latest.props.editorState.getCurrentContent(), item.marker));
        }, 2500);
      }

      draftNode = findDraftStateNode() || draftNode;
      const protectedAtomicBlocks = new Set();
      draftNode.props.editorState
        .getCurrentContent()
        .getBlockMap()
        .forEach((block, key) => {
          if (block.getType() === "atomic") protectedAtomicBlocks.add(key);
        });
      const articleTexts = textBlocks(draftNode.props.editorState.getCurrentContent()).filter(
        (text) => !text.startsWith(markerPrefix)
      );

      const saved = articleId && payload.title
        ? { articleId, title: String(payload.title), off: false, failures: 0, timeouts: 0, matched: 0, nudges: 0, nudgeWorked: false, nudgeUseless: false }
        : null;

      const uploads = [];
      const seenMediaIds = new Set();
      // pending: not uploaded yet, placed: uploaded and sitting before its
      // placeholder, failed: placeholder turned into a note, cover: used as the
      // cover and taken out of the body.
      const markerState = new Map(imageOps.map((item) => [item.marker, "pending"]));
      const neededMarkers = () =>
        imageOps.map((item) => item.marker).filter((marker) => ["pending", "placed"].includes(markerState.get(marker)));
      let coverUpload = null;
      let cleanedUp = false;

      // The last editor content known to hold the whole article and the images
      // so far, used to put it back if X swaps in an earlier state.
      let knownGood = null;
      const captureKnownGood = () => {
        const node = findDraftStateNode() || draftNode;
        const content = node.props.editorState.getCurrentContent();
        if (!markersPresent(node, neededMarkers())) return false;
        if (articleTexts.length && inspectBody(articleTexts, content, null, []).replaced) return false;
        knownGood = content;
        return true;
      };
      captureKnownGood();

      const ensureWhole = async (label) => {
        draftNode = findDraftStateNode() || draftNode;
        const needed = neededMarkers();
        if (knownGood && !markersPresent(draftNode, needed) && putBackContent(knownGood)) {
          console.warn(LOG, "article was replaced before upload", label);
          progress("X replaced the article. Putting it back...", "warn");
          note(`image ${label}: the article had been replaced; putting it back`);
          const ok = await waitUntil(() => markersPresent(findDraftStateNode(), needed), 2500);
          summary.bodyRestores.push({ stage: "before-upload", image: label, ok });
          draftNode = findDraftStateNode() || draftNode;
        }
      };

      // The article has all its text (and the placeholders still to come).
      const bodyIsWhole = () => {
        const node = findDraftStateNode();
        return Boolean(node) && !inspectBody(articleTexts, node.props.editorState.getCurrentContent(), null, cleanedUp ? [] : neededMarkers()).replaced;
      };
      const failureNote = (item) => item.op.fallbackText || "[image upload failed]";
      const markerGone = (marker) => () => {
        const node = findDraftStateNode();
        return !node || !findMarkerBlock(node.props.editorState.getCurrentContent(), marker);
      };

      // Bring the article back to what it should be after X has had its say:
      // the whole text, embedded blocks, images before their placeholders, and
      // the cover image out of the body. Returns true when something was fixed.
      // Every edit waits for the one before to commit: editing from the state
      // before a commit throws that commit away.
      const settleArticle = async () => {
        draftNode = findDraftStateNode() || draftNode;
        let changed = false;
        if (knownGood) {
          const body = inspectBody(articleTexts, draftNode.props.editorState.getCurrentContent(), null, cleanedUp ? [] : neededMarkers());
          if (body.replaced && putBackContent(knownGood)) {
            console.warn(LOG, "article was replaced after an upload", body);
            summary.bodyRestores.push({ stage: "after-settle", kept: body.kept, total: body.total });
            progress("X replaced the article. Putting it back...", "warn");
            note(`the article was replaced (${body.kept}/${body.total} paragraphs left); putting it back`);
            await waitUntil(bodyIsWhole, 2500);
            draftNode = findDraftStateNode() || draftNode;
            changed = true;
          }
        }
        const content = draftNode.props.editorState.getCurrentContent();
        const reverted = atomicOps.filter((item) => findMarkerBlock(content, item.marker));
        if (reverted.length) {
          const result = insertAtomicBatch(draftNode, reverted);
          summary.atomicRestored += result.okCount;
          if (result.okCount) {
            changed = true;
            await waitUntil(() => reverted.every((item) => markerGone(item.marker)()), 2500);
            draftNode = findDraftStateNode() || draftNode;
          }
        }
        // A failed image's note is undone when X brings back a copy that still
        // has its placeholder line.
        for (const item of imageOps) {
          if (markerState.get(item.marker) !== "failed") continue;
          draftNode = findDraftStateNode() || draftNode;
          if (!findMarkerBlock(draftNode.props.editorState.getCurrentContent(), item.marker)) continue;
          if (replaceMarkerText(draftNode, item.marker, failureNote(item))) {
            changed = true;
            await waitUntil(markerGone(item.marker), 2000);
            draftNode = findDraftStateNode() || draftNode;
          }
        }
        if (coverUpload) {
          const removed = await removeCoverBodyImage(coverUpload);
          summary.cover.bodyBlockDeleted = removed;
          if (removed.ok) {
            coverUpload.dropped = true;
            markerState.set(coverUpload.marker, "cover");
            if (!removed.alreadyAbsent) changed = true;
          } else {
            console.warn(LOG, "cover block cleanup failed", removed);
          }
          draftNode = findDraftStateNode() || draftNode;
          if (coverUpload.dropped && removeMarkerBlock(coverUpload.marker)) {
            changed = true;
            await waitUntil(markerGone(coverUpload.marker), 2000);
            draftNode = findDraftStateNode() || draftNode;
          }
        }
        // Nothing is uploading now, so an image without a media ID is a loading
        // placeholder that came back from an older copy and will never finish.
        const zombies = await removePendingMedia(new Set());
        if (zombies) {
          summary.tidied += zombies;
          changed = true;
          note(`removed ${zombies} unfinished image placeholder(s) that came back`);
          draftNode = findDraftStateNode() || draftNode;
        }
        const placed = placeImages(draftNode, uploads, protectedAtomicBlocks);
        summary.relocatedImages += placed.moved;
        summary.recreatedImages += placed.created;
        if (placed.moved || placed.created) {
          changed = true;
          await sleep(400);
          draftNode = findDraftStateNode() || draftNode;
        }
        return changed;
      };

      // Keep settling until X leaves the article alone for two looks in a row.
      const stabilize = async (label) => {
        let calm = 0;
        for (let round = 0; round < 5 && calm < 2; round += 1) {
          progress(`Placing ${label}...`);
          await waitForStable(5000, 600);
          if (await settleArticle()) {
            calm = 0;
            note(`${label}: fixed the article (pass ${round + 1})`);
          } else {
            calm += 1;
          }
        }
        return calm >= 2;
      };

      if (hasMarkers) {
        await waitForStable(4000, 500);
        await waitForSave(saved, "the article text");
        captureKnownGood();
      }

      // 3. The images, one at a time, in the order of the article.
      for (let index = 0; index < imageOps.length; index += 1) {
        const op = imageOps[index];
        const label = op.op.file?.fileName || op.op.source || op.marker;
        progress(`Uploading image ${index + 1}/${imageOps.length}...`);
        note(`image ${index + 1}/${imageOps.length} (${label}): uploading`);
        await ensureWhole(index + 1);
        const keep = neededMarkers().filter((marker) => marker !== op.marker);
        draftNode = findDraftStateNode() || draftNode;
        let result = await uploadImageAtMarker(draftNode, op, protectedAtomicBlocks, keep, seenMediaIds);
        if (!result.ok && /timed out/i.test(result.error || "")) {
          progress(`Retrying image ${index + 1}...`, "warn");
          note(`image ${index + 1}: timed out; trying again`);
          await sleep(1400);
          await ensureWhole(index + 1);
          draftNode = findDraftStateNode() || draftNode;
          result = await uploadImageAtMarker(draftNode, op, protectedAtomicBlocks, keep, seenMediaIds);
        }
        if (result.restored) {
          summary.bodyRestores.push({ stage: "after-upload", image: index + 1, ...result.restored });
        }
        if (result.ok) {
          seenMediaIds.add(String(result.mediaId));
          summary.imgOk += 1;
          const entry = {
            marker: op.marker,
            blockKey: result.blockKey,
            entityKey: result.entityKey,
            mediaId: result.mediaId,
            source: op.op.source,
            data: result.data,
            mutability: result.mutability,
            index: index + 1,
            label
          };
          uploads.push(entry);
          markerState.set(op.marker, "placed");
          note(`image ${index + 1}: uploaded (media …${String(result.mediaId).slice(-4)})`);

          // The cover is set as soon as its image is up, so nothing that happens
          // to the cover can disturb the article later.
          if (payload.cover && !coverUpload && op.op.source === payload.cover) {
            summary.cover.matchedUpload = true;
            summary.cover.mediaIdSuffix = entry.mediaId.slice(-8);
            if (!articleId) {
              summary.cover.skippedReason = "No article id in URL";
              console.warn(LOG, "cover update skipped: no article id");
            } else {
              progress("Setting cover...");
              note(`image ${index + 1}: setting it as the cover`);
              const coverResult = await updateCoverGraphql(articleId, entry.mediaId).catch((error) => ({
                ok: false,
                error: error?.message || String(error)
              }));
              summary.cover.graphql = coverResult;
              if (coverResult.ok) coverUpload = entry;
              else console.warn(LOG, "cover update failed", coverResult);
            }
          }

          await stabilize(`image ${index + 1}`);
          await waitForSave(saved, `image ${index + 1}`);
          captureKnownGood();
        } else {
          summary.imgFail += 1;
          markerState.set(op.marker, "failed");
          summary.imageErrors.push({
            index: index + 1,
            marker: op.marker,
            source: op.op.source || null,
            fileName: op.op.file?.fileName || null,
            error: result.error || "Image upload failed"
          });
          note(`image ${index + 1}: failed (${result.error || "image upload failed"})`);
          // X may have swapped the editor instance during the failed upload.
          draftNode = findDraftStateNode() || draftNode;
          replaceMarkerText(draftNode, op.marker, failureNote(op));
          console.warn(LOG, "image failed", result.error);
          await waitUntil(markerGone(op.marker), 2000);
          captureKnownGood();
        }
        draftNode = findDraftStateNode() || draftNode;
      }

      if (payload.cover && !summary.cover.matchedUpload && !summary.cover.skippedReason) {
        summary.cover.skippedReason = articleId ? "Cover source has no uploaded media match" : "No article id in URL";
        console.warn(LOG, "cover source has no uploaded media match", payload.cover);
      }

      // 4. Take the placeholder lines out and make sure it still holds.
      const articleIsFinal = () => {
        if (countBlocksStartingWith(draftNode, markerPrefix) > 0) return false;
        if (coverUpload && findUploadedMediaBlock(draftNode, coverUpload)) return false;
        return !(articleTexts.length && inspectBody(articleTexts, draftNode.props.editorState.getCurrentContent(), null, []).replaced);
      };

      let finalSave = null;
      if (hasMarkers) {
        progress("Checking the finished article...");
        await waitForStable(4000, 600);
      }
      for (let round = 0; round < (hasMarkers ? 3 : 1); round += 1) {
        if (hasMarkers) await stabilize("the finished article");
        progress("Cleaning up import markers...");
        draftNode = findDraftStateNode() || draftNode;
        const cleaned = cleanupMarkers(draftNode, markerPrefix);
        summary.markersCleaned += cleaned.markers;
        summary.tidied += cleaned.tidied;
        cleanedUp = true;
        // Let marker cleanup commit before kicking rendering; otherwise an old
        // state can restore a body image that has just been removed for the cover.
        await sleep(80);
        if (cleaned.markers || cleaned.tidied) {
          await waitUntil(() => {
            const latest = findDraftStateNode();
            return !latest || (countBlocksStartingWith(latest, markerPrefix) === 0 && emptyParagraphs(latest) === 0);
          }, 2500);
        }
        draftNode = findDraftStateNode() || draftNode;
        kickRender(draftNode);
        await sleep(250);
        if (!hasMarkers) break;
        await waitForStable(4000, 600);
        finalSave = await waitForSave(saved, "the finished article");
        draftNode = findDraftStateNode() || draftNode;
        if (articleIsFinal()) break;
      }
      draftNode = findDraftStateNode() || draftNode;
      summary.markersLeft = countBlocksStartingWith(draftNode, markerPrefix);
      summary.body = importedBodyStats(draftNode, payload);
      summary.bodyLost = summary.body.expected >= 4 && summary.body.actual * 2 < summary.body.expected;
      if (summary.bodyLost) console.warn(LOG, "article body is missing after import", summary.body);
      if (hasMarkers) {
        const failedNotes = new Map(
          imageOps
            .filter((item) => markerState.get(item.marker) === "failed")
            .map((item) => [item.marker, failureNote(item)])
        );
        summary.layout = layoutReport(draftNode, payload, uploads, atomicOps, summary.atomicFail === 0, failedNotes);
        note(summary.layout.ok ? `layout: ${summary.layout.images} image(s) where the Markdown has them` : `layout: ${summary.layout.problems.join("; ")}`);
      }
      if (saved) {
        summary.saved = { matched: saved.matched, timeouts: saved.timeouts, nudges: saved.nudges, stoppedAsking: saved.off, final: finalSave };
      }
    } finally {
      stopFlight();
    }
    summary.trace = flightLog();
    post("done", { summary });
  }

  let flowRunning = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== CHANNEL_TO_MAIN) return;
    if (event.data.kind === "ready?") {
      post("ready");
      return;
    }
    if (event.data.kind === "run") {
      // Two imports editing the same article would undo each other.
      if (flowRunning) {
        post("error", { error: "An xPoster import is still running on this page. Wait for it to finish, or refresh the tab." });
        return;
      }
      flowRunning = true;
      runFlow(event.data.payload)
        .catch((error) => {
          console.error(LOG, error);
          post("error", { error: error?.message || String(error), stack: error?.stack || null, trace: flightLog() });
        })
        .finally(() => {
          flowRunning = false;
        });
      return;
    }
    if (event.data.kind === "diagnostics") {
      const editorElement = findEditorElement();
      const draftNode = findDraftStateNode();
      const onFilesAdded = findOnFilesAdded();
      post("diagnostics", {
        payload: {
          ok: true,
          mainWorld: true,
          hasEditorElement: Boolean(editorElement),
          hasDraftStateNode: Boolean(draftNode),
          hasOnFilesAdded: Boolean(onFilesAdded),
          articleId: articleIdFromUrl(),
          editorBounds: editorElement
            ? {
                width: Math.round(editorElement.getBoundingClientRect().width),
                height: Math.round(editorElement.getBoundingClientRect().height)
              }
            : null
        }
      });
    }
  });

  console.log(LOG, "ready");
  post("ready");
})();
