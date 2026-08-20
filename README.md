# LosslessPNG

<p align="center">
  <img src="build/icon.png" width="112" alt="LosslessPNG icon">
</p>

LosslessPNG is a compact dark-mode Windows application for compressing PNG images without changing their decoded pixels, colours, or transparency. The desktop application is displayed as **PNGoo Desktop** and uses [Oxipng](https://github.com/oxipng/oxipng) as its compression engine.

## Download

Download the latest verified build from the [v1.1.4 release page](https://github.com/Michael-D-White/LosslessPNG/releases/tag/v1.1.4):

- [Windows installer](https://github.com/Michael-D-White/LosslessPNG/releases/download/v1.1.4/PNGoo-Setup-1.1.4-x64.exe)
- [Portable ZIP](https://github.com/Michael-D-White/LosslessPNG/releases/download/v1.1.4/PNGoo-Portable-1.1.4-x64.zip)

The portable edition requires no installation. Extract the entire ZIP, then run `PNGoo Desktop.exe` from the extracted folder.

## Features

- Strict lossless PNG recompression with Oxipng 10.2.0
- Controlled parallel compression that automatically balances workers across the available CPU threads
- Multi-file Oxipng batches for very large collections of small textures
- A virtualized file table that remains responsive with hundreds of thousands of entries
- Fixed compression settings, so there is nothing technical to configure
- Add individual PNG files or scan a folder and its subfolders
- Drag and drop whole folders or PNG files anywhere onto the app
- Overwrite the original files or write compressed copies to another directory
- Never replaces a file when the result would be larger than the original
- Verifies ordinary jobs by SHA-256, size, and dimensions; huge batches use Oxipng validation plus atomic file identity, size, and dimensions to avoid millions of redundant file reads
- Restores the original automatically if replacement verification detects corruption
- Compact dark interface inspired by the original PNGoo layout

## How to use

1. Open LosslessPNG.
2. Drag a folder onto the app, or select **Add Files…** or **Add Folder…**. Dropped and selected folders are scanned recursively.
3. Choose **Output to Same Directory** to replace the originals, or select a separate output directory.
4. Press **Go!** and wait for the completion summary.

When a separate output directory is selected, the source images remain untouched. Their folder structure is reproduced beneath the chosen output directory.

## Backup and recovery behaviour

When overwriting an image, LosslessPNG temporarily moves the original to a rollback file. After the compressed replacement passes verification, that temporary rollback file is deleted.

If post-write verification detects corruption:

1. The original image is restored.
2. One recovery copy is retained beside it with a name similar to `image.PNGoo-Recovery-2026-08-17-12-30-00.png`.
3. The affected item is reported as **Recovered** instead of successful.

Ordinary compression or write failures do not leave unnecessary backup files. If the original was never replaced, it remains untouched.

## Does it affect image quality or colour?

No. LosslessPNG invokes Oxipng with transformations disabled. It does not request palette conversion, colour-type reduction, bit-depth reduction, alpha modification, interlace conversion, or metadata stripping.

The PNG's compressed byte structure and file size may change, but its decoded image pixels, colours, and transparency remain unchanged. The automated test suite compares decoded RGBA pixels before and after compression byte for byte.

## Build from source

Requirements:

- Windows x64
- Node.js and npm

```powershell
npm install
npm test
npm run build
```

The finished installer and portable ZIP are written to the `dist` directory. The repository includes the Windows Oxipng binary required by the application and its accompanying license.

To compare the sequential baseline with the balanced parallel plans on your own computer, run `npm run benchmark:compression`.

## Verification

Version 1.1.4 passed:

- Seven automated compression and recovery tests
- Portable application launch testing
- Installer installation, installed launch, and uninstallation testing
- Microsoft Defender scanning of both release packages

The SHA-256 hashes of the published files are included on the [release page](https://github.com/Michael-D-White/LosslessPNG/releases/tag/v1.1.4).

## License

LosslessPNG is released under the [MIT License](LICENSE). Oxipng is distributed under its own included [license](resources/bin/oxipng/LICENSE.txt).
