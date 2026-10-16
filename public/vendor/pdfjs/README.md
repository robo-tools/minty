# pdf.js 4.10.38 (Mozilla, Apache License 2.0: LICENSE)

Used only by Bills (docs/bills.md) to read the text of bill PDFs in the browser; loaded on demand,
never part of the service worker's shell. Stored here, not loaded from a CDN, so the pages'
Content-Security-Policy stays script-src 'self' (security plan step 4).

Files, byte-identical on cdnjs (ajax/libs/pdf.js/4.10.38/) and jsDelivr (npm pdfjs-dist@4.10.38/build/):

    pdf.min.mjs         sha256 27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c
    pdf.worker.min.mjs  sha256 1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36

Minty opens documents with isEvalSupported: false (text only, no font compiling).
