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

  function findOnFilesAdded() {
    const editor = findEditorElement();
    if (!editor) return null;
    const fiberKey = Object.keys(editor).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;
    let fiber = editor[fiberKey];
    for (let depth = 0; depth < 80 && fiber; depth += 1) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (typeof props?.onFilesAdded === "function") return props.onFilesAdded;
      fiber = fiber.return;
    }
    return null;
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
    return { ok: true, blocks: createdKeys.length };
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

  function existingMediaEntities(contentState) {
    const entities = new Set();
    contentState.getBlockMap().forEach((block) => {
      if (block.getType() !== "atomic") return;
      block.findEntityRanges(
        (character) => Boolean(character.getEntity()),
        (start) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey) return;
          try {
            if (contentState.getEntity(entityKey).getType() === "MEDIA") entities.add(entityKey);
          } catch {}
        }
      );
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

  // X can still be rebuilding its editor for a moment after the title and cover
  // calls. Wait until the editor instance and its content stop changing.
  async function waitForEditorSettled(timeoutMs = 4000, quietMs = 700) {
    const startedAt = Date.now();
    let last = null;
    let since = startedAt;
    while (Date.now() - startedAt < timeoutMs) {
      const node = findDraftStateNode();
      const content = node ? node.props.editorState.getCurrentContent() : null;
      if (!last || last.node !== node || last.content !== content) {
        last = { node, content };
        since = Date.now();
      } else if (Date.now() - since >= quietMs) {
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
    const onFilesAdded = findOnFilesAdded();
    if (!onFilesAdded) return { ok: false, error: "X upload handler was not reachable" };

    const beforeContent = draftNode.props.editorState.getCurrentContent();
    const beforeTexts = textBlocks(beforeContent);
    if (!placeSelectionAtMarker(draftNode, imageOperation.marker)) {
      return { ok: false, error: "Image placeholder was not found in the X editor" };
    }
    await sleep(80);

    const before = existingMediaEntities(draftNode.props.editorState.getCurrentContent());
    const beforeIds = existingMediaIds(draftNode.props.editorState.getCurrentContent());
    const preparedFile = await requestPreparedFile(imageOperation);
    const file = base64ToFile(preparedFile.base64, preparedFile.fileName, preparedFile.mime);

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
            if (!entityKey || before.has(entityKey)) return;
            try {
              const entity = contentState.getEntity(entityKey);
              if (entity.getType() !== "MEDIA") return;
              const data = entity.getData();
              const item = data?.mediaItems?.[0] || data?.media_items?.[0];
              const mediaId = item?.mediaId || item?.media_id || null;
              // A MEDIA block appears before its server-side media ID is ready.
              // Wait for the ID so the same upload can also become the cover.
              if (!mediaId) return;
              if (beforeIds.has(String(mediaId)) || seenMediaIds.has(String(mediaId))) return;
              found = { entityKey, blockKey, mediaId: String(mediaId) };
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

    return { ok: false, error: "Timed out waiting for X media upload" };
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

    const byMediaId = new Map();
    const byEntity = new Map();
    const spare = [];
    contentState.getBlockMap().forEach((block, blockKey) => {
      if (block.getType() !== "atomic") return;
      let firstEntity = null;
      let isOurs = false;
      let isMedia = false;
      block.findEntityRanges(
        (character) => Boolean(character.getEntity()),
        (start) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey) return;
          firstEntity ||= entityKey;
          byEntity.set(entityKey, blockKey);
          try {
            const entity = contentState.getEntity(entityKey);
            if (entity.getType() !== "MEDIA") return;
            isMedia = true;
            const data = entity.getData();
            for (const item of data?.mediaItems || data?.media_items || []) {
              const id = String(item?.mediaId || item?.media_id || "");
              if (!id) continue;
              byMediaId.set(id, blockKey);
              if (ourIds.has(id)) isOurs = true;
            }
          } catch {}
        }
      );
      if (isMedia && !isOurs && !protectedAtomicBlocks.has(blockKey)) spare.push(blockKey);
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
      while (spareIndex < spare.length && claimed.has(spare[spareIndex])) spareIndex += 1;
      if (spare[spareIndex]) {
        item.imageKey = spare[spareIndex];
        spareIndex += 1;
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
    if (!toDelete.length) return 0;
    for (const key of toDelete) blockMap = blockMap.delete(key);
    const lastKey = blockMap.last()?.getKey?.();
    const selection = lastKey ? SelectionState.createEmpty(lastKey) : editorState.getSelection();
    const nextContent = contentState
      .set("blockMap", blockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return toDelete.length;
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

  async function xGraphql(queryId, operationName, body) {
    const response = await fetch(`https://x.com/i/api/graphql/${queryId}/${operationName}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${X_BEARER_TOKEN}`,
        "x-csrf-token": csrfToken(),
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session"
      },
      body: JSON.stringify(body)
    });
    let text = "";
    try {
      text = await response.text();
    } catch {}
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const error = data?.errors?.map((item) => item.message || "GraphQL error").join("; ") || null;
    return {
      ok: response.ok && Boolean(data?.data) && !error,
      status: response.status,
      error: error || (!response.ok ? `HTTP ${response.status}` : !data?.data ? "X returned no GraphQL result" : null),
      body: text.slice(0, 240)
    };
  }

  function updateTitleGraphql(articleId, title) {
    return xGraphql("x75E2ABzm8_mGTg1bz8hcA", "ArticleEntityUpdateTitle", {
      variables: { articleEntityId: articleId, title: String(title) },
      features: GRAPHQL_FEATURES,
      queryId: "x75E2ABzm8_mGTg1bz8hcA"
    });
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

  function deleteBlockByKey(draftNode, blockKey) {
    if (!blockKey) return { ok: false, error: "Missing block key" };
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    if (!blockMap.has(blockKey)) return { ok: false, error: "Block not found" };
    const nextBlockMap = blockMap.delete(blockKey);
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
            const items = data?.mediaItems || data?.media_items || [];
            if (entityKey === upload.entityKey || items.some((item) =>
              String(item.mediaId || item.media_id || "") === String(upload.mediaId))) match = key;
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
    const result = deleteBlockByKey(node, key);
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

  async function runFlow(payload) {
    let draftNode = findDraftStateNode();
    if (!draftNode) throw new Error("X Draft.js editor was not reachable");
    const articleId = articleIdFromUrl();
    progress("Pasting structured Markdown...");
    draftNode = await ensureDraftCharacterSample(draftNode);
    const writeResult = writeDraftBlocks(draftNode, payload.blocks);
    if (!writeResult.ok) {
      console.warn(LOG, "structured block write failed; falling back to paste", writeResult.error);
      pasteHtml(payload.html, payload.plain);
    }
    draftNode = await waitForDraftMarkers(payload.markerPrefix, (payload.plan || []).length);
    if (!draftNode) throw new Error("X Draft.js editor was not reachable after writing Markdown");
    await sleep(150);

    const summary = {
      atomicOk: 0,
      atomicFail: 0,
      imgOk: 0,
      imgFail: 0,
      imageErrors: [],
      markersCleaned: 0,
      relocatedImages: 0,
      recreatedImages: 0,
      atomicRestored: 0,
      bodyRestores: [],
      body: null,
      bodyLost: false,
      markersLeft: 0,
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

    const atomicOps = (payload.plan || []).filter((item) => item.op.type === "atomic");
    const imageOps = (payload.plan || []).filter((item) => item.op.type === "image");

    if (atomicOps.length) {
      progress(`Inserting ${atomicOps.length} special block(s)...`);
      draftNode = findDraftStateNode() || draftNode;
      const result = insertAtomicBatch(draftNode, atomicOps);
      summary.atomicOk = result.okCount;
      summary.atomicFail = result.failCount;
      if (result.errors?.length) console.warn(LOG, "atomic failures", result.errors);
      await sleep(350);
    }

    draftNode = findDraftStateNode() || draftNode;
    const protectedAtomicBlocks = new Set();
    draftNode.props.editorState
      .getCurrentContent()
      .getBlockMap()
      .forEach((block, key) => {
        if (block.getType() === "atomic") protectedAtomicBlocks.add(key);
      });

    // Last editor content known to hold the whole article, used to put it back
    // if X swaps in an earlier editor state between uploads.
    let knownGood = markersPresent(draftNode, imageOps.map((item) => item.marker))
      ? draftNode.props.editorState.getCurrentContent()
      : null;
    const uploads = [];
    const seenMediaIds = new Set();
    for (let index = 0; index < imageOps.length; index += 1) {
      const op = imageOps[index];
      const pendingMarkers = imageOps.slice(index).map((item) => item.marker);
      const laterMarkers = pendingMarkers.slice(1);
      progress(`Uploading image ${index + 1}/${imageOps.length}...`);
      draftNode = findDraftStateNode() || draftNode;
      if (knownGood && !markersPresent(draftNode, pendingMarkers) && putBackContent(knownGood)) {
        console.warn(LOG, "article was replaced before upload", index + 1);
        progress("X replaced the article. Putting it back...", "warn");
        const ok = await waitUntil(() => markersPresent(findDraftStateNode(), pendingMarkers), 2500);
        summary.bodyRestores.push({ stage: "before-upload", image: index + 1, ok });
        draftNode = findDraftStateNode() || draftNode;
      }
      let result = await uploadImageAtMarker(draftNode, op, protectedAtomicBlocks, laterMarkers, seenMediaIds);
      if (!result.ok && /timed out/i.test(result.error || "")) {
        progress(`Retrying image ${index + 1}...`, "warn");
        await sleep(1400);
        draftNode = findDraftStateNode() || draftNode;
        result = await uploadImageAtMarker(draftNode, op, protectedAtomicBlocks, laterMarkers, seenMediaIds);
      }
      if (result.restored) {
        summary.bodyRestores.push({ stage: "after-upload", image: index + 1, ...result.restored });
      }
      if (result.ok) {
        seenMediaIds.add(String(result.mediaId));
        summary.imgOk += 1;
        uploads.push({
          marker: op.marker,
          blockKey: result.blockKey,
          entityKey: result.entityKey,
          mediaId: result.mediaId,
          source: op.op.source,
          data: result.data,
          mutability: result.mutability
        });
      } else {
        summary.imgFail += 1;
        summary.imageErrors.push({
          index: index + 1,
          marker: op.marker,
          source: op.op.source || null,
          fileName: op.op.file?.fileName || null,
          error: result.error || "Image upload failed"
        });
        // X may have swapped the editor instance during the failed upload.
        draftNode = findDraftStateNode() || draftNode;
        replaceMarkerText(draftNode, op.marker, op.op.fallbackText || "[image upload failed]");
        console.warn(LOG, "image failed", result.error);
      }
      draftNode = findDraftStateNode() || draftNode;
      const latest = draftNode.props.editorState.getCurrentContent();
      const stillWhole = !knownGood || !inspectBody(textBlocks(knownGood), latest, op.marker, laterMarkers).replaced;
      if (stillWhole && markersPresent(draftNode, laterMarkers)) knownGood = latest;
    }

    if (payload.title) {
      progress("Setting title...");
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
    }

    let coverUpload = null;
    if (payload.cover) {
      if (!articleId) {
        summary.cover.skippedReason = "No article id in URL";
        console.warn(LOG, "cover update skipped: no article id");
      } else {
        const candidate = uploads.find((upload) => upload.source === payload.cover && upload.mediaId);
        if (candidate) {
          summary.cover.matchedUpload = true;
          summary.cover.mediaIdSuffix = candidate.mediaId ? candidate.mediaId.slice(-8) : null;
          progress("Setting cover...");
          const result = await updateCoverGraphql(articleId, candidate.mediaId).catch((error) => ({
            ok: false,
            error: error?.message || String(error)
          }));
          summary.cover.graphql = result;
          if (result.ok) coverUpload = candidate;
          else console.warn(LOG, "cover update failed", result);
        } else {
          summary.cover.skippedReason = "Cover source has no uploaded media match";
          console.warn(LOG, "cover source has no uploaded media match", payload.cover);
        }
      }
    }

    // X can rebuild its editor from the copy it saved when the title or cover call
    // finishes. That copy has the images where X first inserted them and none of
    // the placement we only made locally, so wait for X to settle, put the article
    // together, clean up, and look again in case the rebuild comes late.
    const markerPrefix = payload.markerPrefix;
    const allMarkers = uploads.map((upload) => upload.marker);
    const articleTexts = knownGood ? textBlocks(knownGood).filter((text) => !text.startsWith(markerPrefix)) : [];
    let cleanedUp = false;

    const settleArticle = async () => {
      draftNode = findDraftStateNode() || draftNode;
      let changed = false;
      if (knownGood) {
        const body = inspectBody(articleTexts, draftNode.props.editorState.getCurrentContent(), null, cleanedUp ? [] : allMarkers);
        if (body.replaced && putBackContent(knownGood)) {
          console.warn(LOG, "article was replaced after the title and cover calls", body);
          summary.bodyRestores.push({ stage: "after-settle", kept: body.kept, total: body.total });
          progress("X replaced the article. Putting it back...", "warn");
          await waitUntil(() => markersPresent(findDraftStateNode(), allMarkers), 2500);
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
          await sleep(350);
          draftNode = findDraftStateNode() || draftNode;
        }
      }
      if (coverUpload) {
        const removed = await removeCoverBodyImage(coverUpload);
        summary.cover.bodyBlockDeleted = removed;
        if (removed.ok) {
          coverUpload.dropped = true;
          if (!removed.alreadyAbsent) changed = true;
        } else {
          console.warn(LOG, "cover block cleanup failed", removed);
        }
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

    const articleIsFinal = () => {
      if (countBlocksStartingWith(draftNode, markerPrefix) > 0) return false;
      if (coverUpload && findUploadedMediaBlock(draftNode, coverUpload)) return false;
      return !(articleTexts.length && inspectBody(articleTexts, draftNode.props.editorState.getCurrentContent(), null, []).replaced);
    };

    const hasMarkers = (payload.plan || []).length > 0;
    if (hasMarkers) {
      progress("Putting the article together...");
      await sleep(900);
      await waitForEditorSettled();
    }
    for (let round = 0; round < (hasMarkers ? 3 : 1); round += 1) {
      if (hasMarkers) await settleArticle();
      progress("Cleaning up import markers...");
      draftNode = findDraftStateNode() || draftNode;
      summary.markersCleaned += cleanupMarkers(draftNode, markerPrefix);
      cleanedUp = true;
      // Let marker cleanup commit before kicking rendering; otherwise an old
      // state can restore a body image that has just been removed for the cover.
      await sleep(80);
      draftNode = findDraftStateNode() || draftNode;
      kickRender(draftNode);
      await sleep(250);
      if (!hasMarkers) break;
      await sleep(900);
      draftNode = findDraftStateNode() || draftNode;
      if (articleIsFinal()) break;
    }
    draftNode = findDraftStateNode() || draftNode;
    summary.markersLeft = countBlocksStartingWith(draftNode, markerPrefix);
    summary.body = importedBodyStats(draftNode, payload);
    summary.bodyLost = summary.body.expected >= 4 && summary.body.actual * 2 < summary.body.expected;
    if (summary.bodyLost) console.warn(LOG, "article body is missing after import", summary.body);
    post("done", { summary });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== CHANNEL_TO_MAIN) return;
    if (event.data.kind === "ready?") {
      post("ready");
      return;
    }
    if (event.data.kind === "run") {
      runFlow(event.data.payload).catch((error) => {
        console.error(LOG, error);
        post("error", { error: error?.message || String(error), stack: error?.stack || null });
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
