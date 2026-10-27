# xPoster Usage Guide

[中文使用说明](usage.zh-CN.md)

This guide is written for someone who has never loaded a Chrome extension before.

## 1. Install xPoster

Recommended:

1. Open [xPoster on Chrome Web Store](https://chromewebstore.google.com/detail/xposter/iimkimodgdjnnmdopeolboakhjmhfbbj?authuser=0&hl=zh-CN).
2. Click **Add to Chrome**.
3. Use the store version for ongoing updates and improvements.

Developer install from source:

1. Download or clone xPoster.
2. Open Chrome.
3. Type `chrome://extensions` in the address bar.
4. Turn on **Developer mode** in the top right.
5. Click **Load unpacked**.
6. Pick the xPoster folder. It is the folder with `manifest.json`.

If Chrome lists xPoster after that, installation worked.

## 2. Prepare Your Markdown

Use any Markdown editor. A simple draft can look like this:

```markdown
---
title: My first X Article
---

# This heading becomes body text if the title above exists

Here is a paragraph with **bold text** and [a link](https://example.com).

- One point
- Another point

![image alt](image.png)
```

X shows the title on its own, so a first heading that repeats the frontmatter title (the same words, or the title with a translation added in brackets) is left out of the body. A different heading stays in the body.

The cover is the `cover:` value in the frontmatter. Without it, an image placed directly under the title becomes the cover and is not repeated in the body. Images further down stay where you put them.

The safest starting point is the included example file:

```text
fixtures/live-x-smoke.md
```

## 3. Open The X Article Editor

1. Sign in to X in Chrome.
2. Open `https://x.com/compose/articles`.
3. Create a new article draft or open the draft you want to fill.

xPoster needs an open X Article tab because it fills the editor that is already on the page.

## 4. Open xPoster

Open the xPoster side panel from the Chrome toolbar or side panel button.

## 5. Load Your Draft

Paste Markdown, click **Choose Markdown file** to select a `.md` file, or use **Example**. Preview is optional.

## 6. Click Publish

The main button stays labeled **Publish** once Markdown is loaded. One click checks the editor and media automatically, then fills the X draft.

If local images use relative paths and no readable folder is configured, a dialog opens on the X page. For `./images/photo.png`, choose the parent of `images`. The flow continues after selection; cancelling stops before writing.

Leading `../` or `../../` is ignored when resolving local images. For `../40_Assets/cover.png`, select the parent of `40_Assets`. The Markdown is unchanged and file access stays inside the selected folder.

Chrome asks for web image website access when needed. Downloads are checked automatically. Text-only drafts do not require a folder. Tables become images and still require X media uploads. Long cell text wraps onto more lines, so a wide table grows taller instead of squeezing its text.

## 7. Errors

Errors appear below the Publish button. Click **Copy error** to copy the error and diagnostics for support. If clipboard access fails, the text is selected for manual copying. Advanced checks and records remain in **Settings**.

The extension's **Publish** button fills an X draft. You still make it public using X's own Publish button.

## 8. Review In X

Before publishing, inspect the article in X:

- Title is correct.
- Text formatting looks right.
- Images are present.
- Tables are readable.
- Tweet embeds are correct.
- Code blocks and dividers look acceptable.
- No `__XPOSTER_` marker text remains.

xPoster never clicks Publish. You publish manually only after review.

## Troubleshooting

### Chrome says the extension is unpacked

That is normal when you install directly from source. Regular users should install from the Chrome Web Store.

### Check article says the editor is missing

Open or create an actual X Article draft. The Articles list page is not enough for import.

### Chrome asks for image website permission

Click allow if you trust the image host. xPoster needs the file bytes so it can upload the image into X.

### Local images do not import

Choose the folder that contains those image files. Relative paths like `./images/photo.png` only work after xPoster can read the matching local folder.

### The article text disappeared while images were uploading

Occasionally X swaps in an earlier version of the editor as an image finishes uploading, which drops the imported text. xPoster writes the title and text first, waits until X has saved them (it can only check that when the Markdown has a title), then uploads the images one at a time, and checks again after each one. If X still replaces the article, xPoster puts it back by itself. If Publish stops with "X replaced the article body", clear the draft in X, refresh the tab, and click **Publish** again. Use **Copy error** if it keeps happening: the copied report shows which upload triggered it.

### Images are not where the Markdown puts them

Each image is placed as soon as its upload succeeds, and at the end xPoster compares the finished article with the Markdown. If an image is still out of place, Publish stops with "Some images are not where the Markdown puts them" and names the image. Use **Copy error** and send the report: its `trace` lists what X did and when, which is what shows why the image moved.

### An image appears twice

When X finishes a slow upload late, or reloads an older copy of the article, it can add a second block for an image xPoster has already placed. xPoster waits for a slow upload instead of uploading it again, makes sure X has saved each image with its media ID before it goes on, and takes out any extra image block, so no copy should survive the import. If you still see one, delete it in X and use **Copy error** or copy the evidence package: its `trace` says whether xPoster found and removed extra image blocks, and when they appeared.

### Import partially worked

Do not publish yet. Use the saved record and diagnostics popup to understand which step failed, then retry from a clean X Article draft.
