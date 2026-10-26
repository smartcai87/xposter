(() => {
  const STYLE_TAGS = {
    Bold: "strong",
    Italic: "em",
    Strikethrough: "s",
    Code: "code"
  };

  const BLOCK_TAGS = {
    "header-one": "h1",
    "header-two": "h2",
    "header-three": "h3",
    "header-four": "h4",
    "header-five": "h5",
    "header-six": "h6",
    blockquote: "blockquote",
    unstyled: "p"
  };

  const LOCAL_DB = "xposter_local_assets";
  const LOCAL_STORE = "handles";
  const VAULT_KEY = "vault_root";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function looksLikeMarkdown(text) {
    if (!text || text.length < 3) return false;
    if (findMarkdownImageSpans(text).some((span) => isLikelyMarkdownImageSource(span.source))) return true;
    return [
      /^#{1,6}\s+\S/m,
      /^>\s+\S/m,
      /^[-*+]\s+\S/m,
      /^\d+\.\s+\S/m,
      /^\s*```/m,
      /^\s*(?:---|\*\*\*|___)\s*$/m,
      /\[[^\]]+\]\(https?:\/\/\S+\)/i,
      /^\s*\|.+\|\s*$\n^\s*\|[\s:|\-]+\|\s*$/m,
      /`[^`\n]+`/
    ].some((pattern) => pattern.test(text));
  }

  function parseFrontmatter(markdown) {
    const normalized = String(markdown ?? "").replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n*/);
    if (!match) return { body: normalized.trim(), meta: {} };
    const meta = {};
    for (const line of match[1].split("\n")) {
      const index = line.indexOf(":");
      if (index < 0) continue;
      const key = line.slice(0, index).trim();
      const value = line
        .slice(index + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) meta[key] = value;
    }
    return { body: normalized.slice(match[0].length).trim(), meta };
  }

  // The same heading give or take spacing, or a short form of it: a title that
  // adds a translation in brackets is still the heading above it.
  function repeatsTitle(heading, title) {
    const squash = (text) => String(text || "").replace(/[\s\u3000]+/g, "").toLowerCase();
    const a = squash(heading);
    const b = squash(title);
    if (!a || !b) return false;
    return a === b || (Math.min(a.length, b.length) >= 6 && (a.startsWith(b) || b.startsWith(a)));
  }

  function parseMarkdown(markdown) {
    const { body, meta } = parseFrontmatter(markdown);
    const titleFromMeta = meta.title || meta.Title || meta["标题"] || null;
    let cover = meta.cover || meta.Cover || meta["封面"] || null;
    if (cover) {
      cover = cover
        .replace(/^!\[\[|\]\]$/g, "")
        .replace(/^!\[[^\]]*\]\(([^)]+)\)$/u, "$1")
        .trim();
    }

    const spans = findSpecialBlocks(body);
    const segments = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) {
        segments.push(...parseTextBlocks(body.slice(cursor, span.start)));
      }
      segments.push(span.segment);
      cursor = span.end;
    }
    if (cursor < body.length) segments.push(...parseTextBlocks(body.slice(cursor)));

    let title = titleFromMeta;
    const firstHeading = segments.findIndex(
      (segment) => segment.type === "text" && segment.kind === "header-one"
    );
    if (!title) {
      if (firstHeading >= 0) {
        title = segments[firstHeading].text || null;
        segments.splice(firstHeading, 1);
      }
    } else if (
      firstHeading >= 0 &&
      segments.slice(0, firstHeading).every((segment) => segment.type === "image") &&
      repeatsTitle(segments[firstHeading].text, title)
    ) {
      // X shows the title on its own, so the same heading at the top of the body
      // would show it twice.
      segments.splice(firstHeading, 1);
    }

    // Without an explicit cover, an image placed right under the title is the
    // cover. An image further down is a body image and stays where it is.
    if (!cover) {
      const firstImage = segments.findIndex((segment) => segment.type === "image" && segment.source);
      const onlyTitleAbove = segments
        .slice(0, Math.max(firstImage, 0))
        .every((segment) => segment.type === "text" && segment.kind === "header-one");
      if (firstImage >= 0 && onlyTitleAbove) cover = segments[firstImage].source;
    }

    return {
      title,
      cover,
      segments,
      meta,
      titleFromMeta: Boolean(titleFromMeta)
    };
  }

  function findSpecialBlocks(markdown) {
    const spans = [];
    let match;

    const fencedCode = /```([^\n`]*)\n([\s\S]*?)```/g;
    while ((match = fencedCode.exec(markdown)) !== null) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        segment: {
          type: "code",
          language: (match[1] || "").trim(),
          code: (match[2] || "").replace(/\n$/, "")
        }
      });
    }

    const table = /^(?:[ \t]*\|.+\|[ \t]*\n)(?:[ \t]*\|[\s:|\-]+\|[ \t]*\n)((?:[ \t]*\|.+\|[ \t]*\n?)*)/gm;
    while ((match = table.exec(markdown)) !== null) {
      if (overlaps(spans, match.index)) continue;
      const parsed = parseTable(match[0]);
      if (!parsed) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "table", ...parsed }
      });
    }

    const divider = /^(?: {0,3})(?:-{3,}|\*{3,}|_{3,})(?:[ \t]*)$/gm;
    while ((match = divider.exec(markdown)) !== null) {
      if (overlaps(spans, match.index)) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "divider" }
      });
    }

    const statusUrl = /^(?: {0,3})https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/(\d+)(?:[?#][^\s]*)?\s*$/gm;
    while ((match = statusUrl.exec(markdown)) !== null) {
      if (overlaps(spans, match.index)) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "tweet", tweetId: match[1] }
      });
    }

    for (const image of findMarkdownImageSpans(markdown)) {
      if (overlaps(spans, image.start)) continue;
      const source = image.source;
      const tweet = source.match(
        /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/
      );
      spans.push({
        start: image.start,
        end: image.end,
        segment: tweet
          ? { type: "tweet", tweetId: tweet[1] }
          : { type: "image", source, alt: image.alt.trim() }
      });
    }

    const linkedTweet = /^[ \t]*\[([^\]]*)\]\(([^)]+)\)[ \t]*$/gm;
    while ((match = linkedTweet.exec(markdown)) !== null) {
      if (overlaps(spans, match.index)) continue;
      const tweet = match[2]
        .trim()
        .match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/(\d+)/);
      if (!tweet) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "tweet", tweetId: tweet[1] }
      });
    }

    const obsidianImage = /^[ \t]*!\[\[([^\]]+)\]\][ \t]*$/gm;
    while ((match = obsidianImage.exec(markdown)) !== null) {
      if (overlaps(spans, match.index)) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        segment: { type: "image", source: match[1].trim(), alt: "" }
      });
    }

    return spans.sort((left, right) => left.start - right.start);
  }

  function findMarkdownImageSpans(markdown) {
    const spans = [];
    let cursor = 0;
    while (cursor < markdown.length) {
      const start = markdown.indexOf("![", cursor);
      if (start < 0) break;
      const altEnd = findMarkdownClosingBracket(markdown, start + 2);
      if (altEnd < 0 || markdown[altEnd + 1] !== "(") {
        cursor = start + 2;
        continue;
      }
      const sourceStart = altEnd + 2;
      const sourceEnd = findMarkdownClosingParen(markdown, sourceStart);
      if (sourceEnd < 0) {
        cursor = altEnd + 1;
        continue;
      }
      spans.push({
        start,
        end: sourceEnd + 1,
        alt: markdown.slice(start + 2, altEnd),
        source: markdown.slice(sourceStart, sourceEnd).trim()
      });
      cursor = sourceEnd + 1;
    }
    return spans;
  }

  function findMarkdownClosingBracket(markdown, start) {
    for (let index = start; index < markdown.length; index += 1) {
      if (markdown[index] === "]" && !isEscaped(markdown, index)) return index;
    }
    return -1;
  }

  function findMarkdownClosingParen(markdown, start) {
    let depth = 0;
    for (let index = start; index < markdown.length; index += 1) {
      const char = markdown[index];
      if (isEscaped(markdown, index)) continue;
      if (char === "(") {
        depth += 1;
        continue;
      }
      if (char !== ")") continue;
      if (depth === 0) return index;
      depth -= 1;
    }
    return -1;
  }

  function isEscaped(text, index) {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) count += 1;
    return count % 2 === 1;
  }

  function isLikelyMarkdownImageSource(source) {
    const value = String(source || "").trim();
    return /^(?:https?:|data:|\.{0,2}\/)/i.test(value) || /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#]|$)/i.test(value);
  }

  function overlaps(spans, index) {
    return spans.some((span) => index >= span.start && index < span.end);
  }

  function parseTable(block) {
    const splitRow = (line) => {
      let cells = line.replace(/\\\|/g, "\0").split("|");
      if (cells[0]?.trim() === "") cells = cells.slice(1);
      if (cells[cells.length - 1]?.trim() === "") cells = cells.slice(0, -1);
      return cells.map((cell) => cell.replace(/\0/g, "|").trim());
    };

    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return null;

    const headers = splitRow(lines[0]);
    const alignmentRow = splitRow(lines[1]);
    if (!alignmentRow.every((cell) => /^:?-+:?$/.test(cell))) return null;

    const alignments = alignmentRow.map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      return right ? "right" : "left";
    });

    const rows = lines.slice(2).map((line) => {
      const cells = splitRow(line);
      while (cells.length < headers.length) cells.push("");
      return cells.slice(0, headers.length);
    });

    return { headers, alignments, rows };
  }

  function parseTextBlocks(text) {
    const lines = text.split("\n");
    const segments = [];
    let paragraph = [];

    const flush = () => {
      const value = paragraph.join("\n").trim();
      if (value) segments.push(parseInline("unstyled", value));
      paragraph = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      let match;
      if (!trimmed) {
        flush();
        continue;
      }
      if ((match = trimmed.match(/^(#{1,6})\s+(.+)$/))) {
        flush();
        const kind = [
          "",
          "header-one",
          "header-two",
          "header-three",
          "header-four",
          "header-five",
          "header-six"
        ][match[1].length];
        segments.push(parseInline(kind, match[2].trim()));
        continue;
      }
      if ((match = trimmed.match(/^>\s+(.+)$/))) {
        flush();
        segments.push(parseInline("blockquote", match[1].trim()));
        continue;
      }
      if ((match = trimmed.match(/^[-*+]\s+(.+)$/))) {
        flush();
        segments.push(parseInline("unordered-list-item", match[1].trim()));
        continue;
      }
      if ((match = trimmed.match(/^\d+\.\s+(.+)$/))) {
        flush();
        segments.push(parseInline("ordered-list-item", match[1].trim()));
        continue;
      }
      paragraph.push(trimmed);
    }

    flush();
    return segments;
  }

  function parseInline(kind, source) {
    const result = { type: "text", kind, text: "", inlineStyleRanges: [], links: [] };
    let cursor = 0;

    const appendStyled = (text, styles) => {
      const offset = result.text.length;
      result.text += text;
      for (const style of styles) {
        result.inlineStyleRanges.push({ offset, length: text.length, style });
      }
    };

    while (cursor < source.length) {
      const char = source[cursor];

      if (char === "[") {
        const link = source.slice(cursor).match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (link) {
          const offset = result.text.length;
          result.text += link[1];
          result.links.push({ offset, length: link[1].length, url: link[2] });
          cursor += link[0].length;
          continue;
        }
      }

      const inlineRules = [
        { marker: "***", styles: ["Bold", "Italic"] },
        { marker: "**", styles: ["Bold"] },
        { marker: "~~", styles: ["Strikethrough"] }
      ];
      let matched = false;
      for (const rule of inlineRules) {
        if (!source.startsWith(rule.marker, cursor)) continue;
        const end = source.indexOf(rule.marker, cursor + rule.marker.length);
        if (end <= cursor) continue;
        appendStyled(source.slice(cursor + rule.marker.length, end), rule.styles);
        cursor = end + rule.marker.length;
        matched = true;
        break;
      }
      if (matched) continue;

      if ((char === "*" || char === "_") && source[cursor + 1] !== char) {
        const end = source.indexOf(char, cursor + 1);
        if (end > cursor && source[end + 1] !== char) {
          appendStyled(source.slice(cursor + 1, end), ["Italic"]);
          cursor = end + 1;
          continue;
        }
      }

      if (char === "`") {
        const end = source.indexOf("`", cursor + 1);
        if (end > cursor) {
          appendStyled(source.slice(cursor + 1, end), ["Code"]);
          cursor = end + 1;
          continue;
        }
      }

      result.text += char;
      cursor += 1;
    }

    return result;
  }

  function segmentCounts(segments) {
    return segments.reduce(
      (counts, segment) => {
        counts[segment.type] = (counts[segment.type] || 0) + 1;
        return counts;
      },
      { text: 0, image: 0, table: 0, tweet: 0, code: 0, divider: 0 }
    );
  }

  function applyLimits(segments, limits) {
    if (!limits) return { segments, dropped: null };

    const output = [];
    const counters = { image: 0, table: 0, tweet: 0 };
    const dropped = { images: 0, tables: 0, tweets: 0 };

    for (const segment of segments) {
      if (segment.type === "image") {
        counters.image += 1;
        if (counters.image > limits.maxImagesPerImport) {
          dropped.images += 1;
          output.push(textSegment(`![${segment.alt || ""}](${segment.source})`));
          continue;
        }
      }
      if (segment.type === "table") {
        counters.table += 1;
        if (counters.table > limits.maxTablesPerImport) {
          dropped.tables += 1;
          output.push(textSegment(tableToMarkdown(segment)));
          continue;
        }
      }
      if (segment.type === "tweet") {
        counters.tweet += 1;
        if (counters.tweet > limits.maxTweetsPerImport) {
          dropped.tweets += 1;
          output.push(textSegment(`https://twitter.com/i/web/status/${segment.tweetId}`));
          continue;
        }
      }
      output.push(segment);
    }

    if (limits.appendSignature) {
      output.push(textSegment("Published with xPoster"));
    }

    const hasDropped = dropped.images || dropped.tables || dropped.tweets;
    return { segments: output, dropped: hasDropped ? dropped : null };
  }

  function textSegment(text) {
    return {
      type: "text",
      kind: "unstyled",
      text,
      inlineStyleRanges: [],
      links: []
    };
  }

  function tableToMarkdown(table) {
    const lines = [];
    lines.push(`| ${table.headers.join(" | ")} |`);
    lines.push(
      `| ${table.alignments
        .map((alignment) => (alignment === "center" ? ":---:" : alignment === "right" ? "---:" : ":---"))
        .join(" | ")} |`
    );
    for (const row of table.rows) lines.push(`| ${row.join(" | ")} |`);
    return lines.join("\n");
  }

  function buildPastePlan(segments, imageResults = new Map(), tableResults = new Map()) {
    const prefix = `__XPOSTER_${Math.random().toString(36).slice(2, 7)}_`;
    let index = 0;
    const html = [];
    const blocks = [];
    const plan = [];
    let listTag = null;
    let listItems = [];

    const marker = (type) => `${prefix}${type}_${index++}__`;
    const addBlock = (type, text, segment = null) => {
      blocks.push({
        type: type || "unstyled",
        text: String(text ?? "").replace(/\n+/g, " "),
        inlineStyleRanges: (segment?.inlineStyleRanges || []).map((range) => ({ ...range })),
        links: (segment?.links || []).map((link) => ({ ...link }))
      });
    };
    const flushList = () => {
      if (!listTag) return;
      html.push(`<${listTag}>${listItems.map((item) => `<li>${item}</li>`).join("")}</${listTag}>`);
      listTag = null;
      listItems = [];
    };

    for (const segment of segments) {
      if (segment.type === "text") {
        const rendered = renderInlineHtml(segment) || "<br>";
        addBlock(segment.kind, segment.text || "", segment);
        if (segment.kind === "unordered-list-item" || segment.kind === "ordered-list-item") {
          const nextTag = segment.kind === "unordered-list-item" ? "ul" : "ol";
          if (listTag && listTag !== nextTag) flushList();
          listTag = nextTag;
          listItems.push(rendered);
          continue;
        }
        flushList();
        const tag = BLOCK_TAGS[segment.kind] || "p";
        html.push(`<${tag}>${rendered}</${tag}>`);
        continue;
      }

      flushList();

      if (segment.type === "divider") {
        const id = marker("DIVIDER");
        html.push(`<p>${id}</p>`);
        addBlock("unstyled", id);
        plan.push({
          marker: id,
          op: { type: "atomic", entityType: "DIVIDER", data: {}, mutability: "IMMUTABLE" }
        });
        continue;
      }

      if (segment.type === "code") {
        const id = marker("CODE");
        const markdown = `\`\`\`${segment.language || ""}\n${segment.code || ""}\n\`\`\``;
        html.push(`<p>${id}</p>`);
        addBlock("unstyled", id);
        plan.push({
          marker: id,
          op: { type: "atomic", entityType: "MARKDOWN", data: { markdown }, mutability: "MUTABLE" }
        });
        continue;
      }

      if (segment.type === "tweet") {
        const id = marker("TWEET");
        const url = `https://twitter.com/i/web/status/${segment.tweetId}`;
        html.push(`<p>${id}</p>`);
        addBlock("unstyled", id);
        plan.push({
          marker: id,
          op: {
            type: "atomic",
            entityType: "TWEET",
            data: { url, tweetId: segment.tweetId },
            mutability: "IMMUTABLE"
          }
        });
        continue;
      }

      if (segment.type === "image") {
        const result = imageResults.get(segment);
        if (result?.ok) {
          const id = marker("IMAGE");
          html.push(`<p>${id}</p>`);
          addBlock("unstyled", id);
          plan.push({
            marker: id,
            op: {
              type: "image",
              file: {
                base64: result.base64,
                mime: result.mime,
                fileName: result.fileName,
                alt: segment.alt || ""
              },
              source: segment.source,
              fallbackText: `[image upload failed: ${segment.alt || result.fileName || "image"}]`
            }
          });
        } else {
          const fallback = `[image unavailable: ${segment.alt || guessFileName(segment.source, "image")}${result?.error ? ` - ${result.error}` : ""}]`;
          html.push(`<p>${escapeHtml(fallback)}</p>`);
          addBlock("unstyled", fallback);
        }
        continue;
      }

      if (segment.type === "table") {
        const result = tableResults.get(segment);
        if (result?.ok) {
          const id = marker("TABLE");
          html.push(`<p>${id}</p>`);
          addBlock("unstyled", id);
          plan.push({
            marker: id,
            op: {
              type: "image",
              file: {
                base64: result.base64,
                mime: result.mime,
                fileName: result.fileName,
                alt: "table"
              },
              fallbackText: tableToMarkdown(segment)
            }
          });
        } else {
          const fallback = tableToMarkdown(segment);
          html.push(`<pre><code>${escapeHtml(fallback)}</code></pre>`);
          addBlock("code-block", fallback);
        }
      }
    }

    flushList();
    return { html: html.join(""), plain: blocksToPlainText(blocks), blocks, plan, markerPrefix: prefix };
  }

  function renderInlineHtml(segment) {
    const text = segment.text || "";
    const openAt = new Array(text.length + 1).fill(null).map(() => []);
    const closeAt = new Array(text.length + 1).fill(null).map(() => []);

    for (const range of segment.inlineStyleRanges || []) {
      const tag = STYLE_TAGS[range.style];
      if (!tag) continue;
      openAt[range.offset]?.push(`<${tag}>`);
      closeAt[range.offset + range.length]?.unshift(`</${tag}>`);
    }

    for (const link of segment.links || []) {
      const href = escapeHtml(link.url);
      openAt[link.offset]?.push(`<a href="${href}">`);
      closeAt[link.offset + link.length]?.unshift("</a>");
    }

    let output = "";
    for (let i = 0; i < text.length; i += 1) {
      output += closeAt[i].join("");
      output += openAt[i].join("");
      output += escapeHtml(text[i]);
    }
    output += closeAt[text.length].join("");
    return output;
  }

  function blocksToPlainText(blocks) {
    return blocks
      .map((block) => String(block?.text || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function isLocalImageSource(source) {
    return Boolean(
      source &&
        typeof source === "string" &&
        !/^https?:\/\//i.test(source) &&
        !source.startsWith("data:")
    );
  }

  function isAbsoluteLocalImageSource(source) {
    return /^(?:file:\/\/\/?|[a-zA-Z]:[\\/]|\/)/.test(String(source || ""));
  }

  function guessFileName(source, fallback = "image") {
    if (typeof source !== "string") return `${fallback}.png`;
    if (source.startsWith("data:")) return `${fallback}.png`;
    try {
      const url = new URL(source, "https://xposter.local");
      const name = url.pathname.split("/").filter(Boolean).pop();
      return name && /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${fallback}.png`;
    } catch {
      const name = source.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop();
      return name && /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${fallback}.png`;
    }
  }

  function extensionMime(fileName, fallback = "image/png") {
    const ext = String(fileName || "").split(".").pop()?.toLowerCase();
    return (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        avif: "image/avif"
      }[ext] || fallback
    );
  }

  function parseDataUri(uri) {
    const match = String(uri || "").match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match) return { ok: false, error: "Invalid data URI" };
    const mime = (match[1] || "image/png").toLowerCase();
    if (match[2]) return { ok: true, mime, base64: match[3].replace(/\s+/g, "") };
    try {
      return { ok: true, mime, base64: btoa(unescape(encodeURIComponent(decodeURIComponent(match[3])))) };
    } catch {
      return { ok: false, error: "Could not decode data URI" };
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let output = "";
    const chunkSize = 32768;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      output += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return btoa(output);
  }

  function openLocalDb(version) {
    return new Promise((resolve, reject) => {
      // The X origin may already have a newer database from another xPoster
      // build. Omit the version to open it without requesting a downgrade.
      const request = version === undefined
        ? indexedDB.open(LOCAL_DB)
        : indexedDB.open(LOCAL_DB, version);
      let blocked = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LOCAL_STORE)) {
          request.result.createObjectStore(LOCAL_STORE);
        }
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Local image storage is blocked by another X tab. Close other X tabs, refresh this article, and choose the image folder again."));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => db.close();
        if (!db.objectStoreNames.contains(LOCAL_STORE)) {
          // Repair only the missing store; preserve all other stores and data.
          const nextVersion = db.version + 1;
          db.close();
          resolve(openLocalDb(nextVersion));
          return;
        }
        resolve(db);
      };
      request.onerror = () => {
        // Another tab may have upgraded between inspection and repair.
        if (version !== undefined && request.error?.name === "VersionError") {
          resolve(openLocalDb());
        } else reject(request.error);
      };
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withLocalStore(mode, operation) {
    const db = await openLocalDb();
    try {
      const transaction = db.transaction(LOCAL_STORE, mode);
      const complete = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("Local image storage transaction was aborted"));
      });
      const request = operation(transaction.objectStore(LOCAL_STORE));
      const [result] = await Promise.all([requestToPromise(request), complete]);
      return result;
    } finally {
      db.close();
    }
  }

  async function saveVaultHandle(handle) {
    await withLocalStore("readwrite", (store) =>
      store.put({ handle, name: handle.name, savedAt: Date.now() }, VAULT_KEY));
  }

  async function getVaultRecord() {
    return (await withLocalStore("readonly", (store) => store.get(VAULT_KEY))) || null;
  }

  async function clearVaultHandle() {
    await withLocalStore("readwrite", (store) => store.delete(VAULT_KEY));
  }

  async function ensureReadPermission(handle) {
    const options = { mode: "read" };
    if (typeof handle?.queryPermission === "function" && (await handle.queryPermission(options)) === "granted") {
      return "granted";
    }
    if (typeof handle?.requestPermission === "function") return handle.requestPermission(options);
    return "denied";
  }

  async function queryReadPermission(handle) {
    if (typeof handle?.queryPermission !== "function") return "denied";
    return handle.queryPermission({ mode: "read" });
  }

  async function resolveLocalImage(source) {
    if (!isLocalImageSource(source)) return { ok: false, error: "Not a local image source" };
    const record = await getVaultRecord();
    if (!record?.handle) return { ok: false, error: "No local image folder selected" };
    if ((await queryReadPermission(record.handle)) !== "granted") {
      return { ok: false, error: "Local image folder permission expired" };
    }

    if (isAbsoluteLocalImageSource(source)) {
      return { ok: false, error: "Absolute paths outside the selected folder are not supported", source };
    }

    let cleanPath = String(source)
      .replace(/\\/g, "/")
      .split(/[?#]/)[0]
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "");

    if (/^[a-zA-Z]:\//.test(cleanPath)) {
      return { ok: false, error: "Absolute paths outside the selected folder are not supported" };
    }

    const decodedParts = cleanPath.split("/").map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

    // Markdown may refer to assets relative to a drafts subfolder. The user
    // selects the shared asset root, so leading ../ segments are rebased to
    // that root, never followed into its parent directory. Keep source intact.
    const parts = decodedParts.filter((part) => part && part !== ".");
    while (parts[0] === "..") parts.shift();
    if (!parts.length) return { ok: false, error: "Local image path is empty", source };
    if (parts.includes("..")) return { ok: false, error: "Path escapes the selected folder", source };
    if (parts.some((part) => /[\\/\0]/.test(part))) {
      return { ok: false, error: "Invalid local image path segment", source };
    }

    try {
      let directory = record.handle;
      for (const part of parts.slice(0, -1)) {
        if (!part || part === ".") continue;
        if (part === "..") throw new Error("Cannot traverse above selected folder");
        directory = await directory.getDirectoryHandle(part, { create: false });
      }
      const file = await (await directory.getFileHandle(parts[parts.length - 1], { create: false })).getFile();
      const buffer = await file.arrayBuffer();
      return {
        ok: true,
        base64: arrayBufferToBase64(buffer),
        mime: file.type || extensionMime(file.name),
        fileName: file.name,
        bytes: buffer.byteLength,
        source
      };
    } catch (error) {
      return { ok: false, error: error?.message || "Local file not found", source };
    }
  }

  async function renderTableImage(table, fileName = `table-${Date.now()}.png`) {
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const paddingX = 24;
    const paddingY = 16;
    const rowHeight = 42;
    const minColumnWidth = 120;
    const maxColumnWidth = 260;
    const font = "14px ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

    const measurer = document.createElement("canvas").getContext("2d");
    measurer.font = font;
    const columnCount = table.headers.length;
    const widths = Array.from({ length: columnCount }, (_, index) => {
      const values = [table.headers[index], ...table.rows.map((row) => row[index] || "")];
      const measured = Math.max(...values.map((value) => measurer.measureText(String(value)).width + paddingX * 2));
      return Math.max(minColumnWidth, Math.min(maxColumnWidth, Math.ceil(measured)));
    });

    const width = widths.reduce((sum, value) => sum + value, 0);
    const height = rowHeight * (table.rows.length + 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fbfaf7";
    ctx.fillRect(0, 0, width, height);
    ctx.font = font;
    ctx.textBaseline = "middle";

    let x = 0;
    const drawCell = (text, column, row, isHeader) => {
      const cellWidth = widths[column];
      const y = row * rowHeight;
      ctx.fillStyle = isHeader ? "#eeece6" : row % 2 ? "#fbfaf7" : "#f6f3ec";
      ctx.fillRect(x, y, cellWidth, rowHeight);
      ctx.strokeStyle = "#d8d2c6";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, cellWidth, rowHeight);
      ctx.fillStyle = "#201f1b";
      ctx.font = isHeader
        ? "600 14px ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        : font;
      const alignment = table.alignments[column] || "left";
      let textX = x + paddingX;
      ctx.textAlign = "left";
      if (alignment === "center") {
        textX = x + cellWidth / 2;
        ctx.textAlign = "center";
      } else if (alignment === "right") {
        textX = x + cellWidth - paddingX;
        ctx.textAlign = "right";
      }
      ctx.fillText(String(text), textX, y + rowHeight / 2, cellWidth - paddingX * 2);
      x += cellWidth;
    };

    x = 0;
    table.headers.forEach((header, column) => drawCell(header, column, 0, true));
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      x = 0;
      table.rows[rowIndex].forEach((cell, column) => drawCell(cell, column, rowIndex + 1, false));
    }

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not render table"))), "image/png");
    });
    const buffer = await blob.arrayBuffer();
    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      mime: "image/png",
      fileName,
      bytes: buffer.byteLength
    };
  }

  const api = {
    looksLikeMarkdown,
    parseMarkdown,
    segmentCounts,
    applyLimits,
    buildPastePlan,
    escapeHtml,
    isLocalImageSource,
    isAbsoluteLocalImageSource,
    guessFileName,
    extensionMime,
    parseDataUri,
    arrayBufferToBase64,
    renderTableImage,
    saveVaultHandle,
    getVaultRecord,
    clearVaultHandle,
    ensureReadPermission,
    queryReadPermission,
    resolveLocalImage
  };

  if (typeof window !== "undefined") {
    window.xPosterShared = api;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
