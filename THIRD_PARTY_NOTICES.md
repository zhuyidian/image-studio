# Third-party notices

## GPT Image Playground

The coordinate conversion, zoom-at-point and constrained view transform functions
in `src/lib/viewportTransform.ts` are adapted from:

- Project: https://github.com/CookSleep/gpt_image_playground
- Source: `src/lib/viewportTransform.ts`, inspected on 2026-11-09
- License: MIT

The source project's image workflow (text generation, reference reuse, mask
editing and history) was also used as a design reference. This project does not
copy its user credentials, storage architecture or API configuration UI.

MIT License

Copyright (c) 2026 CookSleep

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## New API

New API is a separately deployed upstream service; no New API source code is
included in this project. Its own AGPLv3 and attribution obligations continue
to apply to the deployed New API instance and any modifications to it.

## Other dependencies

Direct and transitive dependencies retain their own licenses in `node_modules`.
The lockfile records the installed versions. Node.js itself is separately
licensed. Review dependency licenses before distributing a packaged product.
