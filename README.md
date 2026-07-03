# Image Resizer

A React + Vite bulk image resizing and compression tool. Normal resize and compression runs entirely in the browser, so files are not uploaded to any server.

## Features

- Upload multiple JPG, PNG, or WebP images.
- Optionally remove image backgrounds in the browser with `@imgly/background-removal`.
- Resize every image by pixels, inches, centimeters, or millimeters.
- Convert physical units to pixels with a DPI/PPI setting.
- Compress toward a target file size, defaulting to 25 KB.
- After background removal, keep transparency or apply white, sky blue, or a custom color.
- Background removal uses a smaller temporary 1200px copy, times out after 60 seconds, and falls back to the original image if needed.
- Large files over 5 MB require confirmation before background removal.
- Process images after choosing settings, so the selected width, height, compression, and background are applied together.
- Preview original size, new size, processing status, and quality warnings.
- Download each image individually or all ready images as a ZIP.

## Setup

```bash
pnpm install
pnpm dev
```

Open the local URL shown in the terminal.

## Run on GitHub Pages

This project includes a GitHub Pages workflow in `.github/workflows/deploy.yml`.

1. Create a GitHub repository.
2. Push this project to the repository's `main` branch.
3. In GitHub, open **Settings > Pages**.
4. Set **Source** to **GitHub Actions**.
5. The site will publish after the workflow finishes.

## Usage

1. Choose one or more supported image files.
2. Choose a unit: pixels, inches, centimeters, or millimeters.
3. Enter width and height, or use a preset.
4. For physical units, set DPI/PPI. The app shows the final pixel output before processing.
5. Enter the target file size in KB.
6. Optional: check **Remove background**.
7. If background removal is enabled, choose transparent, white, sky blue, or a custom color.
8. Confirm large images if the warning appears.
9. Click **Process Images**.
10. Download individual resized files or use **Download All as ZIP**.

## Notes

- Resize, compression, background removal, and background filling are client-side.
- The background removal library may download model/runtime files in the browser, but uploaded images are not sent to a server.
- If background removal fails or times out, the app continues with the original image.
- Very small target sizes can cause strong quality loss. The app shows a warning when a file cannot comfortably reach the selected target.
- The app uses `@imgly/background-removal`, `browser-image-compression`, `jszip`, and `file-saver`.
