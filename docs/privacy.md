# Privacy

[中文隐私说明](privacy.zh-CN.md)

xPoster is designed as a local browser extension.

## What It Reads

- Markdown text you paste or load in the side panel.
- The active X/Twitter tab URL and page state.
- While importing, the name, timing and paragraph count of the article and upload requests X's page makes (nothing else from them), to know when X has finished saving, and the article as X has saved it, requested from your own signed-in X session, to check it matches the editor.
- Local image files only after you choose a local folder.
- Remote image files only after Chrome grants host permission for that image website.

## What It Stores

- Draft text in Chrome extension local storage, so reopening the side panel can restore your draft.
- Local image folder handles, if you choose a folder.
- Import/check evidence records shown inside the side panel.

## What It Does Not Do

- It does not send analytics.
- It does not use a backend server.
- It does not require an xPoster account.
- It does not include license checks, subscriptions, or trial limits.
- It does not click X's Publish button.

## Permissions

- `storage`: save drafts and local settings in this browser.
- `sidePanel`: show the publishing console.
- `tabs`: find and check the active X Article tab.
- `https://x.com/*` and `https://twitter.com/*`: run the importer on X/Twitter pages.
- Optional host permissions in published builds: read image files from approved image hosts when your Markdown references web images.

## Contact

Contact the author on X: [@xiaoxiaodong01](https://x.com/xiaoxiaodong01).
